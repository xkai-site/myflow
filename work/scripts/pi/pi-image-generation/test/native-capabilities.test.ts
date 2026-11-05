import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateAnimatedGif } from "../src/gif.ts";
import { decodeGeneratedArtifact, decodeGeneratedImage, saveGeneratedImages, validateInputImages } from "../src/image-files.ts";
import { normalizeNativeOutput, outputFormatForTask, validateImageConfig } from "../src/model-config.ts";
import { parseImageCommand, resolveImageCommand } from "../src/command.ts";
import { buildOpenAICodexRequest, generateOpenAICodexImages } from "../src/openai-codex-images.ts";
import { buildAliWanRequest } from "../src/ali-wan-images.ts";
import { parameterItems, selectParameters } from "../src/tui-options.ts";
import { getModel, readTestConfig } from "./config-helpers.ts";
import { imageFixtures } from "./image-fixtures.mjs";

const config = await readTestConfig();
const gifBytes = await readFile(new URL("./fixtures/native-two-frame.gif", import.meta.url));
const gifImage = { data: gifBytes.toString("base64"), mimeType: "image/gif" };
const apiKey = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline" } })).toString("base64url")}.signature`;
const baseUrl = "https://chatgpt.com/backend-api/codex";
function enabled(key = "openai-flare-26") {
 const c = structuredClone(config); const model = getModel(c, key);
 model.nativeCapabilities!.gif!.enabled = true;
 return { config: validateImageConfig(c), model };
}
function options(extra: object = {}) {
 const {model} = enabled();
 return {apiKey, baseUrl, images: [], model: model.id, modelConfig: model, prompt: "offline native motion", size: "auto", outputFormat: "gif", frameCount: 2, frameDurationMs: 200, ...extra};
}

test("native catalog is per-model, strictly validated, backward compatible and default-closed", () => {
 for (const model of config.models) {
  assert.ok(!outputFormatForTask(model, "generate")?.options.some(o => o.value === "gif" || o.value === "svg"));
  if (!model.nativeCapabilities) continue;
  if (model.nativeCapabilities.gif) assert.equal(model.nativeCapabilities.gif.enabled, false);
  for (const value of Object.values(model.nativeCapabilities)) assert.equal(value.codex, "unverified");
 }
 const {config:c, model} = enabled();
 assert.ok(outputFormatForTask(model,"generate")!.options.some(o=>o.value === "gif" && o.label.includes("实验性")));
 assert.ok(!outputFormatForTask(model,"edit")!.options.some(o=>o.value === "gif"));
 assert.ok(!outputFormatForTask(getModel(c,"openai-sunburst-26"),"generate")!.options.some(o=>o.value === "gif"));
 const old = structuredClone(config); for (const m of old.models) delete m.nativeCapabilities;
 assert.doesNotThrow(()=>validateImageConfig(old));
 const mutations = [
  (m:any)=>{m.nativeCapabilities.gif.codex="verified"},
  (m:any)=>{m.nativeCapabilities.streaming.enabled=true},
  (m:any)=>{m.nativeCapabilities.svg.enabled="true"},
  (m:any)=>{m.nativeCapabilities.markup.enabled="true"},
  (m:any)=>{m.nativeCapabilities.gif.frameCount.max=64},
  (m:any)=>{m.nativeCapabilities.gif.frameCount.default=1},
  (m:any)=>{m.nativeCapabilities.gif.frameDurationMs.min=19},
  (m:any)=>{m.nativeCapabilities.gif.frameDurationMs.max=655350},
  (m:any)=>{m.nativeCapabilities.gif.size.options.push({value:"511x512",label:"invalid"})},
  (m:any)=>{m.nativeCapabilities.gif.size.options.push({value:"65536x16",label:"invalid"})},
  (m:any)=>{m.nativeCapabilities.gif.size.options.push({value:"8192x8192",label:"invalid"})},
  (m:any)=>{m.nativeCapabilities.gif.size.options.push({value:"9007199254740992x16",label:"invalid"})},
  (m:any)=>{m.nativeCapabilities.gif.size.custom=m.size.generate.custom},
  (m:any)=>{m.nativeCapabilities.gif.enabled="true"},
 ];
 for (const mutate of mutations) { const c=structuredClone(config); mutate(getModel(c,"openai-flare-26")); assert.throws(()=>validateImageConfig(c)); }
 const wan=structuredClone(config); getModel(wan,"wan").nativeCapabilities=structuredClone(model.nativeCapabilities);
 assert.throws(()=>validateImageConfig(wan),/Codex adapter/);
});

