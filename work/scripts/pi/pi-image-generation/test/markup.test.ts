import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { advancedFixtures } from "./advanced-fixtures.mjs";
import { getModel, readTestConfig } from "./config-helpers.ts";
import { parseImageCommand, resolveImageCommand } from "../src/command.ts";
import { normalizeNativeOutput, validateImageConfig } from "../src/model-config.ts";
import { loadMarkupImage, prepareMarkupEdit, MARKUP_MAX_JSON_BYTES, MARKUP_MAX_DATA_URL_LENGTH } from "../src/markup.ts";
import { buildOpenAICodexRequest, generateOpenAICodexImages } from "../src/openai-codex-images.ts";
import { buildAliWanRequest } from "../src/ali-wan-images.ts";
import { parameterItems, selectParameters } from "../src/tui-options.ts";

const config = await readTestConfig();
const f = await advancedFixtures();
const original = f.image(f.original), markup = f.image(f.overlay);
const token = `header.${Buffer.from(JSON.stringify({"https://api.openai.com/auth":{chatgpt_account_id:"offline"}})).toString("base64url")}.signature`;
const baseUrl = "https://chatgpt.com/backend-api/codex";
function enabled(key="openai-flare-26") {
 const c = structuredClone(config), m = getModel(c,key); m.nativeCapabilities!.markup!.enabled = true;
 return {config:validateImageConfig(c),model:m};
}
function options(model:any, extra:object={}) { return {apiKey:token,baseUrl,model:model.id,modelConfig:model,prompt:"offline edit",size:"auto",images:[original],markup,...extra}; }

test("Markup is independently default closed for 2.5/2.6, hidden for generate/Wan, and old config remains valid",()=>{
 for (const key of ["openai-flare","openai-sunburst","openai-flare-26","openai-sunburst-26"]) {
  const model = getModel(config,key);
  assert.equal(model.nativeCapabilities!.markup!.enabled,false);
  assert.throws(()=>normalizeNativeOutput(model,{markup},"edit"),/not enabled/);
  assert.ok(!parameterItems(model,"edit",{size:"auto"}).some(x=>x.key==="markupPath"));
  const on=enabled(key).model;
  assert.ok(parameterItems(on,"edit",{size:"auto"}).some(x=>x.key==="markupPath"));
  assert.ok(!parameterItems(on,"generate",{size:"auto"}).some(x=>x.key==="markupPath"));
 }
 const old=structuredClone(config);for(const m of old.models)delete m.nativeCapabilities;
 assert.doesNotThrow(()=>validateImageConfig(old));
 const model=enabled().model;
 assert.throws(()=>normalizeNativeOutput(model,{markup},"generate"),/editing/);
 for(const extra of [{mask:{}},{prompt_rewriter:false},{promptRewriter:true},{stream:true}]) assert.throws(()=>normalizeNativeOutput(model,{markup,...extra},"edit"),/not enabled/);
 assert.throws(()=>buildAliWanRequest(options(model)),/not enabled/);
});

test("Markup RPC paths are separate from references, validate duplicate/missing paths and -- termination",()=>{
 const {model,config:c}=enabled();
 for(const sep of [" ","="]) {
  const p=parseImageCommand(`/image ${model.key} --image${sep}'first image.png' --image${sep}ref.webp --markup${sep}'overlay.png' change vase`,c);
  assert.deepEqual(p.referencePaths,["first image.png","ref.webp"]);assert.equal(p.markupPath,"overlay.png");
  const command=resolveImageCommand(p,model,0,c);assert.equal(command.markupPath,"overlay.png");
 }
 for(const text of ["--markup","--markup=","--image --markup x","--markup a --markup b"]) assert.throws(()=>parseImageCommand(`/image ${text}`,c));
 assert.throws(()=>resolveImageCommand(parseImageCommand("/image --markup x change",c),model,0,c),/editing/);
 assert.throws(()=>resolveImageCommand({prompt:"x",help:false,referencePaths:["a"]},model,1,c),/combine/);
 assert.throws(()=>resolveImageCommand({prompt:"x",help:false,referencePaths:Array(17).fill("a")},model,0,c),/at most/);
 assert.equal(parseImageCommand("/image -- --markup overlay.png",c).prompt,"--markup overlay.png");
});

