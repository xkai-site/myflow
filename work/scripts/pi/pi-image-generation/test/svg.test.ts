import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { svgXml, svgImage } from "./advanced-fixtures.mjs";
import { imageFixtures } from "./image-fixtures.mjs";
import { getModel, readTestConfig } from "./config-helpers.ts";
import { validateStaticSvg, SVG_MAX_BYTES, SVG_MAX_DEPTH, SVG_MAX_NODES } from "../src/svg.ts";
import { decodeGeneratedArtifact, decodeGeneratedImage, saveGeneratedImages } from "../src/image-files.ts";
import { normalizeNativeOutput, outputFormatForTask } from "../src/model-config.ts";
import { buildOpenAICodexRequest, generateOpenAICodexImages } from "../src/openai-codex-images.ts";
import { buildAliWanRequest } from "../src/ali-wan-images.ts";
const config=await readTestConfig();
const token=`header.${Buffer.from(JSON.stringify({"https://api.openai.com/auth":{chatgpt_account_id:"offline"}})).toString("base64url")}.signature`;
const baseUrl="https://chatgpt.com/backend-api/codex";
const wrap=(s:string)=>`<svg xmlns="http://www.w3.org/2000/svg">${s}</svg>`;
function model(key="openai-flare-26") {const m=structuredClone(getModel(config,key));m.nativeCapabilities!.svg!.enabled=true;return m;}
function options(extra:object={}) {const m=model();return {apiKey:token,baseUrl,model:m.id,modelConfig:m,prompt:"offline icon",images:[],size:"auto",outputFormat:"svg",...extra};}

test("SVG has explicit per-model experimental generation-only controls and never accepts stream, author, edit or compression",()=>{
 for(const key of ["openai-flare-26","openai-sunburst-26"]) {
  const off=getModel(config,key),on=model(key);
  assert.throws(()=>normalizeNativeOutput(off,{outputFormat:"svg"},"generate"),/disabled/);
  assert.ok(outputFormatForTask(on,"generate")!.options.some(x=>x.value==="svg"&&x.label.includes("实验性")));
  assert.ok(!outputFormatForTask(on,"edit")!.options.some(x=>x.value==="svg"));
  assert.throws(()=>normalizeNativeOutput(on,{outputFormat:"svg"},"edit"),/editing/);
  for(const extra of [{stream:true},{partialImages:0},{partial_images:1},{svg:{model:"invented"}},{output_compression:80},{prompt_rewriter:false},{frameCount:2}]) assert.throws(()=>normalizeNativeOutput(on,{outputFormat:"svg",...extra},"generate"),/not enabled|require/);
 }
 assert.throws(()=>buildAliWanRequest(options()),/not supported/);
 assert.throws(()=>buildOpenAICodexRequest(options({modelConfig:undefined,apiKey:"bad"})),/disabled/);
});

test("SVG strict UTF-8 XML parser accepts static vectors, text, local gradients and nonrecursive clipping",()=>{
 for(const xml of [svgXml,`<?xml version="1.0" encoding="UTF-8"?>${svgXml}`,wrap('<defs><clipPath id="clip"><rect width="4" height="4"/></clipPath></defs><g clip-path="url(#clip)"><circle cx="2" cy="2" r="2"/></g>'),wrap('<text>&lt;script&gt; &amp; &#65;</text>')]) assert.doesNotThrow(()=>validateStaticSvg(Buffer.from(xml)));
 const artifact=decodeGeneratedArtifact(svgImage);assert.equal(artifact.extension,"svg");assert.equal(artifact.mimeType,"image/svg+xml");assert.equal(artifact.kind,"vector");
 assert.deepEqual(artifact.bytes,Buffer.from(svgXml));
 assert.throws(()=>decodeGeneratedImage(svgImage),/signature/);
 assert.throws(()=>decodeGeneratedArtifact({...svgImage,mimeType:"image/png"}),/MIME/);
});

