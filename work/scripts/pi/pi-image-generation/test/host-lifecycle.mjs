import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const sdk = process.argv[2] ?? pathToFileURL(require.resolve('@earendil-works/pi-coding-agent')).href;
const hostRequire = createRequire(sdk);
const { createJiti } = hostRequire('jiti');
const jiti = createJiti(import.meta.url, { moduleCache:false, fsCache:false, alias: {
 '@earendil-works/pi-coding-agent':fileURLToPath(sdk),
 '@earendil-works/pi-ai':fileURLToPath(new URL('../node_modules/@earendil-works/pi-ai/dist/index.js',sdk)),
 '@earendil-works/pi-tui':fileURLToPath(new URL('../node_modules/@earendil-works/pi-tui/dist/index.js',sdk)),
}});
const dir=await mkdtemp(path.join(tmpdir(),'image-host-'));
process.env.PI_CODING_AGENT_DIR=dir;
const originalFetch=globalThis.fetch;
globalThis.fetch=async()=>{throw new Error('Unexpected network request');};
try {
 const {readImageConfig}=await jiti.import('../src/model-config.ts');
 const {resolveImageCommand}=await jiti.import('../src/command.ts');
 const {generateAndSave,createRuntimeImagesModels}=await jiti.import('../src/runtime.ts');
 const config=await readImageConfig();
 // Exercise the actual enabled catalog; do not force model flags to make tests pass.
 const enabledModels=config.models.filter(model=>model.enabled!==false);
 const bytes=Buffer.from([137,80,78,71,13,10,26,10]);
 const generatedEntries=[];
 const token=`header.${Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'test-account'}})).toString('base64url')}.signature`;
 for(const selected of enabledModels){
  const provider=config.providers.find(p=>p.id===selected.provider);
  const baseUrl=provider.adapter==='openai-codex-images'?'https://chatgpt.com/backend-api/codex':'https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1';
  const runtime=createRuntimeImagesModels(config,provider,baseUrl);
  assert.equal(runtime.getModel(provider.id,selected.id).id,selected.id);
  for(const edit of [false,true]){
   const images=edit?[{type:'image',mimeType:'image/png',data:bytes.toString('base64')}]:[];
   const command=resolveImageCommand({prompt:'test',help:false},selected,images.length,config);
   const calls=[];
   const mockFetch=async(url,options)=>{
    calls.push(String(url));assert.equal(options.redirect,'error');
    if(options.method==='POST'){
     assert.equal(JSON.parse(options.body).model,selected.id);
     if(provider.adapter==='openai-codex-images')return Response.json({data:[{b64_json:bytes.toString('base64')}]});
     return Response.json({output:{choices:[{message:{content:[{image:'https://cdn.example.test/result.png'}]}}]}});
    }
    assert.equal(options.headers,undefined);
    return new Response(bytes,{headers:{'content-type':'image/png'}});
   };
   const result=await generateAndSave(config,command,images,dir,async()=>({apiKey:token,baseUrl}),new AbortController().signal,mockFetch);
   assert.equal(result.entries.length,1);assert.deepEqual(await readFile(result.entries[0].path),bytes);
   generatedEntries.push(...result.entries);
   assert.equal(calls.length,provider.adapter==='openai-codex-images'?1:2);
  }
 }
 // Generic disabled behavior uses a synthetic fixture, never a real model's availability.
 const disabledConfig=structuredClone(config);
 const openaiProvider=disabledConfig.providers.find(p=>p.id==='openai');
 const disabled={...structuredClone(disabledConfig.models.find(m=>m.provider===openaiProvider.id)),key:'disabled-test-model',id:'disabled-test-id',name:'Disabled test model',enabled:false};
 disabledConfig.models.push(disabled);
 const defaultRuntime=createRuntimeImagesModels(disabledConfig,openaiProvider,'https://chatgpt.com/backend-api/codex');
 assert.equal(defaultRuntime.getModel(disabled.provider,disabled.id),undefined);
 const disabledCommand={prompt:'synthetic',help:false,modelKey:disabled.key,provider:disabled.provider,model:disabled.id,modelConfig:disabled,providerConfig:openaiProvider,size:'auto'};
 await assert.rejects(generateAndSave(disabledConfig,disabledCommand,[],dir,async()=>assert.fail('Disabled model resolved auth'),new AbortController().signal,async()=>assert.fail('Disabled model fetched')),/disabled/);
 // Success timings are logged without changing transport; failures survive SDK flattening.
 assert.ok((await readdir(path.join(dir,'.pi','image-generation-logs'))).some(name=>name.startsWith('success-')));
 for(const provider of config.providers){
  const selected=config.models.find(model=>model.provider===provider.id);
  const command=resolveImageCommand({prompt:'PRIVATE_DIAGNOSTIC_PROMPT',help:false},selected,0,config);
  const baseUrl=provider.adapter==='openai-codex-images'?'https://chatgpt.com/backend-api/codex':'https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1';
  let calls=0;
  await assert.rejects(generateAndSave(config,command,[],dir,async()=>({apiKey:token,baseUrl}),new AbortController().signal,async()=>{
   calls++;throw new TypeError('fetch failed',{cause:Object.assign(new Error('connect timed out'),{code:'UND_ERR_CONNECT_TIMEOUT'})});
  }),(error)=>{
   assert.match(error.message,/UND_ERR_CONNECT_TIMEOUT/);
   assert.match(error.message,/诊断日志（当前项目）：/);
   assert.doesNotMatch(error.message,/PRIVATE_DIAGNOSTIC_PROMPT|signature/);
   assert.ok(error.message.length<800);
   return true;
  });
  assert.equal(calls,1);
 }
 const diagnosticFiles=(await readdir(path.join(dir,'.pi','image-generation-logs'))).filter(name=>name.startsWith('error-'));
 assert.equal(diagnosticFiles.length,config.providers.length);
 for(const filename of diagnosticFiles){
  const text=await readFile(path.join(dir,'.pi','image-generation-logs',filename),'utf8');
  assert.match(text,/UND_ERR_CONNECT_TIMEOUT/);assert.doesNotMatch(text,/PRIVATE_DIAGNOSTIC_PROMPT|signature/);
 }
 const {default:extension,publishOutcome}=await jiti.import('../extensions/index.ts');
 let handler;const notices=[];const entries=[];const renderers=new Map();
 const pi={registerEntryRenderer(type,renderer){renderers.set(type,renderer);},registerCommand(_name,command){handler=command.handler;},on(){},appendEntry(type,data){entries.push({type,data});}};
 await extension(pi);
 const ctx={mode:'rpc',isIdle:()=>true,ui:{notify:(text)=>notices.push(text)}};
 await handler('--help',ctx);assert.match(notices.at(-1),/model-key/);
 await handler('--settings',ctx);assert.match(notices.at(-1),/TUI/);
 // Both real 2.5 models appear in the TUI and can advance to size selection.
 // Cancel there so no credentials or paid request are needed for this UI check.
 const registry={
  getProvider:id=>id==='openai-codex'?{baseUrl:'https://chatgpt.com/backend-api/codex'}:undefined,
  getProviderAuthStatus:()=>({configured:true}),
  getProviderAuth:async()=>assert.fail('Cancelled command resolved credentials'),
 };
 for(const key of ['openai-sunburst','openai-flare']){
  const questions=[];
  await handler('synthetic',{...ctx,mode:'tui',cwd:dir,modelRegistry:registry,ui:{...ctx.ui,
   editor:async()=> 'synthetic',
   select:async(title,options)=>{
    questions.push({title,options});
    if(title==='Image task')return options[0];
    if(title==='Image model')return options.find(option=>option.endsWith(`(${key})`));
    return undefined;
   },
   custom:async()=>assert.fail('Cancelled before generation'),
  }});
  const modelQuestion=questions.find(q=>q.title==='Image model');
  assert.ok(modelQuestion);
  for(const model of enabledModels.filter(m=>m.provider==='openai')){
   assert.ok(modelQuestion.options.some(option=>option.endsWith(`(${model.key})`)));
  }
  assert.ok(questions.some(q=>q.title==='Image size'),`${key} must be selectable`);
 }
 // RPC notification retains concrete causes and an existing log path, without auto-retrying.
 const failureCwd=path.join(dir,'rpc-failure');let failedCalls=0;
 globalThis.fetch=async()=>{failedCalls++;throw new TypeError('fetch failed',{cause:Object.assign(new Error('DNS lookup failed'),{code:'ENOTFOUND',syscall:'getaddrinfo'})});};
 await handler('openai PRIVATE_RPC_PROMPT',{...ctx,cwd:failureCwd,modelRegistry:{
  getProvider:id=>id==='openai-codex'?{baseUrl:'https://chatgpt.com/backend-api/codex'}:undefined,
  getProviderAuthStatus:()=>({configured:true}),
  getProviderAuth:async()=>({auth:{apiKey:token}}),
 }});
 assert.equal(failedCalls,1);
 const failureNotice=notices.at(-1);
 assert.match(failureNotice,/ENOTFOUND/);assert.match(failureNotice,/DNS/);
 assert.doesNotMatch(failureNotice,/PRIVATE_RPC_PROMPT|signature|\x1b/);
 assert.ok(failureNotice.length<800);
 const logReference=failureNotice.match(/诊断日志（当前项目）：([^\n]+)$/)[1];
 const failureLog=JSON.parse(await readFile(path.join(failureCwd,logReference),'utf8'));
 assert.equal(failureLog.causes[1].code,'ENOTFOUND');
 assert.equal(failureLog.model,'gpt-image-2');
 assert.equal((await readdir(path.join(failureCwd,'.pi','image-generation-logs'))).length,1);
 globalThis.fetch=async()=>{throw new Error('Unexpected network request');};
 // Instantiate a fresh extension like /reload; it must register a fresh handler.
 const previous=handler;await extension(pi);assert.notEqual(handler,previous);
 // Publish a batch without opening a browser or invoking an agent turn.
 await publishOutcome(pi,{...ctx,cwd:dir},{entries:generatedEntries,texts:[]});
 const expectedImageCount=enabledModels.length*2;
 assert.equal(generatedEntries.length,expectedImageCount);
 assert.equal(entries.length,expectedImageCount);
 assert.ok(entries[0].data.galleryPath);
 assert.ok(entries.slice(1).every(entry=>entry.data.galleryPath===undefined));
 const galleryUrl=pathToFileURL(entries[0].data.galleryPath).href;
 assert.ok(notices.at(-1).includes(galleryUrl));assert.ok(notices.at(-1).includes(`Saved ${expectedImageCount} image`));
 assert.ok(!notices.at(-1).includes('\x1b')); // RPC stays plain text.
 const html=await readFile(entries[0].data.galleryPath,'utf8');
 assert.equal((html.match(/<figure>/g)??[]).length,expectedImageCount);
 assert.ok(generatedEntries.every(entry=>entry.galleryPath===undefined));
 // Reloaded renderer retains a copyable link from persisted metadata; old entries still render.
 await extension(pi);
 const theme={fg:(color,text)=>color==='mdLink'?`\x1b[94m${text}\x1b[39m`:text,underline:(text)=>`\x1b[4m${text}\x1b[24m`};
 const renderer=renderers.get('pi-image-generation');
 assert.ok(renderer({data:entries[0].data},{},theme).render(1000).join('\n').includes(galleryUrl));
 assert.doesNotThrow(()=>renderer({data:generatedEntries[0]},{},theme).render(1000));
 // Gallery failure must not turn a successfully saved image into a generation error.
 const noticeCount=notices.length;
 await publishOutcome(pi,{...ctx,cwd:generatedEntries[0].path},{entries:[generatedEntries[0]],texts:[]});
 assert.equal(entries.length,expectedImageCount+1);assert.equal(entries.at(-1).data.galleryPath,undefined);
 assert.match(notices[noticeCount],/Saved 1 image/);
 assert.match(notices.at(-1),/Images saved, but browser preview unavailable/);
 assert.deepEqual(await readFile(generatedEntries[0].path),bytes);
 // Real OSC 8 targets and styling, not merely a string containing a file URL.
 const {formatGalleryLink}=await jiti.import('../src/preview-link.ts');
 const {getCapabilities,setCapabilities,Text,visibleWidth,stripTerminalSequences,getOsc8LinkAtColumn}=await jiti.import('@earendil-works/pi-tui');
 const originalCapabilities=getCapabilities();
 try {
  setCapabilities({images:null,trueColor:true,hyperlinks:true});
  const specialPath=path.join(dir,'.pi','generated-images','图集 space # % "\x1b.html');
  const specialUrl=pathToFileURL(specialPath).href;
  const formatted=formatGalleryLink(specialPath,theme);
  assert.ok(formatted.startsWith(`\x1b]8;;${specialUrl}\x1b\\`));
  assert.ok(formatted.includes('\x1b[94m'));assert.ok(formatted.includes('\x1b[4m'));
  assert.equal(stripTerminalSequences(formatted),specialUrl);
  assert.equal(getOsc8LinkAtColumn(formatted,0),specialUrl);
  assert.equal(getOsc8LinkAtColumn(formatted+' AFTER',specialUrl.length),undefined);
  assert.equal(formatGalleryLink(specialPath),specialUrl);
  for(const width of [24,60]){
   const lines=new Text(formatted,0,0).render(width);
   assert.ok(lines.length>1);
   assert.equal(lines.map(line=>stripTerminalSequences(line).trimEnd()).join(''),specialUrl);
   for(const line of lines){
    const length=stripTerminalSequences(line).trimEnd().length;
    assert.ok(visibleWidth(line)<=width);
    for(let col=0;col<length;col++)assert.equal(getOsc8LinkAtColumn(line,col),specialUrl);
    assert.equal(getOsc8LinkAtColumn(line+' AFTER',width),undefined);
   }
  }
  const component=renderer({data:entries[0].data},{},theme);
  const linkLine=component.render(1000).find(line=>stripTerminalSequences(line).startsWith('file:///'));
  assert.equal(getOsc8LinkAtColumn(linkLine,0),galleryUrl);
  assert.ok(linkLine.includes('\x1b[94m'));
  // A theme refresh must recompute styles rather than reuse pre-styled cached text.
  const changedTheme={...theme};
  const themedComponent=renderer({data:entries[0].data},{},changedTheme);
  themedComponent.render(1000);
  changedTheme.fg=(color,text)=>color==='mdLink'?`\x1b[96m${text}\x1b[39m`:text;
  themedComponent.invalidate();
  assert.ok(themedComponent.render(1000).join('\n').includes('\x1b[96m'));
  // Single and batch results display exactly one gallery link across the TUI
  // entries + notification, including when hyperlinks are unsupported.
  for(const hyperlinks of [true,false]){
   setCapabilities({images:null,trueColor:true,hyperlinks});
   for(const batch of [[generatedEntries[0]],generatedEntries]){
    const start=entries.length;const noticeStart=notices.length;
    await publishOutcome(pi,{...ctx,mode:'tui',cwd:dir,ui:{...ctx.ui,theme}},{entries:batch,texts:[]});
    const published=entries.slice(start);
    assert.equal(published.length,batch.length);
    assert.equal(notices.length,noticeStart+1);
    assert.equal(notices.at(-1),`Saved ${batch.length} image(s):\n${batch.map(entry=>entry.path).join('\n')}`);
    assert.equal(published.filter(entry=>entry.data.galleryPath).length,1);
    const tuiUrl=pathToFileURL(published[0].data.galleryPath).href;
    const rendered=published.flatMap(entry=>renderer({data:entry.data},{},theme).render(1000));
    const visible=[...rendered,notices.at(-1)].map(stripTerminalSequences).join('\n');
    assert.equal(visible.split(tuiUrl).length-1,1);
    assert.equal(visible.split('Browser preview').length-1,1);
    const previewLine=rendered.find(line=>stripTerminalSequences(line).startsWith(tuiUrl));
    assert.equal(getOsc8LinkAtColumn(previewLine,0),hyperlinks?tuiUrl:undefined);
    assert.ok(previewLine.includes('\x1b[94m'));
    assert.ok(!JSON.stringify(published).includes('\\u001b'));
   }
  }
  setCapabilities({images:null,trueColor:true,hyperlinks:false});
  const fallback=formatGalleryLink(specialPath,theme);
  assert.ok(!fallback.includes('\x1b]8;'));assert.equal(stripTerminalSequences(fallback),specialUrl);
  component.invalidate();
  const fallbackLine=component.render(1000).find(line=>stripTerminalSequences(line).startsWith('file:///'));
  assert.equal(getOsc8LinkAtColumn(fallbackLine,0),undefined);
  assert.equal(stripTerminalSequences(fallbackLine).trimEnd(),galleryUrl);
 } finally {setCapabilities(originalCapabilities);}
 console.log('Host-backed offline checks passed: mocked generation/edit, safe transport diagnostics/logs through SDK and RPC, gallery publication/reload/failure, styled OSC 8 targets, wrapping, theme refresh, single/batch TUI link deduplication and RPC/unsupported-terminal fallback.');
}finally{globalThis.fetch=originalFetch;await rm(dir,{recursive:true,force:true});}
