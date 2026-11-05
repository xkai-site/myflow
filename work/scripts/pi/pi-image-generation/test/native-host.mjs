import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** All opt-ins are in memory; never edit the production catalog or send a real request. */
export async function runNativeHostChecks({t,harness,jiti,sdk,dir,token,config,themeModule}) {
 const {generateAndSave,createRuntimeImagesModels}=await jiti.import('../src/runtime.ts');
 const {parseImageCommand,resolveImageCommand}=await jiti.import('../src/command.ts');
 const {selectParameters}=await jiti.import('../src/tui-options.ts');
 const {createResultView}=await jiti.import('../src/result-view.ts');
 const {ExtensionSelectorComponent,ExtensionInputComponent,initTheme}=await import(sdk);
 const {getCapabilities,setCapabilities,visibleWidth,stripTerminalSequences}=await jiti.import('@earendil-works/pi-tui');
 const bytes=await readFile(new URL('./fixtures/native-two-frame.gif',import.meta.url));
 const fixture={data:bytes.toString('base64'),mimeType:'image/gif'};
 const capabilities=getCapabilities();
 const baseUrl='https://chatgpt.com/backend-api/codex';
 const c=structuredClone(config);
 const model=c.models.find(m=>m.key==='openai-flare-26');model.nativeCapabilities.gif.enabled=true;
 const command=resolveImageCommand(parseImageCommand(`/image ${model.key} --format gif --frame-count 2 --size 512x512 native motion`,c),model,0,c);
 const files=async()=>(await readdir(path.join(dir,'.pi','generated-images'))).sort();
 const originalFetch=globalThis.fetch;
 try {
  await t.test('native advanced gates reject RPC/runtime fields before credentials or HTTP; default TUI hides GIF',async()=>{
   let authCalls=0,fetchCalls=0;
   const h=await harness({auth:async()=>{authCalls++;return {auth:{apiKey:token}}}});
   globalThis.fetch=async()=>{fetchCalls++;return Response.json({data:[{b64_json:fixture.data}]})};
   for(const text of ['--format gif x','--format svg x','--frame-count 2 x','--markup layer.png x','--stream x','--partial-images 2 x']) {
    await h.handler(`openai-flare-26 ${text}`,{...h.ctx,mode:'rpc'});
    assert.equal(h.notices.at(-1).type,'error');assert.equal(h.entries.length,0);
   }
   const before=await files();
   for(const extra of [{stream:true},{partialImages:2},{markup:fixture},{outputFormat:'svg'}, {modelConfig:config.models.find(m=>m.key===model.key)}]) {
    await assert.rejects(generateAndSave(c,{...command,...extra},[],dir,async()=>{authCalls++;return {apiKey:token,baseUrl}},new AbortController().signal,async()=>{fetchCalls++;return Response.json({data:[{b64_json:fixture.data}]})}),/not enabled|disabled/);
   }
   // Real default catalog still has only static format controls.
   const ui=await harness({choose:(title,labels)=>{
    if(title==='图片任务')return labels[0];
    if(title==='图片模型')return labels.find(l=>l.startsWith(model.name));
    if(title.endsWith(' - 参数')) {assert.ok(!labels.some(l=>/动画帧数|每帧时长|Markup|流式/.test(l)));return labels.find(l=>l.startsWith('输出格式'));}
    if(title==='输出格式')assert.ok(!labels.some(l=>/GIF|SVG/.test(l)));
    return undefined;
   }});
   // Cancel on the next parameter menu, rather than submitting a request.
   const select=ui.ctx.ui.select;let seen=false;
   ui.ctx.ui.select=async(title,labels)=>{if(title.endsWith(' - 参数')&&seen)return undefined;if(title==='输出格式')seen=true;return select(title,labels)};
   await ui.handler('offline',ui.ctx);assert.equal(seen,true);assert.equal(ui.entries.length,0);
   assert.deepEqual(await files(),before);
   assert.equal(authCalls,0);assert.equal(fetchCalls,0);
  });

  await t.test('experimental GIF traverses runtime as a file, saves original bytes and reloads history without terminal playback',async()=>{
   let calls=0;
   const outcome=await generateAndSave(c,command,[],dir,async()=>({apiKey:token,baseUrl}),new AbortController().signal,async(url,init)=>{
    calls++;assert.equal(String(url),`${baseUrl}/images/generations`);
    const body=JSON.parse(init.body);assert.equal(body.frame_count,2);assert.equal(body.frame_duration_ms,200);assert.equal(body.n,1);
    return Response.json({output_format:'gif',data:[{b64_json:fixture.data}]});
   });
   assert.equal(calls,1);assert.equal(outcome.entries.length,1);
   const entry=outcome.entries[0];assert.equal(entry.kind,'animation');assert.equal(entry.mimeType,'image/gif');
   assert.equal(path.extname(entry.path),'.gif');assert.deepEqual(await readFile(entry.path),bytes);
   for(const appearance of ['dark','light'])for(const images of [null,'kitty','iterm2']) {
    initTheme(appearance,false);setCapabilities({images,trueColor:true,hyperlinks:true});
    // Missing new field in a historical entry still uses the MIME and real file, not a fake PNG preview.
    for(const kind of ['animation',undefined]) {
     const data=JSON.parse(JSON.stringify({...entry,kind}));const view=createResultView(data,themeModule.theme,model.name);
     for(const width of [24,40,80,120]) {
      const lines=view.render(width);assert.ok(lines.every(line=>visibleWidth(line)<=width));
      const plain=lines.map(l=>stripTerminalSequences(l).trimEnd()).join('');
      assert.ok(plain.includes(pathToFileURL(entry.path).href));assert.match(plain,/终端不播放动画/);
      assert.doesNotMatch(lines.join(''),/\x1b_G|\x1b\]1337;File=/);assert.doesNotMatch(plain,/[·•]/);
      view.invalidate();
     }
    }
   }
   const h=await harness();const {publishOutcome}=await jiti.import('../extensions/index.ts');
   await publishOutcome({appendEntry:(type,data)=>h.entries.push({type,data})},{...h.ctx,mode:'rpc'},outcome);
   assert.equal(h.entries.length,1);assert.match(h.notices.at(-1).text,/Saved 1 image/);assert.ok(h.notices.at(-1).text.includes(pathToFileURL(entry.path).href));
   // Even opted-in GIF must not be serialized as a Pi SDK static ImageContent.
   const provider=c.providers.find(p=>p.id==='openai');const models=createRuntimeImagesModels(c,provider,baseUrl);
   const sdkResult=await models.generateImages(models.getModelOfType('image','openai',model.id),{input:[{type:'text',text:'offline'}]},
    {apiKey:token,metadata:{size:'auto',outputFormat:'gif'},fetch:async()=>assert.fail('SDK tried static GIF generation')});
   assert.equal(sdkResult.stopReason,'error');assert.match(sdkResult.errorMessage,/file-only/);
  });

  await t.test('native GIF selectors and number inputs use host keyboard, Escape and both themes at every width',async()=>{
   for(const appearance of ['dark','light'])for(const width of [24,40,80,120]) {
    initTheme(appearance,false);let step=0,inputs=0;
    const result=await selectParameters({ui:{select:async(title,labels)=>new Promise(resolve=>{
     const component=new ExtensionSelectorComponent(title,labels,resolve,()=>resolve(undefined));component.focused=true;
     assert.ok(component.render(width).every(l=>visibleWidth(l)<=width));
     const targets=['输出格式','GIF','动画帧数','每帧时长','开始生成'];const target=targets[step++];
     const index=labels.findIndex(l=>l.startsWith(target));assert.ok(index>=0,`${title}: ${target}`);
     for(let i=0;i<index;i++)component.handleInput('\x1b[B');component.handleInput('\r');component.dispose();
    }),input:async(title,placeholder)=>new Promise(resolve=>{
     const component=new ExtensionInputComponent(title,placeholder,resolve,()=>resolve(undefined));component.focused=true;
     assert.ok(component.render(width).every(l=>visibleWidth(l)<=width));
     // Cancel the duration dialog; preserve default 200ms. Set frame count through real input.
     if(inputs++===0){component.handleInput('2');component.handleInput('\r')}else component.handleInput('\x1b');
     component.dispose();
    })}},model,'generate');
    assert.equal(result.outputFormat,'gif');assert.equal(result.frameCount,2);assert.equal(result.frameDurationMs,200);assert.equal(inputs,2);
   }
  });

  await t.test('native GIF abort-aware and late responses never save/publish; invalid size/edit fail before auth',async()=>{
   let authCalls=0;
   for(const extra of [{size:'1024x1024'},{frameCount:17}]) await assert.rejects(generateAndSave(c,{...command,...extra},[],dir,async()=>{authCalls++;return {apiKey:token,baseUrl}},new AbortController().signal),/Size|frameCount/);
   assert.equal(authCalls,0);
   await assert.rejects(generateAndSave(c,command,[{type:'image',data:fixture.data,mimeType:fixture.mimeType}],dir,async()=>assert.fail('GIF edit resolved auth'),new AbortController().signal),/editing/);
   for(const late of [false,true]) {
    const before=await files();const abort=new AbortController();let release,entered;
    const started=new Promise(r=>{entered=r});let calls=0;
    const pending=generateAndSave(c,command,[],dir,async()=>({apiKey:token,baseUrl}),abort.signal,async(_url,init)=>{
     calls++;entered();return new Promise((resolve,reject)=>{
      release=()=>resolve(Response.json({data:[{b64_json:fixture.data}]}));
      if(!late)init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true});
     });
    });
    const rejected=assert.rejects(pending,/cancelled|aborted/i);
    await started;abort.abort();if(late)release();await rejected;
    assert.equal(calls,1);assert.deepEqual(await files(),before);
   }
  });
 } finally {globalThis.fetch=originalFetch;setCapabilities(capabilities);initTheme('dark',false)}
}
