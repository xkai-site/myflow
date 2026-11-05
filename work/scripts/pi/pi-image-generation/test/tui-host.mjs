import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile, readdir } from 'node:fs/promises';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise,resolve}; };
const until = async (predicate) => {
 for(let i=0;i<2000;i++){if(predicate())return;await new Promise(setImmediate);}
 assert.fail('Expected offline UI event did not arrive');
};

export async function runTuiHostChecks({jiti,sdk,dir,config,token,bytes}) {
 const {default:extension}=await jiti.import('../extensions/index.ts');
 const {itemOptions,selectItem}=await jiti.import('../src/tui-options.ts');
 const {createResultView}=await jiti.import('../src/result-view.ts');
 const host=await import(sdk);
 const {ExtensionSelectorComponent,ExtensionEditorComponent,initTheme}=host;
 const themeModule=await import(new URL('./modes/interactive/theme/theme.js',sdk));
 const tui=await jiti.import('@earendil-works/pi-tui');
 const {getKeybindings,visibleWidth,stripTerminalSequences,getCapabilities,setCapabilities,CURSOR_MARKER}=tui;
 const keybindings=getKeybindings();
 const display={terminal:{columns:80,rows:30},requestRender(){}};
 const originalFetch=globalThis.fetch;
 const capabilities=getCapabilities();
 const oldTheme=themeModule.theme;
 const reference=path.join(dir,'参考图.png');
 await writeFile(reference,bytes);
 initTheme('dark',false);
 const dark=themeModule.theme;
 const light=themeModule.getThemeByName('light');
 assert.ok(light);

 async function harness({modelKey='openai-flare-26',edit=false,providers=['openai'],choose,editor,custom,auth}={}) {
  let handler,input;
  const entries=[],notices=[],questions=[],editors=[];
  await extension({registerEntryRenderer(){},registerCommand(_name,c){handler=c.handler},on(name,fn){if(name==='input')input=fn},appendEntry(type,data){entries.push({type,data})}});
  const ctx={mode:'tui',cwd:dir,isIdle:()=>true,modelRegistry:{
   getProvider(id){return id==='openai-codex'&&providers.includes('openai')?{baseUrl:'https://chatgpt.com/backend-api/codex'}:id==='qwen-token-plan-cn'&&providers.includes('qwen')?{baseUrl:'https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1'}:undefined},
   getProviderAuthStatus(){return {configured:true}},
   getProviderAuth:auth??(async()=>({auth:{apiKey:token}})),
  },ui:{theme:dark,
   notify(text,type){notices.push({text,type})},
   async select(title,options){
    questions.push({title,options});
    if(choose)return choose(title,options);
    if(title==='图片任务')return options[edit?1:0];
    if(title==='图片账户')return options.find(o=>o===config.providers.find(p=>p.id===config.models.find(m=>m.key===modelKey).provider).name);
    if(title==='图片模型'){
     const selected=config.models.find(m=>m.key===modelKey);
     const provider=config.providers.find(p=>p.id===selected.provider);
     return itemOptions(config.models.filter(m=>m.provider===provider.id&&m.enabled!==false),provider.defaultModel).find(o=>o.item.key===modelKey).label;
    }
    if(title.endsWith(' - 参数'))return options[0];
    return undefined;
   },
   async editor(title,prefill){editors.push({title,prefill});return editor?editor(title,prefill):title.startsWith('参考图')?reference:prefill||'离线测试图片'},
   custom:custom??(factory=>new Promise((resolve,reject)=>{
    let component;
    const done=value=>{component?.dispose?.();resolve(value)};
    try{component=factory(display,dark,keybindings,done)}catch(error){reject(error)}
   })),
  }};
  return {handler,input,ctx,entries,notices,questions,editors};
 }

 try {
  setCapabilities({images:null,trueColor:true,hyperlinks:true});
  // Use actual host components and keyboard handling, not a string-only mock.
  const models=config.models.filter(m=>m.provider==='openai');
  const options=itemOptions(models,config.providers.find(p=>p.id==='openai').defaultModel);
  for(const appearance of ['dark','light']) {
   initTheme(appearance,false);
   let selected,cancelled=0;
   const component=new ExtensionSelectorComponent('图片模型',options.map(o=>o.label),value=>{selected=value},()=>cancelled++);
   for(const width of [24,40,80,120]) {
    const lines=component.render(width);
    assert.ok(lines.every(line=>visibleWidth(line)<=width));
    const joined=lines.map(stripTerminalSequences).join('\n').replace(/\s/g,'');
    for(const option of options)assert.ok(joined.includes(option.label.replace(/\s/g,'')));
    assert.ok(lines.join('').includes(themeModule.theme.fg('accent','→ ')));
   }
   component.handleInput('\x1b[B');component.handleInput('\r');
   assert.equal(selected,options[1].label);
   component.handleInput('\x1b[A');component.handleInput('\r');
   assert.equal(selected,options[0].label);
   component.handleInput('\x1b');assert.equal(cancelled,1);
   component.dispose();
  }
  initTheme('dark',false);
  let submitted,cancelled=0;
  const editor=new ExtensionEditorComponent(display,keybindings,'图片提示词','中文 cat',value=>{submitted=value},()=>cancelled++);
  editor.focused=true;
  for(const width of [24,40,80,120]) {
   const lines=editor.render(width);
   assert.ok(lines.every(line=>visibleWidth(line)<=width));
   assert.ok(lines.some(line=>line.includes(CURSOR_MARKER)),'Focused editor preserves IME cursor marker');
  }
  editor.handleInput('\r');assert.equal(submitted,'中文 cat');
  editor.handleInput('\x1b');assert.equal(cancelled,1);
  editor.focused=false;assert.equal(editor.focused,false);

  // Real host selection through the plugin's label -> object mapping.
  for(let index=0;index<options.length;index++) {
   const selected=await selectItem({ui:{select:async(title,labels)=>new Promise(resolve=>{
    const component=new ExtensionSelectorComponent(title,labels,resolve,()=>resolve(undefined));
    for(let n=0;n<index;n++)component.handleInput('\x1b[B');
    component.handleInput('\r');component.dispose();
   })}},'图片模型',models,'openai-flare-26');
   assert.equal(selected.key,options[index].item.key);
  }

  // All real catalog models complete TUI generation and reference editing, offline.
  for(const model of config.models.filter(m=>m.enabled!==false))for(const edit of [false,true]) {
   const calls=[];
   globalThis.fetch=async(url,request)=>{
    calls.push({url:String(url),request});
    if(request.method==='POST') {
     const body=JSON.parse(request.body);
     assert.equal(body.model,model.id);
     if(model.provider==='openai') {
      assert.equal(body.complexity,model.complexity?.default);
      assert.equal(body.quality,model.quality.default);
      assert.equal(!!body.images,edit);
      if(edit)assert.equal(body.images.length,16);
      return Response.json({data:[{b64_json:bytes.toString('base64')}]});
     }
     return Response.json({output:{choices:[{message:{content:[{image:'https://cdn.example.test/offline.png'}]}}]}});
    }
    return new Response(bytes,{headers:{'content-type':'image/png'}});
   };
   const h=await harness({modelKey:model.key,edit,providers:[model.provider],
    editor:(title,prefill)=>title.startsWith('参考图')?Array(model.provider==='openai'?16:1).fill(reference).join('\n'):prefill});
   await h.handler('预填中文 prompt',h.ctx);
   assert.equal(h.entries.length,1,JSON.stringify(h.notices));
   assert.equal(h.entries[0].data.model,model.id);
   assert.equal(h.entries[0].data.prompt,'预填中文 prompt');
   assert.equal(h.questions[0].title,'图片任务');
   assert.equal(h.editors[0].prefill,'预填中文 prompt');
   assert.equal(h.questions.some(q=>q.title==='图片账户'),false);
   assert.equal(h.editors.some(q=>q.title.startsWith('参考图')),edit);
   assert.equal(calls.length,model.provider==='openai'?1:2);
   assert.equal(h.notices.at(-1).text,'已保存 1 张图片');
   const view=createResultView(h.entries[0].data,dark,model.name);
   for(const width of [24,40,80,120])assert.ok(view.render(width).every(line=>visibleWidth(line)<=width));
  }

  // Excess references fail in the real wizard before auth, loader or transport.
  globalThis.fetch=async()=>assert.fail('Invalid references sent a request');
  const excess=await harness({edit:true,auth:async()=>assert.fail('Invalid references resolved credentials'),
   editor:(title,prefill)=>title.startsWith('参考图')?Array(17).fill(reference).join('\n'):prefill,
   custom:()=>assert.fail('Invalid references opened the loader')});
  await excess.handler('offline edit',excess.ctx);
  assert.equal(excess.entries.length,0);
  assert.equal(excess.notices.at(-1).type,'error');
  assert.match(excess.notices.at(-1).text,/at most 16/);
  // Encoded-length validation also guards direct runtime entry before auth/fetch.
  const {generateAndSave}=await jiti.import('../src/runtime.ts');
  const {resolveImageCommand}=await jiti.import('../src/command.ts');
  const restricted=structuredClone(config);
  const restrictedModel=restricted.models.find(m=>m.key==='openai-flare-26');
  restrictedModel.inputImages.maxDataUrlLength=1;
  const restrictedCommand=resolveImageCommand({prompt:'offline',help:false},restrictedModel,1,restricted);
  await assert.rejects(generateAndSave(restricted,restrictedCommand,[{mimeType:'image/png',data:bytes.toString('base64')}],dir,
   async()=>assert.fail('Oversized data URL resolved credentials'),new AbortController().signal),/data URL.*character limit/);

  // Multi-account selection still maps to the selected provider; cancelling sends nothing.
  globalThis.fetch=async()=>assert.fail('A cancelled UI sent a request');
  const multi=await harness({providers:['openai','qwen'],choose:(title,labels)=>title==='图片任务'?labels[0]:title==='图片账户'?labels.find(l=>l===config.providers[1].name):undefined});
  await multi.handler('',multi.ctx);
  assert.equal(multi.questions.filter(q=>q.title==='图片账户').length,1);
  assert.ok(multi.questions.find(q=>q.title==='图片模型').options.every(o=>o.startsWith('Wan')));
  assert.equal(multi.entries.length,0);

  // Every blocking step supports Escape; no credentials or network calls are made.
  for(const cancelAt of ['task','prompt','model','references','parameters']) {
   const h=await harness({edit:true,auth:async()=>assert.fail('Cancel resolved credentials'),
    choose(title,labels){
     if(title==='图片任务')return cancelAt==='task'?undefined:labels[1];
     if(title==='图片模型')return cancelAt==='model'?undefined:labels[0];
     if(title.endsWith(' - 参数'))return undefined;
     assert.fail(title);
    },editor(title,prefill){
     if(title.startsWith('参考图'))return cancelAt==='references'?undefined:reference;
     return cancelAt==='prompt'?undefined:prefill||'edit';
    }});
   await h.handler('',h.ctx);
   assert.equal(h.entries.length,0);
   assert.equal(h.notices.at(-1).text,'已取消图片生成');
  }
  const empty=await harness({editor:()=>''});await empty.handler('',empty.ctx);
  assert.equal(empty.notices.at(-1).type,'error');assert.match(empty.notices.at(-1).text,/不能为空/);
  const noAccount=await harness({providers:[]});await noAccount.handler('',noAccount.ctx);
  assert.ok(noAccount.notices.some(n=>n.text.includes('尚未配置')));
  assert.ok(noAccount.questions.some(q=>q.title==='图片账户设置'));
  const settings=await harness();await settings.handler('--settings',settings.ctx);
  assert.equal(settings.questions[0].title,'图片账户设置');
  assert.equal(settings.editors.length,0);
  const notIdle=await harness();await notIdle.handler('',{...notIdle.ctx,isIdle:()=>false});
  assert.equal(notIdle.notices[0].type,'warning');assert.equal(notIdle.questions.length,0);

  // Abort closes the loader, keeps the busy lock until auth settles, and ignores late work.
  const authGate=deferred();let authStarted=false,loader,doneCount=0;
  const cancel=await harness({auth:async()=>{authStarted=true;return authGate.promise},custom:factory=>new Promise(resolve=>{
   loader=factory(display,dark,keybindings,value=>{doneCount++;loader.dispose();resolve(value)});
  })});
  const first=cancel.handler('',cancel.ctx);
  await until(()=>authStarted&&loader);
  for(const width of [24,40,80,120]) {
   const lines=loader.render(width);assert.ok(lines.every(line=>visibleWidth(line)<=width));
   assert.ok(lines.map(stripTerminalSequences).join('\n').replace(/\s/g,'').includes('正在生成：GPTImage2.6Flare'));
   loader.invalidate();assert.ok(loader.render(width).length>0);
  }
  const questionCount=cancel.questions.length;
  await cancel.handler('',cancel.ctx);
  assert.equal(cancel.notices.at(-1).type,'warning');
  assert.equal(cancel.questions.length,questionCount);
  loader.handleInput('\x1b');
  await until(()=>cancel.notices.some(n=>n.text==='已取消图片生成'));
  assert.equal(loader.signal.aborted,true);
  await cancel.handler('',cancel.ctx);assert.equal(cancel.notices.at(-1).type,'warning');
  authGate.resolve({auth:{apiKey:token}});await first;
  assert.equal(cancel.entries.length,0);assert.equal(doneCount,1);
  await cancel.handler('--help',cancel.ctx);assert.equal(cancel.notices.at(-1).type,'info');

  // Abort after fetch starts; even an abort-ignoring fetch cannot publish/save a late result.
  const responseGate=deferred();let sent=false,fetchSignal;
  globalThis.fetch=async(_url,request)=>{sent=true;fetchSignal=request.signal;return responseGate.promise};
  const late=await harness({custom:factory=>new Promise(resolve=>{
   loader=factory(display,dark,keybindings,value=>{doneCount++;loader.dispose();resolve(value)});
  })});
  doneCount=0;const lateRequest=late.handler('',late.ctx);await until(()=>sent);
  loader.handleInput('\x1b');await until(()=>late.notices.length>0);
  assert.equal(fetchSignal.aborted,true);
  await late.handler('',late.ctx);assert.equal(late.notices.at(-1).type,'warning');
  const filesBefore=(await readdir(path.join(dir,'.pi','generated-images'))).sort();
  responseGate.resolve(Response.json({data:[{b64_json:bytes.toString('base64')}]}));await lateRequest;
  assert.equal(late.entries.length,0);assert.equal(doneCount,1);
  assert.deepEqual((await readdir(path.join(dir,'.pi','generated-images'))).sort(),filesBefore);

  // Errors are shown once, without credentials/prompt leaks or automatic retries.
  let failedCalls=0;
  globalThis.fetch=async()=>{failedCalls++;throw new Error('offline failure')};
  const failure=await harness();await failure.handler('PRIVATE_TUI_PROMPT',failure.ctx);
  assert.equal(failedCalls,1);assert.equal(failure.entries.length,0);
  assert.equal(failure.notices.at(-1).type,'error');
  assert.doesNotMatch(failure.notices.at(-1).text,/PRIVATE_TUI_PROMPT|signature/);
  await failure.handler('--help',failure.ctx);assert.equal(failure.notices.at(-1).type,'info');

  // RPC keeps its non-interactive syntax and ignores attachments on command dispatch.
  const rpcCalls=[];
  globalThis.fetch=async(_url,request)=>{rpcCalls.push(JSON.parse(request.body));return Response.json({data:[{b64_json:bytes.toString('base64')}]})};
  const rpc=await harness({custom:()=>assert.fail('RPC opened custom UI')});
  await rpc.handler('openai-flare-26 --complexity=low --quality=max cat',{...rpc.ctx,mode:'rpc'});
  assert.equal(rpcCalls[0].complexity,'low');assert.equal(rpcCalls[0].quality,'max');
  assert.equal(rpc.questions.length,0);assert.match(rpc.notices.at(-1).text,/^Saved 1 image\(s\):/);
  assert.doesNotMatch(rpc.notices.at(-1).text,/\x1b/);
  await rpc.handler('cat',{...rpc.ctx,mode:'rpc'});assert.equal(rpcCalls[1].model,'gpt-image-2.6-flare');
  const count=rpcCalls.length;await rpc.handler('',{...rpc.ctx,mode:'rpc'});assert.equal(rpcCalls.length,count);
  await rpc.handler('--settings',{...rpc.ctx,mode:'rpc'});assert.match(rpc.notices.at(-1).text,/TUI/);
  assert.deepEqual(await rpc.input({text:'not an image command'},rpc.ctx),{action:'continue'});

  // Re-render all result text with semantic tokens after a live theme change.
  const entry=rpc.entries[0].data;
  const mutable={fg:(color,text)=>dark.fg(color,text),underline:text=>dark.underline(text)};
  const view=createResultView(entry,mutable,'GPT Image 2.6 Flare');
  assert.ok(view.render(120).join('\n').includes(dark.fg('success','图片已生成')));
  mutable.fg=(color,text)=>light.fg(color,text);view.invalidate();
  const changed=view.render(120).join('\n');assert.ok(changed.includes(light.fg('success','图片已生成')));
  assert.equal(changed.split('\n').map(line=>stripTerminalSequences(line).trimEnd()).join('').split(entry.path).length-1,1);
  assert.match(changed,/当前终端不支持图片预览/);
  console.log('TUI host checks passed: native keyboard/focus, CJK wrapping at 24/40/80/120 columns, dark/light themes, all models generate/edit, account routing, wizard cancellation, busy/abort/late-result guards, RPC syntax and result refresh.');
 } finally {
  globalThis.fetch=originalFetch;
  setCapabilities(capabilities);
  themeModule.setThemeInstance(oldTheme);
 }
}
