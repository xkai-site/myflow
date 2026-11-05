import assert from "node:assert/strict";
import test from "node:test";
import { parseSse, readImageSse } from "../src/image-sse.ts";
import { imageFixtures } from "./image-fixtures.mjs";
import { advancedFixtures } from "./advanced-fixtures.mjs";
const f=await advancedFixtures();
const completedPng=f.image(f.original);
const png={data:imageFixtures.png.data,mimeType:imageFixtures.png.mimeType};
const event=(type:string,extra:object={},newline="\n")=>`event: ${type}${newline}data: ${JSON.stringify({type,b64_json:png.data,output_format:"png",...extra})}${newline}${newline}`;
function response(text:string,size=65536) {
 const bytes=new TextEncoder().encode(text);let offset=0;
 return new Response(new ReadableStream({pull(c){if(offset>=bytes.length)c.close();else {c.enqueue(bytes.subarray(offset,offset+size));offset+=size;}}}),{headers:{"content-type":"text/event-stream; charset=utf-8"}});
}
const opts={task:"generate" as const,outputFormat:"png" as const,partialImages:3};

test("SSE framing handles CRLF/CR/LF, multiline data, UTF-8 and every byte boundary",async()=>{
 for(const newline of ["\n","\r\n","\r"])for(const size of [1,2,3,7,65536]) {
  const text=`: 中文 heartbeat${newline}id: ignored${newline}retry: 1000${newline}event: image_generation.completed${newline}data: {"type":"image_generation.completed",${newline}data: "b64_json":"${png.data}","output_format":"png"}${newline}${newline}`;
  const result=await readImageSse(response(text,size),opts);assert.deepEqual(result.images,[png]);
 }
 assert.deepEqual((await readImageSse(response('\ufeff'+event('image_generation.completed'),1),opts)).images,[png]);
 assert.deepEqual((await readImageSse(response(event('image_generation.completed',{note:'x'.repeat(131072)}),17),opts)).images,[png]);
});

test("SSE image adapters distinguish generation/edit events and only return the completed image",async()=>{
 for(const task of ["generate","edit"] as const) {
  const prefix=task==="edit"?"image_edit":"image_generation",seen:any[]=[];
  const stream=event(`${prefix}.partial_image`,{partial_image_index:0})+event(`${prefix}.partial_image`,{partial_image_index:1})+event(`${prefix}.completed`,{b64_json:completedPng.data});
  const result=await readImageSse(response(stream,7),{...opts,task,onPartial:(image,index)=>{seen.push({image,index});assert.ok(Object.isFrozen(image));}});
  assert.deepEqual(seen.map(x=>x.index),[0,1]);assert.equal(result.images.length,1);assert.deepEqual(result.images,[completedPng]);
  assert.notEqual(result.images[0].data,seen[0].image.data);
 }
});

test("SSE accepts early completion with fewer partials and partial_images=0, never requires a fixed preview count",async()=>{
 for(const partialImages of [0,1,2,3]) {
  let previews=0;
  assert.deepEqual((await readImageSse(response(event("image_generation.completed")),{...opts,partialImages,onPartial:()=>{previews++;}})).images,[png]);
  assert.equal(previews,0);
 }
});

test("SSE completed raster formats preserve native PNG, JPEG and WebP bytes",async()=>{
 for(const [outputFormat,fixture] of Object.entries(imageFixtures)) {
  const result=await readImageSse(response(event("image_generation.completed",{b64_json:fixture.data,output_format:outputFormat}),1),{...opts,outputFormat:outputFormat as "png"|"jpeg"|"webp"});
  assert.deepEqual(result.images,[{data:fixture.data,mimeType:fixture.mimeType}]);
 }
});

test("SSE invalid settings, non-SSE JSON and HTTP errors cannot contaminate the JSON transport",async()=>{
 for(const partialImages of [-1,4,1.5,NaN]) await assert.rejects(readImageSse(response(""),{...opts,partialImages}),/0 to 3/);
 for(const outputFormat of ["svg","gif"] as any[]) await assert.rejects(readImageSse(response(""),{...opts,outputFormat}),/not SVG or GIF/);
 for(const res of [Response.json({data:[{b64_json:png.data}]}),new Response("forbidden",{status:403}),new Response(null,{headers:{"content-type":"text/event-stream"}})]) await assert.rejects(readImageSse(res,opts),/SSE response/);
});

