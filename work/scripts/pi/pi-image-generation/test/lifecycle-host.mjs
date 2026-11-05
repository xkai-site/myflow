import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { getEventListeners } from 'node:events';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const deferred = () => {
 let resolve,reject;
 const promise=new Promise((r,j)=>{resolve=r;reject=j});
 return {promise,resolve,reject};
};
const until = async predicate => {
 // A fixed number of setImmediate turns can expire in a few ms on Windows,
 // before mocked HTTP diagnostic file writes finish. Bound wall time, not CPU speed.
 const deadline=performance.now()+3000;
 while(performance.now()<deadline){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5))}
 assert.fail('Expected offline lifecycle event did not arrive');
};
const bounded = async promise => {
 let timer;
 try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Cancelled task did not settle')),3000)})])}
 finally{clearTimeout(timer)}
};

export async function runLifecycleHostChecks({t,harness,jiti,sdk,dir,token,bytes,display,dark,keybindings}) {
 const {generateAndSave}=await jiti.import('../src/runtime.ts');
 const {resolveImageCommand}=await jiti.import('../src/command.ts');
 const {readTestConfig,getModel}=await jiti.import('./config-helpers.ts');
 const config=await readTestConfig();
 const command=resolveImageCommand({prompt:'offline',help:false},getModel(config,'openai-flare-26'),0,config);
 const files=async()=>(await readdir(path.join(dir,'.pi','generated-images'))).sort();
 const successFetch=async(_url,request)=>request.method==='POST'
  ?JSON.parse(request.body).model.startsWith('wan')
   ?Response.json({output:{choices:[{message:{content:[{image:'https://cdn.example.test/offline.png'}]}}]}})
   :Response.json({data:[{b64_json:bytes.toString('base64')}]})
  :new Response(bytes,{headers:{'content-type':'image/png'}});
 async function cancellable({cancelImmediately=false,...options}={}) {
  let loader,doneCount=0;
  const h=await harness({...options,custom:factory=>new Promise(resolve=>{
   loader=factory(display,dark,keybindings,value=>{doneCount++;loader.dispose();resolve(value)});
   if(cancelImmediately)loader.handleInput('\x1b');
  })});
  return {...h,get loader(){return loader},get doneCount(){return doneCount}};
 }
 async function recover(h) {
  let calls=0;
  globalThis.fetch=async(...args)=>{calls++;return successFetch(...args)};
  await bounded(h.handler('recovered',h.ctx));
  assert.equal(h.entries.length,1);
  assert.equal(h.notices.at(-1).text,'已保存 1 张图片');
  assert.equal(calls,h.entries[0].data.provider==='openai'?1:2);
  return ()=>calls;
 }

 await t.test('pre-aborted runtime does not resolve credentials, send or save',async()=>{
  const controller=new AbortController();controller.abort();
  const before=await files();
  await assert.rejects(generateAndSave(config,command,[],dir,async()=>assert.fail('Pre-abort resolved auth'),controller.signal,
   async()=>assert.fail('Pre-abort sent HTTP')),error=>error.name==='AbortError');
  assert.deepEqual(await files(),before);
 });
 await t.test('never-settling auth can cancel safely and removes its abort listener',async()=>{
  const controller=new AbortController();let started=false;
  const pending=generateAndSave(config,command,[],dir,()=>{started=true;return new Promise(()=>{})},controller.signal,
   async()=>assert.fail('Cancelled auth sent HTTP'));
  await until(()=>started);
  assert.equal(getEventListeners(controller.signal,'abort').length,1);
  controller.abort();await assert.rejects(bounded(pending),error=>error.name==='AbortError');
  assert.equal(getEventListeners(controller.signal,'abort').length,0);
 });
 await t.test('Escape before auth starts sends nothing and permits a later task',async()=>{
  globalThis.fetch=async()=>assert.fail('Pre-send cancellation sent HTTP');
  const h=await cancellable({cancelImmediately:true,auth:async()=>assert.fail('Pre-send cancellation invoked auth')});
  await bounded(h.handler('offline',h.ctx));
  assert.equal(h.entries.length,0);assert.equal(h.doneCount,1);
  // Use a separate extension instance to prove the process-wide guard was released.
  const fresh=await cancellable();await recover(fresh);
 });
 for(const outcome of ['success','error','never'])await t.test(`auth ignoring abort: ${outcome}; no late request and usable again`,async()=>{
  const gate=deferred();let started=false,authCalls=0;
  globalThis.fetch=async()=>assert.fail('Cancelled auth sent HTTP');
  const h=await cancellable({auth:()=>{
   authCalls++;started=true;
   return authCalls===1?(outcome==='never'?new Promise(()=>{}):gate.promise):Promise.resolve({auth:{apiKey:token}});
  }});
  const pending=h.handler('offline auth',h.ctx);await until(()=>started&&h.loader);
  const questions=h.questions.length;
  await Promise.all([h.handler('',h.ctx),h.handler('',h.ctx)]);
  assert.equal(h.questions.length,questions);assert.equal(authCalls,1);
  for(const width of [24,40,80,120]) {
   const lines=h.loader.render(width);
   const {visibleWidth,stripTerminalSequences}=await jiti.import('@earendil-works/pi-tui');
   assert.ok(lines.every(line=>visibleWidth(line)<=width));
   assert.ok(lines.map(stripTerminalSequences).join('').replace(/\s/g,'').includes('正在生成：GPTImage2.6Flare'));
   h.loader.invalidate();assert.ok(h.loader.render(width).length>0);
  }
  h.loader.handleInput('\x1b');await bounded(pending);
  assert.equal(h.loader.signal.aborted,true);assert.equal(h.doneCount,1);assert.equal(h.entries.length,0);
  const recoveryCalls=await recover(h);
  if(outcome==='success')gate.resolve({auth:{apiKey:token}});
  if(outcome==='error')gate.reject(new Error('late authentication error'));
  await new Promise(setImmediate);await new Promise(setImmediate);
  assert.equal(recoveryCalls(),1);assert.equal(h.entries.length,1);assert.equal(h.doneCount,2);
  assert.equal(h.notices.filter(n=>n.type==='error').length,0);
 });
 await t.test('abort-aware HTTP cancellation settles normally without retry',async()=>{
  let calls=0,sent=false;
  globalThis.fetch=async(_url,request)=>{
   calls++;sent=true;
   return new Promise((_,reject)=>request.signal.addEventListener('abort',()=>reject(request.signal.reason),{once:true}));
  };
  const h=await cancellable();const pending=h.handler('offline',h.ctx);await until(()=>sent);
  h.loader.handleInput('\x1b');await bounded(pending);
  assert.equal(calls,1);assert.equal(h.entries.length,0);assert.equal(h.doneCount,1);
  await recover(h);
 });
 for(const phase of ['fetch','body','download'])for(const outcome of ['success','error']) {
  await t.test(`in-flight ${phase} ignores abort then returns ${outcome}: lock held, no late result`,async()=>{
   const gate=deferred();let entered=false,calls=0,signal;
   globalThis.fetch=async(url,request)=>{
    calls++;signal=request.signal;
    if(phase==='download'&&request.method==='POST')return successFetch(url,request);
    entered=true;
    if(phase==='body'){
     const response=Response.json({});response.arrayBuffer=()=>gate.promise;return response;
    }
    return gate.promise;
   };
   const h=await cancellable(phase==='download'?{modelKey:'wan',providers:['qwen']}:{ });
   let completed=false;
   const pending=h.handler('offline',h.ctx).then(()=>{completed=true});
   await until(()=>entered&&h.loader);
   h.loader.handleInput('\x1b');await until(()=>h.notices.some(n=>n.text.startsWith('已取消图片生成')));
   assert.equal(signal.aborted,true);assert.equal(completed,false);
   const questions=h.questions.length;
   await Promise.all([h.handler('',h.ctx),h.handler('',h.ctx)]);
   assert.equal(h.questions.length,questions);
   assert.match(h.notices.at(-1).text,/底层操作尚未结束.*重启/);
   // A fresh extension factory simulates /reload: it must not bypass the old execution lock.
   const reloaded=await harness();await reloaded.handler('',reloaded.ctx);
   assert.equal(reloaded.questions.length,0);assert.match(reloaded.notices.at(-1).text,/reload.*不会解除/);
   const before=await files();
   if(outcome==='error')gate.reject(new Error('late transport failure'));
   else if(phase==='body')gate.resolve(new TextEncoder().encode(JSON.stringify({data:[{b64_json:bytes.toString('base64')}]})).buffer);
   else if(phase==='download')gate.resolve(new Response(bytes,{headers:{'content-type':'image/png'}}));
   else gate.resolve(Response.json({data:[{b64_json:bytes.toString('base64')}] }));
   await bounded(pending);
   assert.equal(calls,phase==='download'?2:1);assert.equal(h.entries.length,0);assert.equal(h.doneCount,1);
   assert.equal(h.notices.filter(n=>n.type==='error').length,0);
   assert.deepEqual(await files(),before);
   await recover(h);
   // Old disposed loader callbacks must not close or cancel subsequent tasks.
   h.loader.handleInput('\x1b');
   await reloaded.handler('--help',reloaded.ctx);assert.equal(reloaded.notices.at(-1).type,'info');
  });
 }
 await t.test('custom UI rejection aborts but retains the execution lock until transport settles',async()=>{
  const gate=deferred();let sent=false,calls=0,signal,loader,rejectUI,completed=false;
  globalThis.fetch=async(_url,request)=>{calls++;sent=true;signal=request.signal;return gate.promise};
  const h=await harness({custom:factory=>new Promise((resolve,reject)=>{
   rejectUI=reject;loader=factory(display,dark,keybindings,value=>{loader.dispose();resolve(value)});
  })});
  const pending=h.handler('offline',h.ctx).then(()=>{completed=true});
  await until(()=>sent&&loader);
  loader.dispose();rejectUI(new Error('offline custom UI teardown failed'));
  await until(()=>signal.aborted);
  assert.equal(completed,false);
  const before=await files(),questions=h.questions.length;
  await h.handler('',h.ctx);assert.equal(h.questions.length,questions);assert.equal(calls,1);
  gate.reject(new Error('late response after UI teardown'));
  await bounded(pending);assert.deepEqual(await files(),before);assert.equal(h.entries.length,0);
  assert.equal(h.notices.filter(n=>n.type==='error').length,1);
  assert.match(h.notices.at(-1).text,/custom UI teardown failed/);
  await recover(h);
 });
 await t.test('non-Error UI rejection is handled without leaving the lock held',async()=>{
  let failed=false,loader;
  const h=await harness({custom:factory=>{
   if(!failed){failed=true;throw 'opaque non-Error UI rejection'};
   return new Promise(resolve=>{loader=factory(display,dark,keybindings,value=>{loader.dispose();resolve(value)})});
  }});
  globalThis.fetch=async()=>assert.fail('Rejected UI sent HTTP');
  await bounded(h.handler('offline',h.ctx));
  assert.equal(h.entries.length,0);assert.equal(h.notices.at(-1).text,'图片生成失败');
  assert.equal(h.notices.at(-1).type,'error');await recover(h);
 });
 await t.test('ordinary error releases the lock and a real subsequent task succeeds once',async()=>{
  let calls=0;
  globalThis.fetch=async()=>{calls++;throw new Error('offline failure')};
  const h=await cancellable();await bounded(h.handler('offline',h.ctx));
  assert.equal(calls,1);assert.equal(h.entries.length,0);assert.equal(h.doneCount,1);
  assert.equal(h.notices.filter(n=>n.type==='error').length,1);
  await recover(h);assert.equal(h.doneCount,2);
 });
 // A true never-settling HTTP Promise cannot be safely unlocked in-process. Isolate these
 // probes so their intentionally retained guards/traces cannot contaminate other tests.
 for(const phase of ['fetch','body'])await t.test(`permanent ${phase} hang: UI closed, execution retained across reload, no retry`,async()=>{
  const {stdout,stderr}=await promisify(execFile)(process.execPath,
   ['--unhandled-rejections=strict',fileURLToPath(new URL('./hanging-lifecycle-host.mjs',import.meta.url)),sdk,phase],
   {timeout:15000,env:{...process.env}});
  assert.match(stdout,/permanent-hang safety passed/);assert.equal(stderr,'');
 });
}
