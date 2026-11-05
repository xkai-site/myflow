import assert from 'node:assert/strict';
import { cp, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { advancedFixtures, svgXml, svgImage } from './advanced-fixtures.mjs';

const until=async predicate=>{
 const end=performance.now()+3000;
 while(performance.now()<end){if(predicate())return;await new Promise(r=>setTimeout(r,5))}
 assert.fail('Expected advanced offline event did not arrive');
};

export async function runAdvancedHostChecks({t,harness,jiti,sdk,dir,token,config,themeModule,display,dark,keybindings}) {
 const {generateAndSave,createRuntimeImagesModels}=await jiti.import('../src/runtime.ts');
 const {parseImageCommand,resolveImageCommand}=await jiti.import('../src/command.ts');
 const {selectParameters,parameterItems}=await jiti.import('../src/tui-options.ts');
 const {createResultView}=await jiti.import('../src/result-view.ts');
 const {ExtensionSelectorComponent,ExtensionInputComponent,initTheme}=await import(sdk);
 const {getCapabilities,setCapabilities,visibleWidth,stripTerminalSequences}=await jiti.import('@earendil-works/pi-tui');
 const capabilities=getCapabilities(),originalFetch=globalThis.fetch;
 const f=await advancedFixtures(),original=f.image(f.original),overlay=f.image(f.overlay);
 const baseUrl='https://chatgpt.com/backend-api/codex';
 const c=structuredClone(config);
 for(const m of c.models){if(m.nativeCapabilities?.markup)m.nativeCapabilities.markup.enabled=true;if(m.nativeCapabilities?.svg)m.nativeCapabilities.svg.enabled=true;}
 const model=c.models.find(m=>m.key==='openai-flare-26');
 const output=path.join(dir,'.pi','generated-images');
 const files=async()=>(await readdir(output)).sort();
 const sourcePath=path.join(dir,'原图 first.png'),overlayPath=path.join(dir,'透明标记.png'),opaquePath=path.join(dir,'opaque.png');
 await writeFile(sourcePath,f.original);await writeFile(overlayPath,f.overlay);await writeFile(opaquePath,f.opaque);
 // A throwaway module copy permits genuine extension/TUI/RPC opt-in testing.
 // Never edit the production models.jsonc, even temporarily.
 const fixtureRoot=path.join(dir,'advanced-module');await mkdir(fixtureRoot);
 for(const folder of ['src','extensions'])await cp(new URL(`../${folder}`,import.meta.url),path.join(fixtureRoot,folder),{recursive:true});
 await writeFile(path.join(fixtureRoot,'package.json'),'{"type":"module"}');
 await writeFile(path.join(fixtureRoot,'models.jsonc'),JSON.stringify(c));
 await symlink(fileURLToPath(new URL('../node_modules',import.meta.url)),path.join(fixtureRoot,'node_modules'),'junction');
 const {default:extensionFactory}=await jiti.import(path.join(fixtureRoot,'extensions','index.ts'));
 const command=(extra={},count=0)=>resolveImageCommand({prompt:'offline advanced',help:false,...extra},model,count,c);
 const auth=async()=>({apiKey:token,baseUrl});
 try {
  await t.test('advanced runtime and default RPC gates assert zero auth/HTTP calls for invalid markup and disabled SVG',async()=>{
   let authCalls=0,fetchCalls=0;
   const resolveAuth=async()=>{authCalls++;return auth()};
   const fetch=async()=>{fetchCalls++;return Response.json({data:[{b64_json:original.data}]})};
   const before=await files();
   const valid=command({markup:overlay},1);
   for(const extra of [{markup:f.image(f.opaque)},{markupPath:opaquePath,markup:undefined},{markup:{...overlay,mimeType:'image/jpeg'}},{mask:{}},{prompt_rewriter:false}]) {
    await assert.rejects(generateAndSave(c,{...valid,...extra},[{type:'image',...original}],dir,resolveAuth,new AbortController().signal,fetch),/transparent|MIME|not enabled/);
   }
   const off=config.models.find(m=>m.key===model.key);
   for(const extra of [{outputFormat:'svg'},{markup:overlay}])await assert.rejects(generateAndSave(config,{...valid,...extra,modelConfig:off},[{type:'image',...original}],dir,resolveAuth,new AbortController().signal,fetch),/disabled|not enabled/);
   const h=await harness({auth:async()=>{authCalls++;return {auth:{apiKey:token}}}});
   globalThis.fetch=fetch;
   for(const text of [`${model.key} --image '${sourcePath}' --markup '${overlayPath}' x`,`${model.key} --format svg x`]) {
    await h.handler(text,{...h.ctx,mode:'rpc'});assert.equal(h.notices.at(-1).type,'error');assert.match(h.notices.at(-1).text,/disabled|not enabled/);
   }
   assert.equal(authCalls,0);assert.equal(fetchCalls,0);assert.equal(h.entries.length,0);assert.deepEqual(await files(),before);
  });

  await t.test('Markup runtime and real RPC edit keep separate data URLs, reference order, atomic history and notification contract',async()=>{
   for(const key of ['openai-flare','openai-sunburst','openai-flare-26','openai-sunburst-26']) {
    const selected=c.models.find(m=>m.key===key);let calls=0;
    const cmd=resolveImageCommand({prompt:'offline marked vase',help:false,markup:overlay},selected,2,c);
    const result=await generateAndSave(c,cmd,[{type:'image',...original},{type:'image',...f.image(f.opaque)}],dir,auth,new AbortController().signal,async(url,init)=>{
     calls++;assert.ok(String(url).endsWith('/images/edits'));const body=JSON.parse(init.body);
     assert.equal(body.model,selected.id);assert.equal(body.images.length,2);assert.equal(body.n,1);
     assert.ok(body.markup.image_url.startsWith('data:image/png;base64,'));assert.notEqual(body.images[0].image_url,body.markup.image_url);
     return Response.json({data:[{b64_json:original.data}]});
    });
    assert.equal(calls,1);assert.equal(result.entries.length,1);assert.equal(result.entries[0].kind,undefined);assert.deepEqual(await readFile(result.entries[0].path),f.original);
   }
   let calls=0;globalThis.fetch=async(url,init)=>{calls++;const body=JSON.parse(init.body);assert.ok(String(url).endsWith('/edits'));assert.equal(body.images.length,1);assert.ok(body.markup);return Response.json({data:[{b64_json:original.data}]})};
   const h=await harness({extensionFactory});
   await h.handler(`${model.key} --image '${sourcePath}' --markup '${overlayPath}' change vase`,{...h.ctx,mode:'rpc'});
   assert.equal(calls,1);assert.equal(h.entries.length,1,JSON.stringify(h.notices));assert.match(h.notices.at(-1).text,/Saved 1 image/);
   assert.ok(h.notices.at(-1).text.includes(pathToFileURL(h.entries[0].data.path).href));assert.equal(h.entries[0].data.prompt,'change vase');
   const broken=await harness({extensionFactory,auth:async()=>{assert.fail('Opaque markup must not resolve auth')}});
   // Error matching distinguishes validation failure from an assertion swallowed by the handler.
   await broken.handler(`${model.key} --image '${sourcePath}' --markup '${opaquePath}' x`,{...broken.ctx,mode:'rpc'});
   assert.equal(calls,1);assert.equal(broken.entries.length,0);assert.match(broken.notices.at(-1).text,/actual transparent pixels/);
  });

  await t.test('Markup real TUI offers one optional PNG path only for editing and uses the existing loader',async()=>{
   let menus=0,calls=0,inputs=0;
   const h=await harness({extensionFactory,edit:true,editor:(title,prefill)=>title.startsWith('参考图')?sourcePath:prefill,
    choose:(title,labels)=>{
     if(title==='图片任务')return labels[1];
     if(title==='图片模型')return labels.find(l=>l.startsWith(model.name));
     if(title.endsWith(' - 参数'))return ++menus===1?labels.find(l=>l.startsWith('标记 PNG')):labels[0];
     return undefined;
    }});
   h.ctx.ui.input=async()=>{inputs++;return overlayPath};
   globalThis.fetch=async(url,init)=>{calls++;assert.ok(String(url).endsWith('/edits'));assert.ok(JSON.parse(init.body).markup);return Response.json({data:[{b64_json:original.data}]})};
   await h.handler('修改标记区域',h.ctx);assert.equal(inputs,1);assert.equal(calls,1);assert.equal(h.entries.length,1,JSON.stringify(h.notices));assert.equal(h.notices.at(-1).text,'已保存 1 张图片');
  });

  await t.test('SVG reaches runtime and real TUI/RPC as original XML files, rejects SDK raster output and safely reloads history',async()=>{
   let calls=0;
   globalThis.fetch=async(url,init)=>{calls++;const body=JSON.parse(init.body);assert.ok(String(url).endsWith('/generations'));assert.equal(body.output_format,'svg');assert.equal(body.n,1);assert.ok(!('svg' in body));return Response.json({output_format:'svg',data:[{b64_json:svgImage.data}]})};
   const result=await generateAndSave(c,command({outputFormat:'svg'}),[],dir,auth,new AbortController().signal,globalThis.fetch);
   let menus=0;
   const h=await harness({extensionFactory,choose:(title,labels)=>{
    if(title==='图片任务')return labels[0];if(title==='图片模型')return labels.find(l=>l.startsWith(model.name));
    if(title.endsWith(' - 参数'))return ++menus===1?labels.find(l=>l.startsWith('输出格式')):labels[0];
    if(title==='输出格式')return labels.find(l=>l.startsWith('SVG'));return undefined;
   }});
   await h.handler('一枚矢量图标',h.ctx);assert.equal(h.entries.length,1,JSON.stringify(h.notices));
   const rpc=await harness({extensionFactory});await rpc.handler(`${model.key} --format svg native vector`,{...rpc.ctx,mode:'rpc'});
   assert.equal(rpc.entries.length,1,JSON.stringify(rpc.notices));assert.match(rpc.notices.at(-1).text,/Saved 1 image/);assert.equal(calls,3);
   for(const entry of [...result.entries,h.entries[0].data,rpc.entries[0].data]) {
    assert.equal(entry.kind,'vector');assert.equal(entry.mimeType,'image/svg+xml');assert.equal(path.extname(entry.path),'.svg');assert.equal(await readFile(entry.path,'utf8'),svgXml);
    for(const appearance of ['dark','light'])for(const images of [null,'kitty','iterm2']) {
     initTheme(appearance,false);setCapabilities({images,trueColor:true,hyperlinks:true});
     for(const kind of ['vector',undefined]) {
      const historical=JSON.parse(JSON.stringify({...entry,kind}));const view=createResultView(historical,themeModule.theme,model.name);
      for(const width of [24,40,80,120]) {
       const lines=view.render(width);assert.ok(lines.every(l=>visibleWidth(l)<=width));
       const text=lines.map(stripTerminalSequences).join('');assert.match(text,/终端不渲染/);assert.ok(text.includes(pathToFileURL(entry.path).href));
       assert.doesNotMatch(lines.join(''),/\x1b_G|\x1b\]1337;File=/);assert.doesNotMatch(text,/[·•]/);view.invalidate();
      }
     }
    }
   }
   const provider=c.providers.find(p=>p.id==='openai'),models=createRuntimeImagesModels(c,provider,baseUrl);
   const response=await models.generateImages(models.getModelOfType('image','openai',model.id),{input:[{type:'text',text:'offline'}]},{apiKey:token,metadata:{size:'auto',outputFormat:'svg'},fetch:globalThis.fetch});
   assert.equal(response.stopReason,'error');assert.match(response.errorMessage,/file-only/);assert.equal(calls,3);
  });

  await t.test('advanced native selectors and optional markup path input preserve Escape, both themes and narrow widths',async()=>{
   for(const appearance of ['dark','light'])for(const width of [24,40,80,120])for(const task of ['generate','edit']) {
    initTheme(appearance,false);let step=0;
    const result=await selectParameters({ui:{select:async(title,labels)=>new Promise(resolve=>{
     const component=new ExtensionSelectorComponent(title,labels,resolve,()=>resolve(undefined));component.focused=true;
     assert.ok(component.render(width).every(l=>visibleWidth(l)<=width));assert.doesNotMatch(component.render(width).map(stripTerminalSequences).join(''),/[·•]/);
     const targets=task==='generate'?['输出格式','SVG','开始生成']:['标记 PNG','开始编辑'];const target=targets[step++];
     const index=labels.findIndex(l=>l.startsWith(target));assert.ok(index>=0);for(let i=0;i<index;i++)component.handleInput('\x1b[B');component.handleInput('\r');component.dispose();
    }),input:async(title,placeholder)=>new Promise(resolve=>{
     const component=new ExtensionInputComponent(title,placeholder,resolve,()=>resolve(undefined));component.focused=true;
     assert.ok(component.render(width).every(l=>visibleWidth(l)<=width));component.handleInput('\x1b');component.dispose();
    })}},model,task);
    assert.equal(result.outputFormat,task==='generate'?'svg':'png');assert.equal(result.markupPath,undefined);
    if(task==='generate')assert.ok(!parameterItems(model,task,result).some(x=>x.key==='markupPath'));
   }
  });

  await t.test('invalid SVG responses publish nothing, and markup cancellation during local preparation never reaches auth',async()=>{
   const before=await files();let authCalls=0,calls=0;
   globalThis.fetch=async()=>{calls++;return Response.json({data:[{b64_json:Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="evil()"/>').toString('base64')}]})};
   const h=await harness({extensionFactory,auth:async()=>{authCalls++;return {auth:{apiKey:token}}}});
   await h.handler(`${model.key} --format svg x`,{...h.ctx,mode:'rpc'});
   assert.equal(h.entries.length,0);assert.match(h.notices.at(-1).text,/SVG/);assert.equal(calls,1);assert.equal(authCalls,1);assert.deepEqual(await files(),before);
   const abort=new AbortController();
   const pending=generateAndSave(c,command({markup:overlay},1),[{type:'image',...original}],dir,async()=>{authCalls++;return auth()},abort.signal,globalThis.fetch);
   const rejected=assert.rejects(pending,{name:'AbortError'});abort.abort();await rejected;
   assert.equal(authCalls,1);assert.equal(calls,1);assert.deepEqual(await files(),before);
  });

  await t.test('SVG and Markup cancelled late HTTP retain the same busy/reload lock and never save or publish',async()=>{
   for(const capability of ['svg','markup']) {
    initTheme('dark',false);let loader,sent=false,release,menus=0,settled=false,calls=0;
    globalThis.fetch=async()=>{calls++;sent=true;return new Promise(resolve=>{release=()=>resolve(Response.json({data:[{b64_json:capability==='svg'?svgImage.data:original.data}]}))})};
    const h=await harness({extensionFactory,editor:(title,prefill)=>title.startsWith('参考图')?sourcePath:prefill,
     choose:(title,labels)=>{
      if(title==='图片任务')return labels[capability==='markup'?1:0];if(title==='图片模型')return labels.find(l=>l.startsWith(model.name));
      if(title.endsWith(' - 参数'))return ++menus===1?labels.find(l=>l.startsWith(capability==='svg'?'输出格式':'标记 PNG')):labels[0];
      if(title==='输出格式')return labels.find(l=>l.startsWith('SVG'));return undefined;
     },custom:factory=>new Promise(resolve=>{loader=factory(display,dark,keybindings,value=>{loader.dispose();resolve(value)})})});
    h.ctx.ui.input=async()=>overlayPath;
    const before=await files();const pending=h.handler('offline cancelled advanced',h.ctx).then(()=>{settled=true});
    try {
     await until(()=>sent&&loader);loader.handleInput('\x1b');await until(()=>h.notices.some(n=>n.text.startsWith('已取消图片生成')));
     assert.equal(settled,false);const reloaded=await harness({extensionFactory});
     await reloaded.handler('--help',{...reloaded.ctx,mode:'rpc'});assert.equal(reloaded.notices.at(-1).type,'warning');assert.match(reloaded.notices.at(-1).text,/reload.*不会解除/);
    } finally {release?.();await pending;}
    assert.equal(calls,1);assert.equal(h.entries.length,0);assert.deepEqual(await files(),before);
    const recovered=await harness({extensionFactory});await recovered.handler('--help',{...recovered.ctx,mode:'rpc'});assert.equal(recovered.notices.at(-1).type,'info');
   }
  });

  await t.test('independent mock SSE adapter previews only in memory and only completed output can be saved/published',async()=>{
   const {readImageSse}=await jiti.import('../src/image-sse.ts');const {saveGeneratedImages}=await jiti.import('../src/image-files.ts');
   const {publishOutcome}=await jiti.import('../extensions/index.ts');const before=await files();let previews=0;
   const frame=type=>`event: ${type}\r\ndata: ${JSON.stringify({type,b64_json:type.endsWith('partial_image')?overlay.data:original.data,...(type.endsWith('partial_image')?{partial_image_index:0}:{})})}\r\n\r\n`;
   const result=await readImageSse(new Response(frame('image_generation.partial_image')+frame('image_generation.completed'),{headers:{'content-type':'text/event-stream'}}),{task:'generate',outputFormat:'png',partialImages:3,onPartial:async()=>{previews++;assert.deepEqual(await files(),before)}});
   assert.equal(previews,1);const saved=await saveGeneratedImages(dir,'openai',model.id,result.images);assert.equal(saved.length,1);assert.deepEqual(await readFile(saved[0].path),f.original);
   const h=await harness();await publishOutcome({appendEntry:(type,data)=>h.entries.push({type,data})},{...h.ctx,mode:'rpc'},{entries:saved.map(s=>({...s,model:model.id,provider:'openai',prompt:'offline',createdAt:0})),texts:[]});
   assert.equal(h.entries.length,1);assert.match(h.notices.at(-1).text,/Saved 1 image/);
   const after=await files();await assert.rejects(readImageSse(new Response(frame('image_generation.partial_image'),{headers:{'content-type':'text/event-stream'}}),{task:'generate',outputFormat:'png',partialImages:1}),/without a completed/);assert.deepEqual(await files(),after);
  });
 } finally {globalThis.fetch=originalFetch;setCapabilities(capabilities);initTheme('dark',false)}
}