test("SSE rejects errors, Responses API event names, malformed data, unexpected order and unconfirmed sentinels",async()=>{
 const final=event("image_generation.completed");
 for(const text of [
  event("error",{message:"PRIVATE SERVER TEXT"}),event("response.image_generation_call.partial_image",{partial_image_index:0}),
  'data: [DONE]\n\n','data: {bad json}\n\n','data: []\n\n',
  'event: image_generation.completed\ndata: {"type":"image_edit.completed","b64_json":"'+png.data+'"}\n\n',
  event("image_edit.completed"), final+final,final+event("image_generation.partial_image",{partial_image_index:0}),
  event("image_generation.completed",{b64_json:"!bad!"}),event("image_generation.completed",{output_format:"jpeg"}),
  event("image_generation.completed",{b64_json:imageFixtures.jpeg.data}),
 ]) await assert.rejects(readImageSse(response(text,3),opts),error=>{assert.doesNotMatch(String(error),/PRIVATE SERVER TEXT/);return true;});
});

test("SSE bounds partial indexes, rejects duplicates and never treats a partial as final on EOF",async()=>{
 for(const partial_image_index of [-1,3,1.5,"0",null]) await assert.rejects(readImageSse(response(event("image_generation.partial_image",{partial_image_index})+event("image_generation.completed")),opts),/partial_image_index/);
 await assert.rejects(readImageSse(response(event("image_generation.partial_image",{partial_image_index:0})),{...opts,partialImages:0}),/partial_image_index/);
 const p=event("image_generation.partial_image",{partial_image_index:0});
 await assert.rejects(readImageSse(response(p+p),opts),/partial_image_index/);
 await assert.rejects(readImageSse(response(p),opts),/without a completed/);
 await assert.rejects(readImageSse(response(event("image_generation.completed").trimEnd()),opts),/without a completed/);
});

test("SSE has single-event and cumulative byte budgets, including comments and unterminated fields",async()=>{
 const final=event("image_generation.completed"),n=Buffer.byteLength(final);
 await assert.rejects(readImageSse(response(final,1),{...opts,maxEventBytes:n-3}),/event byte limit/);
 await assert.rejects(readImageSse(response(":"+"a".repeat(5000),7),{...opts,maxEventBytes:100}),/event byte limit/);
 await assert.rejects(readImageSse(response(": keepalive\n\n".repeat(50)+final,3),{...opts,maxTotalBytes:n+100}),/cumulative byte limit/);
 await assert.rejects(readImageSse(response(final),{...opts,maxEventBytes:0}),/resource limit/);
 await assert.rejects(readImageSse(response('data:\n'.repeat(100001)+'\n'),opts),/data-line limit/);
 const invalid=new Response(new Uint8Array([0xff]),{headers:{"content-type":"text/event-stream"}});
 await assert.rejects(readImageSse(invalid,opts),/encoded data|encoding|UTF/);
});

test("SSE aborts pending reads, cancels the reader and ignores final/partial events after cancellation",async()=>{
 const abort=new AbortController();let controller:any,cancelled=0,previews=0;
 const res=new Response(new ReadableStream({start(c){controller=c},cancel(){cancelled++}}),{headers:{"content-type":"text/event-stream"}});
 const pending=readImageSse(res,{...opts,signal:abort.signal,onPartial:()=>{previews++;}});
 const rejected=assert.rejects(pending,{name:"AbortError"});
 abort.abort();await rejected;assert.equal(cancelled,1);assert.equal(previews,0);
 assert.throws(()=>controller.enqueue(new TextEncoder().encode(event("image_generation.completed"))));
 const mid=new AbortController();let count=0;
 await assert.rejects(readImageSse(response(event("image_generation.partial_image",{partial_image_index:0})+event("image_generation.completed")),{...opts,signal:mid.signal,onPartial:()=>{count++;mid.abort();}}),{name:"AbortError"});
 assert.equal(count,1);
 const before=new AbortController();before.abort();
 await assert.rejects(readImageSse(response(event("image_generation.completed")),{...opts,signal:before.signal}),{name:"AbortError"});
});

test("SSE network truncation and preview callback failures cannot produce a final result",async()=>{
 let pulls=0;
 const body=new ReadableStream<Uint8Array>({pull(c){if(pulls++===0)c.enqueue(new TextEncoder().encode(event("image_generation.partial_image",{partial_image_index:0})));else c.error(new Error("mock stream disconnected"));}});
 await assert.rejects(readImageSse(new Response(body,{headers:{"content-type":"text/event-stream"}}),opts),/disconnected/);
 await assert.rejects(readImageSse(response(event("image_generation.partial_image",{partial_image_index:0})+event("image_generation.completed")),{...opts,onPartial:()=>{throw new Error("preview failed");}}),/preview failed/);
});

test("SSE framing dispatches only terminated data events, resets event name and ignores comment-only blocks",async()=>{
 const events=[];
 for await(const value of parseSse(response(': hi\n\nevent: test\ndata: first\ndata: second\n\ndata: third\n\nevent: no-data\n\ndata: discarded').body!)) events.push(value);
 assert.deepEqual(events,[{event:"test",data:"first\nsecond"},{event:"message",data:"third"}]);
});