test("SVG rejects DTD/entities, scripts/events, CSS, href, external resources, namespace tricks and active elements",()=>{
 const dangerous=[
  '<!DOCTYPE svg SYSTEM "https://example.test/evil.dtd">'+svgXml,
  '<!DOCTYPE svg [<!ENTITY x "boom">]>'+wrap('<text>&x;</text>'),
  '<?xml-stylesheet href="https://example.test/x.css"?>'+svgXml,
  wrap('<script>alert(1)</script>'),wrap('<g onload="x()"/>'),wrap('<g ONLOAD="x()"/>'),
  wrap('<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">X</div></foreignObject>'),
  wrap('<image href="data:image/png;base64,AAAA"/>'),wrap('<use href="#x"/>'),
  wrap('<path d="M0 0" style="fill:red"/>'),wrap('<style>@import "x";</style>'),
  wrap('<path fill="url(https://example.test/a)"/>'),wrap('<path fill="url(data:text/html,x)"/>'),
  wrap('<path fill="u&#114;l(javascript:alert(1))"/>'),wrap('<path fill="url(#missing)"/>'),
  wrap('<a href="https://example.test">link</a>'),wrap('<animate attributeName="x"/>'),
  '<svg xmlns="http://www.w3.org/1999/xhtml"/>',wrap('<s:path xmlns:s="http://www.w3.org/2000/svg"/>'),
  wrap('<g xmlns="http://evil.test/"/>'),wrap('<g xmlns:x="http://evil.test/" x:href="x"/>'),
  wrap('<g id="same"/><path id="same"/>'),wrap('<g id="bad space"/>'),
  wrap('<defs><clipPath id="c"><g clip-path="url(#c)"/></clipPath></defs>'),
  '<svg xmlns="http://www.w3.org/2000/svg" clip-path="url(#c)"><defs><clipPath id="c"><path d="M0 0h1"/></clipPath></defs></svg>',
  wrap('<g clip-path="url(#c)"><defs><clipPath id="c"><path d="M0 0h1"/></clipPath></defs></g>'),
  wrap('<mask id="m"/>'),wrap('<filter id="f"/>'),wrap('<svg/>'),
  '<svg xmlns="http://www.w3.org/2000/svg"><g></svg>',svgXml+'<svg/>',
  wrap('<text>&unknown;</text>'),wrap('<text><![CDATA[x]]></text>'),
  '<?xml version="1.0" encoding="UTF-16"?>'+svgXml,
 ];
 for(const xml of dangerous) assert.throws(()=>validateStaticSvg(Buffer.from(xml)),/SVG/);
 for(const bytes of [Buffer.from([0xff,0xfe,0x3c,0]),Buffer.from('<svg>\u0000</svg>'),Buffer.from('<svg/>')]) assert.throws(()=>validateStaticSvg(bytes),/SVG/);
});

test("SVG bounds bytes, nodes, depth, attributes and attribute lengths before saving",()=>{
 for(const xml of [wrap(' '.repeat(SVG_MAX_BYTES)),wrap('<g>'.repeat(SVG_MAX_DEPTH)+'</g>'.repeat(SVG_MAX_DEPTH)),wrap('<path/>'.repeat(SVG_MAX_NODES)),wrap('<!---->'.repeat(SVG_MAX_NODES)),wrap(`<path d="${'M0 0 '.repeat(60_000)}"/>`),wrap('<g '+Array.from({length:49},(_,i)=>`a${i}="1"`).join(' ')+'/>')]) assert.throws(()=>validateStaticSvg(Buffer.from(xml)),/SVG/);
});

test("SVG request keeps Codex route, n=1, no author configuration and validates actual XML response without retry",async()=>{
 for(const key of ["openai-flare-26","openai-sunburst-26"]) {
  const m=model(key);let calls=0;
  const o=options({model:m.id,modelConfig:m,fetch:async(url:any,init:any)=>{
   calls++;assert.equal(String(url),`${baseUrl}/images/generations`);assert.equal(init.redirect,"error");
   const body=JSON.parse(init.body);assert.equal(body.output_format,"svg");assert.equal(body.n,1);
   for(const field of ["svg","stream","partial_images","output_compression","prompt_rewriter"]) assert.ok(!(field in body));
   return Response.json({output_format:"svg",data:[{b64_json:svgImage.data,mime_type:"image/svg+xml"}]});
  }});
  const result=await generateOpenAICodexImages(o);assert.deepEqual(result.images,[svgImage]);assert.equal(calls,1);
 }
 for(const payload of [
  {data:[{b64_json:imageFixtures.png.data}]}, {data:[{b64_json:svgImage.data,mime_type:"image/png"}]},
  {data:[{b64_json:Buffer.from(wrap('<script>x()</script>')).toString('base64')}]},
  {output_format:"png",data:[{b64_json:svgImage.data}]}, {data:[{b64_json:svgImage.data},{b64_json:svgImage.data}]}
 ]) {let calls=0;await assert.rejects(generateOpenAICodexImages(options({fetch:async()=>{calls++;return Response.json(payload)}})));assert.equal(calls,1);}
});

test("SVG original XML bytes save atomically as vector, unsafe batches roll back and cancellation cleans both rename phases",async(t)=>{
 const dir=await mkdtemp(path.join(tmpdir(),"svg-output-"));
 try {
  const [entry]=await saveGeneratedImages(dir,"openai","offline",[svgImage]);
  assert.equal(entry.kind,"vector");assert.equal(path.extname(entry.path),".svg");assert.deepEqual(await readFile(entry.path),Buffer.from(svgXml));
  const output=path.dirname(entry.path),before=await readdir(output);
  await assert.rejects(saveGeneratedImages(dir,"openai","offline",[svgImage,{...svgImage,data:Buffer.from(wrap('<script/>')).toString('base64')}]),/SVG/);
  assert.deepEqual(await readdir(output),before);
  for(const phase of ["before","after"]) {
   const abort=new AbortController(),original=abort.signal.throwIfAborted.bind(abort.signal);let checks=0;
   const mock=t.mock.method(abort.signal,"throwIfAborted",()=>{if(++checks===(phase==="before"?3:4))abort.abort();original();});
   await assert.rejects(saveGeneratedImages(dir,"openai","offline",[svgImage],abort.signal),{name:"AbortError"});
   mock.mock.restore();assert.deepEqual(await readdir(output),before);
  }
 } finally {await rm(dir,{recursive:true,force:true});}
});