test("Markup truly decodes transparent pixels, including palette transparency, never accepts an opaque alpha channel",async()=>{
 const {model}=enabled();
 const pair=await prepareMarkupEdit(model,[original],markup);
 const raw=await sharp(Buffer.from(pair.markup.data,"base64")).ensureAlpha().raw().toBuffer();
 assert.ok(raw.some((n,i)=>i%4===3&&n<255));
 await assert.rejects(prepareMarkupEdit(model,[original],f.image(f.opaque)),/actual transparent pixels/);
 const rgb=await sharp(f.overlay).removeAlpha().png().toBuffer();
 await assert.rejects(prepareMarkupEdit(model,[original],f.image(rgb)),/actual transparent pixels/);
 const palette=await sharp(f.overlay).png({palette:true}).toBuffer();
 await assert.doesNotReject(prepareMarkupEdit(model,[original],f.image(palette)));
 const jpeg=await sharp(f.overlay).jpeg().toBuffer();
 await assert.rejects(prepareMarkupEdit(model,[original],f.image(jpeg)),/PNG|MIME/);
 await assert.rejects(prepareMarkupEdit(model,[original],f.image(f.overlay.subarray(0,40))));
 const apng=await readFile(new URL('./fixtures/markup-two-frame.png',import.meta.url));
 await assert.rejects(prepareMarkupEdit(model,[original],f.image(apng)),/Animated PNG/);
 await assert.rejects(prepareMarkupEdit(model,[f.image(apng)],markup),/Animated PNG/);
});

test("Markup retains 16-bit transparent alpha without rounding it into an opaque 8-bit channel",async()=>{
 const {model}=enabled();
 const pixels=new Uint16Array([65535,0,0,65534,0,65535,0,65535]);
 const png=await sharp(pixels,{raw:{width:2,height:1,channels:4}}).toColourspace("rgb16").png().toBuffer();
 const source=await sharp({create:{width:2,height:1,channels:3,background:"#abc"}}).png().toBuffer();
 const pair=await prepareMarkupEdit(model,[f.image(source)],f.image(png));
 const normalized=Buffer.from(pair.markup.data,"base64");
 assert.equal((await sharp(normalized).metadata()).bitsPerSample,16);
 assert.equal((await sharp(normalized).stats()).channels[3].min,65534);
 const opaque=await sharp(new Uint16Array([65535,0,0,65535,0,65535,0,65535]),{raw:{width:2,height:1,channels:4}}).toColourspace("rgb16").png().toBuffer();
 await assert.rejects(prepareMarkupEdit(model,[f.image(source)],f.image(opaque)),/actual transparent pixels/);
});

test("Markup normalizes actual EXIF orientation on both inputs, verifies matching oriented dimensions and pixel caps",async()=>{
 const {model}=enabled();
 assert.equal((await sharp(f.oriented).metadata()).orientation,6);
 const pair=await prepareMarkupEdit(model,[f.image(f.oriented,"image/jpeg")],f.image(f.orientedOverlay));
 for(const image of [pair.images[0],pair.markup]) {
  const m=await sharp(Buffer.from(image.data,"base64")).metadata();
  assert.equal(m.width,3);assert.equal(m.height,2);assert.equal(m.orientation,undefined);
 }
 assert.equal((await sharp(Buffer.from(pair.images[0].data,"base64")).raw().toBuffer()).length,18);
 const mismatch=await sharp(f.overlay).resize(2,2).png().toBuffer();
 await assert.rejects(prepareMarkupEdit(model,[original],f.image(mismatch)),/dimensions/);
 // Real, compressed 16,781,312-pixel PNG; no fake header accepted as proof of decoding.
 const huge=await sharp({create:{width:4096,height:4097,channels:4,background:{r:0,g:0,b:0,alpha:0}}}).png().toBuffer();
 await assert.rejects(prepareMarkupEdit(model,[original],f.image(huge)),/pixel limit|pixel/);
 await assert.rejects(prepareMarkupEdit(model,[f.image(huge)],markup),/pixel limit|pixel/);
});