test("GIF command syntax, ranges, generation-only policy and mutually exclusive parameters", () => {
 const {model,config:c} = enabled();
 for(const separator of [" ","="]) {
  const parsed=parseImageCommand(`/image ${model.key} --format gif --frame-count${separator}2 --frame-duration-ms${separator}25 --size 512x512 motion`,c);
  const command=resolveImageCommand(parsed,model,0,c);
  assert.equal(command.frameCount,2); assert.equal(command.frameDurationMs,25); assert.equal(command.size,"512x512");
 }
 const defaults=resolveImageCommand({prompt:"motion",help:false,outputFormat:"gif"},model,0,c);
 assert.equal(defaults.frameCount,9); assert.equal(defaults.frameDurationMs,200); assert.equal(defaults.size,"auto");
 for(const flag of ["--frame-count","--frame-duration-ms"]) {
  for(const text of [flag,`${flag}=`,`${flag} --format gif`,`${flag} 1.5`,`${flag} NaN`,`${flag} 1e2`,`${flag} 9007199254740992`]) assert.throws(()=>parseImageCommand(`/image ${text}`,c),/integer/);
  assert.throws(()=>parseImageCommand(`/image ${flag}=2 ${flag} 3 motion`,c),/repeated/);
 }
 assert.equal(parseImageCommand(`/image -- --frame-count 2 motion`,c).prompt,"--frame-count 2 motion");
 for(const frameCount of [1,17,2.5,NaN]) assert.throws(()=>normalizeNativeOutput(model,{outputFormat:"gif",frameCount},"generate"),/frameCount/);
 for(const frameDurationMs of [19,2001,Infinity]) assert.throws(()=>normalizeNativeOutput(model,{outputFormat:"gif",frameDurationMs},"generate"),/frameDurationMs/);
 for(const imageCount of [1,2]) assert.throws(()=>resolveImageCommand({prompt:"edit",help:false,outputFormat:"gif"},model,imageCount,c),/editing/);
 assert.throws(()=>resolveImageCommand({prompt:"x",help:false,outputFormat:"gif",size:"1024x1024"},model,0,c),/Size/);
 for(const outputFormat of ["png","jpeg","webp"]) assert.throws(()=>normalizeNativeOutput(model,{outputFormat,frameCount:2},"generate"),/require/);
 assert.throws(()=>normalizeNativeOutput(model,{outputFormat:"gif",background:"transparent"},"generate"),/transparent/);
 for(const outputFormat of ["gif","svg"]) assert.throws(()=>resolveImageCommand({prompt:"x",help:false,outputFormat},getModel(config,model.key),0,config),/disabled|quarantined/);
});

test("native GIF body uses original Codex endpoint, sibling controls and n=1, with no retries", async () => {
 for(const key of ["openai-flare-26","openai-sunburst-26"]) {
  const {model}=enabled(key); let calls=0;
  const result=await generateOpenAICodexImages(options({model:model.id,modelConfig:model,size:"512x512",fetch:async(url:any,init:any)=>{
   calls++; assert.equal(String(url),`${baseUrl}/images/generations`); assert.equal(init.redirect,"error");
   assert.deepEqual(JSON.parse(init.body),{prompt:"offline native motion",background:"auto",model:model.id,n:1,quality:"auto",size:"512x512",output_format:"gif",frame_count:2,frame_duration_ms:200});
   return Response.json({output_format:"gif",data:[{b64_json:gifImage.data,mime_type:"image/gif"}]});
  }}));
  assert.equal(calls,1); assert.deepEqual(result.images,[gifImage]);
 }
});

