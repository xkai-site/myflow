import assert from 'node:assert/strict';
import test from 'node:test';
import { createAcceptanceFetch, MAX_ACCEPTANCE_RESPONSE_BYTES, sha256 } from './acceptance-guard.mjs';
const url='https://chatgpt.com/backend-api/codex/images/edits';
const body={model:'gpt-image-2.6-flare',n:1,prompt:'PUBLIC FIXTURE',size:'1024x1024',images:[{image_url:'PUBLIC ORIGINAL'}],markup:{image_url:'PUBLIC OVERLAY'}};
const init=(extra:object={})=>({method:'POST',redirect:'error' as const,body:JSON.stringify(body),...extra});
const json=(text='{}',extra:object={})=>new Response(text,{headers:{'content-type':'application/json'},...extra});

test('acceptance guard forwards the exact approved request only once, reserving before sending',async()=>{
 let calls=0;const order:string[]=[];
 const g=createAcceptanceFetch({url,body,beforeAttempt:async()=>{order.push('reserve')},fetch:async(target:any,request:any)=>{calls++;order.push('send');assert.equal(target,url);assert.equal(request.body,JSON.stringify(body));return json('{"unchanged":true}')}});
 assert.equal(await (await g.fetch(url,init())).text(),'{"unchanged":true}');
 await assert.rejects(g.fetch(url,init()),/consumed/);
 assert.equal(calls,1);assert.equal(g.attempts,1);assert.deepEqual(order,['reserve','send']);
});

test('acceptance guard rejects changed endpoints, methods, controls, model, prompt and sample before network',async()=>{
 for(const [target,request]of [[url+'?probe=1',init()],['https://api.openai.com/v1/images/edits',init()],[url,init({method:'GET'})],[url,init({redirect:'follow'})],...['model','prompt','images','markup','stream'].map(key=>[url,init({body:JSON.stringify({...body,[key]:'PRIVATE INVALID VALUE'})})])]){
  let calls=0,reservations=0;
  const g=createAcceptanceFetch({url,body,beforeAttempt:async()=>{reservations++},fetch:async()=>{calls++;return json()}});
  await assert.rejects(g.fetch(target,request),error=>{assert.match(String(error),/approved acceptance plan/);assert.doesNotMatch(String(error),/PRIVATE/);return true});
  assert.equal(calls,0);assert.equal(reservations,0);assert.equal(g.attempts,0);
 }
});

test('acceptance guard enforces actual byte limits across chunks despite false Content-Length and cancels overflow',async()=>{
 let cancelled=0;
 const source=new ReadableStream({pull(c){c.enqueue(new Uint8Array(7))},cancel(){cancelled++}});
 const g=createAcceptanceFetch({url,body,maxBytes:16,fetch:async()=>new Response(source,{headers:{'content-type':'application/json','content-length':'1'}})});
 await assert.rejects((await g.fetch(url,init())).arrayBuffer(),/byte limit/);
 assert.equal(cancelled,1);assert.equal(g.attempts,1);
 for(const maxBytes of [0,-1,NaN,MAX_ACCEPTANCE_RESPONSE_BYTES+1])assert.throws(()=>createAcceptanceFetch({url,body,maxBytes,fetch:async()=>json()}),/byte limit/);
});

test('acceptance evidence contains hashed IDs and metadata only, never raw IDs, cookies or payload',async()=>{
 let meta:any;
 const g=createAcceptanceFetch({url,body,onResponse:(m:any)=>{meta=m},fetch:async()=>new Response('{}',{headers:{'content-type':'application/json; charset=utf-8','x-request-id':'PRIVATE-REQUEST-ID','x-codex-imagegen-request-id':'PRIVATE-IMAGEGEN-ID','set-cookie':'PRIVATE-COOKIE'}})});
 await(await g.fetch(url,init())).text();
 assert.equal(meta.status,200);assert.equal(meta.requestIds['x-request-id'],`sha256:${sha256('PRIVATE-REQUEST-ID')}`);
 assert.doesNotMatch(JSON.stringify(meta),/PRIVATE|COOKIE|PUBLIC FIXTURE|OVERLAY|ORIGINAL/);
});

test('acceptance guard never retries HTTP refusal or network failure',async()=>{
 for(const status of [400,401,403,429,502]){
  let calls=0;const g=createAcceptanceFetch({url,body,fetch:async()=>{calls++;return json('{"error":{"code":"test"}}',{status})}});
  const response=await g.fetch(url,init());assert.equal(response.status,status);await response.text();
  await assert.rejects(g.fetch(url,init()),/consumed/);assert.equal(calls,1);
 }
 let calls=0;const g=createAcceptanceFetch({url,body,fetch:async()=>{calls++;throw new Error('mock disconnect')}});
 await assert.rejects(g.fetch(url,init()),/disconnect/);await assert.rejects(g.fetch(url,init()),/consumed/);assert.equal(calls,1);
});

test('acceptance guard rejects non-JSON/redirect responses without retaining an untrusted body',async()=>{
 for(const response of [new Response('PRIVATE HTML',{headers:{'content-type':'text/html'}}),Response.redirect('https://example.test/',302)]){
  const g=createAcceptanceFetch({url,body,fetch:async()=>response});
  await assert.rejects(g.fetch(url,init()),error=>{assert.match(String(error),/protocol/);assert.doesNotMatch(String(error),/PRIVATE HTML/);return true});
 }
});

test('acceptance guard cancellation suppresses late chunks and pre-abort sends nothing',async()=>{
 const pre=new AbortController();pre.abort();let calls=0;
 const g=createAcceptanceFetch({url,body,fetch:async()=>{calls++;return json()}});
 await assert.rejects(g.fetch(url,init({signal:pre.signal})),{name:'AbortError'});assert.equal(calls,0);
 const mid=new AbortController();let cancelled=0,controller:any;
 const pending=createAcceptanceFetch({url,body,fetch:async()=>new Response(new ReadableStream({start(c){controller=c},cancel(){cancelled++}}),{headers:{'content-type':'application/json'}})});
 const reading=(await pending.fetch(url,init({signal:mid.signal}))).arrayBuffer();
 const rejected=assert.rejects(reading,{name:'AbortError'});mid.abort();await rejected;
 assert.equal(cancelled,1);assert.throws(()=>controller.enqueue(new Uint8Array([1])));
});