test("Markup size/data URL checks and bounded local file loading precede a request",async()=>{
 const {model}=enabled();
 assert.ok("data:image/png;base64,".length+Math.ceil(MARKUP_MAX_JSON_BYTES/3)*4<=MARKUP_MAX_DATA_URL_LENGTH);
 assert.ok("data:image/png;base64,".length+Math.ceil((MARKUP_MAX_JSON_BYTES+1)/3)*4>MARKUP_MAX_DATA_URL_LENGTH);
 const dir=await mkdtemp(path.join(tmpdir(),"markup-input-"));
 try {
  await writeFile(path.join(dir,"overlay.png"),f.overlay);
  assert.deepEqual(await loadMarkupImage(dir,"overlay.png"),markup);
  await assert.rejects(loadMarkupImage(dir,"missing.png"),/ENOENT/);
  await assert.rejects(loadMarkupImage(dir,"."),/file|EISDIR/);
  const oversized=Buffer.alloc(MARKUP_MAX_JSON_BYTES+1); f.overlay.copy(oversized);
  await writeFile(path.join(dir,"large.png"),oversized);
  await assert.rejects(loadMarkupImage(dir,"large.png"),/size limit/);
  await assert.rejects(prepareMarkupEdit(model,[original],f.image(oversized)),/size limit/);
  const abort=new AbortController();abort.abort();
  await assert.rejects(loadMarkupImage(dir,"overlay.png",abort.signal),{name:"AbortError"});
  await assert.rejects(prepareMarkupEdit(model,[original],markup,abort.signal),{name:"AbortError"});
 } finally {await rm(dir,{recursive:true,force:true});}
});

test("Markup request uses a validated separate object, preserves original/reference order and never composites",async()=>{
 for(const key of ["openai-flare","openai-sunburst","openai-flare-26","openai-sunburst-26"]) {
  const {model}=enabled(key);const ref=f.image(f.opaque);
  const pair=await prepareMarkupEdit(model,[original,ref],markup);
  assert.ok(Object.isFrozen(pair.images)&&Object.isFrozen(pair.markup));
  const request=buildOpenAICodexRequest(options(model,pair));
  assert.equal(request.url,`${baseUrl}/images/edits`);
  assert.deepEqual(request.body.images,pair.images.map(image=>({image_url:`data:${image.mimeType};base64,${image.data}`})));
  assert.deepEqual(request.body.markup,{image_url:`data:image/png;base64,${pair.markup.data}`});
  assert.equal((request.body.images as any[]).length,2);assert.equal(pair.images[1].data,ref.data);
  const pix=await sharp(Buffer.from(pair.images[0].data,"base64")).removeAlpha().raw().toBuffer();
  const originalPix=await sharp(f.original).removeAlpha().raw().toBuffer();assert.deepEqual(pix,originalPix);
  assert.throws(()=>buildOpenAICodexRequest(options(model)),/pixel\/orientation/);
  assert.throws(()=>buildOpenAICodexRequest(options(model,{...pair,markup:{...pair.markup}})),/pixel\/orientation/);
 }
});

test("Markup adapter succeeds once with mock raster response; disabled/invalid overlay cannot reach HTTP or JWT",async()=>{
 const {model}=enabled();let calls=0;
 const result=await generateOpenAICodexImages(options(model,{fetch:async(url:any,init:any)=>{
  calls++;assert.ok(String(url).endsWith("/images/edits"));const body=JSON.parse(init.body);
  assert.equal(body.images.length,1);assert.ok(body.markup.image_url.startsWith("data:image/png;base64,"));
  return Response.json({data:[{b64_json:original.data}]});
 }}));
 assert.equal(calls,1);assert.deepEqual(result.images,[original]);
 for(const extra of [{modelConfig:getModel(config,model.key)},{markup:f.image(f.opaque)},{images:[]}]) {
  await assert.rejects(generateOpenAICodexImages(options(model,{apiKey:"bad-token",...extra,fetch:async()=>{calls++;return Response.json({});}})),/not enabled|transparent/);
 }
 assert.equal(calls,1);
 for(const status of [400,403,502]) {
  let attempts=0;
  await assert.rejects(generateOpenAICodexImages(options(model,{fetch:async()=>{attempts++;return Response.json({error:{message:"Markup preview unavailable"}},{status});}})),new RegExp(String(status)));
  assert.equal(attempts,1);
 }
 assert.throws(()=>buildOpenAICodexRequest(options(model,{markupPath:"overlay.png"})),/runtime/);
});

test("Markup optional TUI path can be selected, cancelled or removed without extra default steps",async()=>{
 const {model}=enabled();
 for(const input of ["'overlay.png'",undefined,""]) {
  let menu=0;
  const result=await selectParameters({ui:{input:async()=>input,select:async(_title,labels)=>++menu===1?labels.find(l=>l.startsWith("标记 PNG")):labels[0]}},model,"edit");
  assert.equal(result!.markupPath,input?"overlay.png":undefined);assert.equal(menu,2);
 }
});