test("unsupported native options fail before JWT parsing, network or request construction", () => {
 for(const model of config.models.filter(m=>m.provider==="openai")) assert.throws(()=>buildOpenAICodexRequest(options({model:model.id,modelConfig:model,apiKey:"invalid"})),/disabled/);
 for(const extra of [{stream:true},{stream:false},{partial_images:1},{partialImages:3},{markup:imageFixtures.png},{mask:imageFixtures.png},{svg:{model:"invented"}},{output_compression:90},{prompt_rewriter:false}]) {
  assert.throws(()=>buildOpenAICodexRequest(options({apiKey:"invalid",...extra})),/not enabled/);
  assert.throws(()=>buildAliWanRequest(options(extra)),/not enabled/);
 }
 assert.throws(()=>buildOpenAICodexRequest(options({images:[imageFixtures.png]})),/editing/);
 assert.throws(()=>buildAliWanRequest(options()),/not supported/);
});

test("Codex rejection, ignored format, MIME, count, delay and size fail without retries", async () => {
 for(const payload of [
  {data:[{b64_json:imageFixtures.png.data}]},
  {output_format:"png",data:[{b64_json:gifImage.data}]},
  {data:[{b64_json:gifImage.data,mime_type:"image/png"}]},
  {data:[{b64_json:gifImage.data},{b64_json:gifImage.data}]},
 ]) { let calls=0; await assert.rejects(generateOpenAICodexImages(options({fetch:async()=>{calls++;return Response.json(payload)}}))); assert.equal(calls,1); }
 for(const extra of [{frameCount:3},{frameDurationMs:300}]) await assert.rejects(generateOpenAICodexImages(options({...extra,fetch:async()=>Response.json({data:[{b64_json:gifImage.data}]})})),/count or delay/);
 const {model}=enabled();model.nativeCapabilities!.gif!.size.options.push({value:'16x16',label:'offline size'});
 await assert.rejects(generateOpenAICodexImages(options({modelConfig:model,size:'16x16',fetch:async()=>Response.json({data:[{b64_json:gifImage.data}]})})),/dimensions/);
 let calls=0;
 await assert.rejects(generateOpenAICodexImages(options({fetch:async()=>{calls++;return Response.json({error:{message:"GIF preview unavailable"}},{status:403})}})),/403/);
 assert.equal(calls,1);
});

