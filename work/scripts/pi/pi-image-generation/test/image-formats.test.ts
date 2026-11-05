import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { decodeGeneratedImage, detectImage, imageAlphaChannel, readGeneratedImage, saveGeneratedImages } from "../src/image-files.ts";
import { generateOpenAICodexImages } from "../src/openai-codex-images.ts";
import { getModel, readTestConfig } from "./config-helpers.ts";
import { imageFixtures, opaquePng, opaqueWebp, extendedWebp } from "./image-fixtures.mjs";
const config = await readTestConfig();
const model = getModel(config,"openai-flare-26");
const apiKey = `header.${Buffer.from(JSON.stringify({"https://api.openai.com/auth":{chatgpt_account_id:"test-account"}})).toString("base64url")}.signature`;
const baseUrl = "https://chatgpt.com/backend-api/codex";
const options = {apiKey,baseUrl,model:model.id,modelConfig:model,prompt:"PRIVATE_PROMPT",images:[],size:"auto"};
const animationFixture = { data: (await readFile(new URL('./fixtures/native-two-frame.gif', import.meta.url))).toString('base64'), mimeType: 'image/gif' };

test("real PNG/JPEG/WebP signatures, MIME, extensions, saves and history reads agree", async () => {
 const dir = await mkdtemp(path.join(tmpdir(),"image-formats-"));
 try {
  for (const fixture of Object.values(imageFixtures)) {
   const bytes = Buffer.from(fixture.data,"base64");
   assert.deepEqual(detectImage(bytes),{mimeType:fixture.mimeType,extension:fixture.extension});
   assert.equal(decodeGeneratedImage(fixture).mimeType,fixture.mimeType);
   const [saved] = await saveGeneratedImages(dir,"openai",model.id,[fixture]);
   assert.equal(path.extname(saved.path),`.${fixture.extension}`); assert.equal(saved.mimeType,fixture.mimeType);
   assert.deepEqual(await readFile(saved.path),bytes);
   const history = JSON.parse(JSON.stringify(saved));
   assert.deepEqual(await readGeneratedImage(history.path,history.mimeType),{data:fixture.data,mimeType:fixture.mimeType});
  }
  assert.equal((await readdir(path.join(dir,".pi","generated-images"))).length,3);
 } finally { await rm(dir,{recursive:true,force:true}); }
});

test("Codex derives actual MIME without assuming PNG, preserving b64_json", async () => {
 for (const [outputFormat,fixture] of Object.entries(imageFixtures)) {
  const result = await generateOpenAICodexImages({...options,outputFormat,fetch:async()=>Response.json({data:[{b64_json:fixture.data}],id:"synthetic-response"})});
  assert.deepEqual(result,{images:[{data:fixture.data,mimeType:fixture.mimeType}],texts:[],responseId:"synthetic-response"});
 }
});

test("request format and actual bytes mismatches fail clearly and never retry or save", async () => {
 for (const requested of ["png","jpeg","webp"]) for (const [actual,fixture] of Object.entries(imageFixtures)) {
  if (requested === actual) continue;
  let calls = 0;
  await assert.rejects(generateOpenAICodexImages({...options,outputFormat:requested,fetch:async()=>{
   calls++;return Response.json({data:[{b64_json:fixture.data}]});
  }}), (error:Error)=>{
   assert.match(error.message,new RegExp(`returned ${actual} instead of requested ${requested}`));
   assert.doesNotMatch(error.message,/PRIVATE_PROMPT|signature|test-account/);return true;
  });
  assert.equal(calls,1);
 }
});

test("false server format/MIME declarations and unsupported output formats are rejected", async () => {
 for (const output_format of ["jpeg","svg","__proto__",42,null]) {
  await assert.rejects(generateOpenAICodexImages({...options,fetch:async()=>Response.json({output_format,data:[{b64_json:imageFixtures.png.data}]})}), /declaration.*actual/);
 }
 await assert.rejects(generateOpenAICodexImages({...options,fetch:async()=>Response.json({data:[{b64_json:imageFixtures.webp.data,mime_type:"image/png"}]})}), /MIME declaration/);
 assert.throws(() => decodeGeneratedImage({...imageFixtures.jpeg,mimeType:"image/png"}), /MIME.*signature/);
 await assert.rejects(generateOpenAICodexImages({...options,fetch:async()=>Response.json({data:[{b64_json:Buffer.from("BMxx").toString("base64")}]})}), /unsupported output/);
});

test("response decoding retains base64, unknown signature and output size safety limits", async () => {
 for (const data of ["AAAA%===", "data:image/png;base64,AAAA", "a", "AAAA=AAA", Buffer.from("unknown image").toString("base64")]) {
  await assert.rejects(generateOpenAICodexImages({...options,fetch:async()=>Response.json({data:[{b64_json:data}]})}), /base64|signature/);
 }
 const oversized = Buffer.alloc(32*1024*1024+1);
 oversized.set(Buffer.from(imageFixtures.png.data,"base64").subarray(0,8));
 const data = oversized.toString("base64");
 assert.throws(() => decodeGeneratedImage({data,mimeType:""}), /byte limit|size limit/);
 await assert.rejects(generateOpenAICodexImages({...options,fetch:async()=>Response.json({data:[{b64_json:data}]})}), /byte limit|size limit/);
});

test("alpha metadata checks cover PNG and lossy/lossless WebP without claiming pixel transparency", async () => {
 for (const fixture of [imageFixtures.png,imageFixtures.webp,extendedWebp]) assert.equal(imageAlphaChannel(decodeGeneratedImage(fixture)),true);
 for (const fixture of [opaquePng,opaqueWebp,imageFixtures.jpeg]) assert.equal(imageAlphaChannel(decodeGeneratedImage(fixture)),false);
 const short = {data:Buffer.from([137,80,78,71,13,10,26,10]).toString("base64"),mimeType:"image/png"};
 assert.equal(imageAlphaChannel(decodeGeneratedImage(short)),undefined);
 // An RGBA header with fully opaque pixels still only demonstrates a channel, not transparent pixels.
 const alphaHeader = decodeGeneratedImage(imageFixtures.png); alphaHeader.bytes = alphaHeader.bytes.subarray(0,33);
 assert.equal(imageAlphaChannel(alphaHeader),true);
 for (const [outputFormat,fixture] of [["png",opaquePng],["webp",opaqueWebp]] as const) {
  await assert.rejects(generateOpenAICodexImages({...options,outputFormat,background:"transparent",fetch:async()=>Response.json({data:[{b64_json:fixture.data}]})}), /without an alpha channel/);
 }
});

for (const phase of ["before-rename","after-rename"]) test(`format outputs cancelled ${phase} remove final and temporary files`,async(t)=>{
 const dir = await mkdtemp(path.join(tmpdir(),"formats-cancel-"));
 const output = path.join(dir,".pi","generated-images");
 try {
  for (const fixture of [...Object.values(imageFixtures), animationFixture]) {
   const controller = new AbortController();
   const original = controller.signal.throwIfAborted.bind(controller.signal);
   const mock = t.mock.method(controller.signal,"throwIfAborted",()=>{
    const files = existsSync(output) ? readdirSync(output) : [];
    if (files.some(file=>phase==="before-rename"?file.endsWith(".tmp"):!file.endsWith(".tmp"))) controller.abort();
    original();
   });
   await assert.rejects(saveGeneratedImages(dir,"openai",model.id,[fixture],controller.signal),error=>error.name==="AbortError");
   mock.mock.restore();
   assert.deepEqual(await readdir(output),[]);
  }
 } finally { await rm(dir,{recursive:true,force:true}); }
});