test("real animated GIF validates signature, dimensions, palette, blocks, frames, delays and trailer", () => {
 assert.deepEqual(validateAnimatedGif(gifBytes),{width:512,height:512,frames:2,delaysMs:[200,200],loopCount:0});
 const older=Buffer.from(gifBytes); older.write("GIF87a",0); assert.equal(validateAnimatedGif(older).frames,2);
 const gce=gifBytes.indexOf(Buffer.from([0x21,0xf9,0x04]));
 const descriptor=gifBytes.indexOf(0x2c,gce+8);
 assert.ok(gce>0 && descriptor>gce);
 const mutations=[
  (b:Buffer)=>{b[gce+2]=3}, (b:Buffer)=>{b[gce+7]=1},
  (b:Buffer)=>{b.writeUInt16LE(65535,descriptor+5)},
  (b:Buffer)=>{b[descriptor+10]=1}, // invalid LZW minimum code size
  (b:Buffer)=>{b[0]=0xc7}, (b:Buffer)=>{b.writeUInt16LE(0,6)},
  (b:Buffer)=>{b.writeUInt16LE(65535,6);b.writeUInt16LE(65535,8)},
  (b:Buffer)=>{b[b.length-1]=0}, (b:Buffer)=>{b[13]=0xff; b[10]&=0x7f},
 ];
 for(const mutate of mutations) {const b=Buffer.from(gifBytes); mutate(b); assert.throws(()=>validateAnimatedGif(b),/GIF/);}
 for(const length of [0,3,6,13,32,gifBytes.length-1]) assert.throws(()=>validateAnimatedGif(gifBytes.subarray(0,length)),/GIF/);
 assert.throws(()=>validateAnimatedGif(Buffer.concat([gifBytes,Buffer.from([0])])),/GIF/);
 // A real one-frame GIF cannot masquerade as a native animation.
 assert.throws(()=>validateAnimatedGif(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==','base64')),/GIF/);
 assert.throws(()=>validateAnimatedGif(Buffer.alloc(32*1024*1024+1)),/size/);
 assert.throws(()=>decodeGeneratedArtifact({...gifImage,mimeType:"image/png"}),/MIME/);
 assert.throws(()=>decodeGeneratedArtifact({...gifImage,data:gifImage.data.slice(1)}),/base64/);
 assert.throws(()=>decodeGeneratedImage(gifImage),/signature/); // never treated as SDK raster content
 assert.throws(()=>validateInputImages([gifImage],getModel(config,"openai-flare-26").inputImages),/MIME/);
 // Unsafe/malformed SVG remains rejected by the dedicated XML parser.
 for(const xml of ['<svg>','<root/>','<svg onload="x()"><script>x()</script></svg>','<!DOCTYPE svg SYSTEM "https://example.test/a"><svg/>']) {
  assert.throws(()=>decodeGeneratedArtifact({data:Buffer.from(xml).toString("base64"),mimeType:"image/svg+xml"}),/signature/);
 }
});

test("GIF uses shared atomic save, MIME/extension, history metadata and rollback on invalid batch/cancel", async () => {
 const dir=await mkdtemp(path.join(tmpdir(),"native-gif-"));
 try {
  const saved=await saveGeneratedImages(dir,"openai","offline",[gifImage]);
  assert.equal(saved[0].mimeType,"image/gif"); assert.equal(saved[0].kind,"animation"); assert.equal(path.extname(saved[0].path),".gif");
  assert.deepEqual(await readFile(saved[0].path),gifBytes);
  const before=await readdir(path.dirname(saved[0].path));
  await assert.rejects(saveGeneratedImages(dir,"openai","offline",[gifImage,{...gifImage,mimeType:"image/png"}]),/MIME/);
  const abort=new AbortController(); abort.abort();
  await assert.rejects(saveGeneratedImages(dir,"openai","offline",[gifImage],abort.signal),{name:"AbortError"});
  assert.deepEqual(await readdir(path.dirname(saved[0].path)),before);
  // Existing static output behavior and old history shape are unchanged.
  const png=await saveGeneratedImages(dir,"openai","offline",[imageFixtures.png]); assert.equal(png[0].kind,undefined);
 } finally {await rm(dir,{recursive:true,force:true});}
});

test("GIF parameter controls appear only after explicit opt-in and format selection, switch back cleanly", async () => {
 const {model}=enabled();
 for(const m of [model,getModel(config,model.key)]) for(const task of ["generate","edit"] as const) {
  const items=parameterItems(m,task,{size:"auto",outputFormat:"png"}); assert.ok(!items.some(i=>i.key==="frameCount"));
 }
 let menu=0;
 const result=await selectParameters({ui:{input:async()=>"2",select:async(title,labels)=>{
  if(title.endsWith(" - 参数")) {
   menu++; if(menu===1) return labels.find(l=>l.startsWith("输出格式"));
   assert.ok(labels.some(l=>l.startsWith("动画帧数"))); assert.ok(labels.some(l=>l.startsWith("每帧时长")));
   return menu===2 ? labels.find(l=>l.startsWith("动画帧数")) : labels[0];
  }
  assert.equal(title,"输出格式"); return labels.find(l=>l.startsWith("GIF"));
 }}},model,"generate");
 assert.equal(result!.frameCount,2); assert.equal(result!.frameDurationMs,200); assert.equal(result!.outputFormat,"gif");
 let step=0;
 const back=await selectParameters({ui:{select:async(title,labels)=>{
  step++;
  if(step===1 || step===3) return labels.find(l=>l.startsWith("输出格式"));
  if(step===2) return labels.find(l=>l.startsWith("GIF"));
  if(step===4) return labels.find(l=>l.startsWith("PNG"));
  assert.ok(!labels.some(l=>l.startsWith("动画帧数")||l.startsWith("每帧时长"))); return labels[0];
 }}},model,"generate");
 assert.equal(back!.outputFormat,"png"); assert.equal(back!.frameCount,undefined); assert.equal(back!.frameDurationMs,undefined);
});
