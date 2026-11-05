import assert from "node:assert/strict";
import test from "node:test";
import { normalizeImageOutput, validateImageConfig } from "../src/model-config.ts";
import { parseImageCommand, resolveImageCommand, usageText } from "../src/command.ts";
import { buildOpenAICodexRequest, generateOpenAICodexImages } from "../src/openai-codex-images.ts";
import { buildAliWanRequest } from "../src/ali-wan-images.ts";
import { parameterItems, policyLabel, selectParameters } from "../src/tui-options.ts";
import { getModel, readTestConfig } from "./config-helpers.ts";
import { imageFixtures } from "./image-fixtures.mjs";

const config = await readTestConfig();
const model = getModel(config, "openai-flare-26");
const apiKey = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url")}.signature`;
const baseUrl = "https://chatgpt.com/backend-api/codex";

test("output policies are optional, strict, independently configured and leave legacy/Wan unchanged", () => {
 for (const key of ["openai-flare-26", "openai-sunburst-26", "openai-flare", "openai-sunburst"]) {
  const selected = getModel(config, key);
  assert.deepEqual(selected.outputFormat, { default: "png", options: [{value:"png",label:"PNG"},{value:"jpeg",label:"JPEG"},{value:"webp",label:"WebP"}] });
  assert.deepEqual(selected.background, { default: "auto", options: [{value:"auto",label:"自动"},{value:"opaque",label:"不透明"},{value:"transparent",label:"透明"}] });
 }
 const old = structuredClone(config);
 for (const selected of old.models) { delete selected.outputFormat; delete selected.background; }
 assert.doesNotThrow(() => validateImageConfig(old));
 for (const key of ["wan", "wan-pro", "openai"]) {
  const selected = getModel(config, key);
  assert.equal(selected.background, undefined); assert.equal(selected.outputFormat, undefined);
  for (const value of [{outputFormat:"png"}, {background:"auto"}]) assert.throws(() => normalizeImageOutput(selected, value), /not supported/);
 }
 const independent = structuredClone(config);
 const restricted = getModel(independent, "openai-flare-26");
 restricted.outputFormat!.options = restricted.outputFormat!.options.filter(o => o.value === "png");
 assert.doesNotThrow(() => validateImageConfig(independent));
 assert.throws(() => normalizeImageOutput(restricted, {outputFormat:"webp"}), /--format/);
 assert.equal(normalizeImageOutput(getModel(independent,"openai-sunburst-26"), {outputFormat:"webp"}).outputFormat,"webp");
});

test("output schema rejects unknown fields, values, invalid defaults and incompatible default pairs", () => {
 const mutations = [
  (m:any) => { m.outputFormat.extra = true; },
  (m:any) => { m.background.options[0].extra = true; },
  (m:any) => { m.outputFormat.options.push({value:"gif",label:"GIF"}); },
  (m:any) => { m.background.options.push({value:"white",label:"White"}); },
  (m:any) => { m.outputFormat.default = "jpg"; },
  (m:any) => { m.background.default = "missing"; },
  (m:any) => { m.background.default = "transparent"; m.outputFormat.default = "jpeg"; },
 ];
 for (const mutate of mutations) {
  const next = structuredClone(config); mutate(getModel(next,"openai-flare-26"));
  assert.throws(() => validateImageConfig(next), /background|outputFormat/);
 }
 for (const key of ["background", "outputFormat"] as const) {
  const next = structuredClone(config); getModel(next,"wan")[key] = structuredClone(model[key]);
  assert.throws(() => validateImageConfig(next), /adapter/);
 }
 const next = structuredClone(config);
 getModel(next,"openai-flare-26").background!.default = "transparent";
 assert.doesNotThrow(() => validateImageConfig(next)); // implicit/default PNG supports alpha
});

test("RPC format/background syntax, missing and duplicate values, -- termination and joint options", () => {
 for (const separator of [" ", "="]) {
  const parsed = parseImageCommand(`/image ${model.key} --size 1536x864 --quality=max --complexity low --format${separator}webp --background${separator}transparent -- --format=jpeg cat`, config);
  assert.equal(parsed.outputFormat,"webp"); assert.equal(parsed.background,"transparent");
  assert.equal(parsed.prompt,"--format=jpeg cat");
  const resolved = resolveImageCommand(parsed, model, 0, config);
  assert.equal(resolved.quality,"max"); assert.equal(resolved.complexity,"low"); assert.equal(resolved.size,"1536x864");
 }
 for (const flag of ["--format", "--background"]) {
  for (const suffix of ["", "=", " --quality high"]) assert.throws(() => parseImageCommand(`/image ${flag}${suffix}`,config), /requires a value/);
  const value = flag === "--format" ? "png" : "auto";
  assert.throws(() => parseImageCommand(`/image ${flag} ${value} ${flag}=${value} cat`,config), /must not be repeated/);
 }
 const defaults = resolveImageCommand(parseImageCommand(`/image ${model.key} cat`,config), model,0,config);
 assert.equal(defaults.outputFormat,"png"); assert.equal(defaults.background,"auto");
 assert.throws(() => resolveImageCommand({prompt:"cat",help:false,outputFormat:"jpg"},model,0,config), /--format.*png.*jpeg.*webp/);
 assert.throws(() => resolveImageCommand({prompt:"cat",help:false,background:"white"},model,0,config), /--background/);
 assert.match(usageText(config), /--format VALUE/); assert.match(usageText(config), /--background VALUE/);
});

test("all configured output combinations share validation across generation and editing", () => {
 for (const selected of config.models.filter(m => m.outputFormat)) for (const count of [0,1]) {
  for (const outputFormat of ["png","jpeg","webp"]) for (const background of ["auto","opaque","transparent"]) {
   const parsed = {prompt:"cat",help:false,outputFormat,background};
   if (outputFormat === "jpeg" && background === "transparent") {
    assert.throws(() => resolveImageCommand(parsed,selected,count,config), /transparent.*jpeg/);
   } else {
    assert.deepEqual(normalizeImageOutput(selected,parsed), {background,outputFormat});
    assert.equal(resolveImageCommand(parsed,selected,count,config).outputFormat,outputFormat);
   }
  }
 }
});

test("mock HTTP passes allowed output parameters to both endpoints without retries", async () => {
 for (const selected of config.models.filter(m => m.outputFormat)) for (const images of [[],[imageFixtures.png]]) {
  for (const outputFormat of ["png","jpeg","webp"] as const) for (const background of ["auto","opaque","transparent"]) {
   if (outputFormat === "jpeg" && background === "transparent") continue;
   const command = resolveImageCommand({prompt:"cat",help:false,outputFormat,background},selected,images.length,config);
   let calls = 0;
   const result = await generateOpenAICodexImages({...command,apiKey,baseUrl,images,fetch:async(url,init)=>{
    calls++;
    assert.equal(String(url), `${baseUrl}/images/${images.length ? "edits" : "generations"}`);
    const body = JSON.parse(init!.body as string);
    assert.equal(body.model,selected.id); assert.equal(body.background,background);
    assert.equal(body.output_format,outputFormat === "png" ? undefined : outputFormat);
    assert.equal("outputFormat" in body,false); assert.equal("format" in body,false);
    return Response.json({output_format:outputFormat,data:[{b64_json:imageFixtures[outputFormat].data}]});
   }});
   assert.equal(calls,1); assert.equal(result.images[0].mimeType,imageFixtures[outputFormat].mimeType);
  }
 }
});

test("unsupported options and incompatible pairs cannot start HTTP; old bodies remain compatible", async () => {
 for (const images of [[],[imageFixtures.png]]) {
  for (const values of [{outputFormat:"jpeg",background:"transparent"},{outputFormat:"gif"},{background:"white"}]) {
   await assert.rejects(generateOpenAICodexImages({apiKey,baseUrl,images,model:model.id,modelConfig:model,prompt:"cat",size:"auto",...values,fetch:async()=>assert.fail("Invalid options fetched")}), /--format|--background/);
  }
 }
 assert.throws(() => buildOpenAICodexRequest({apiKey,baseUrl,images:[],model:"unconfigured-id",modelConfig:model,prompt:"cat",size:"auto",outputFormat:"webp"}), /configuration.*match/);
 assert.throws(() => buildOpenAICodexRequest({apiKey,baseUrl,images:[],model:model.id,prompt:"cat",size:"auto",outputFormat:"webp"}), /--format.*not supported/);
 const legacy = getModel(config,"openai");
 for (const values of [{outputFormat:"png"},{background:"auto"}]) {
  assert.throws(() => resolveImageCommand({prompt:"cat",help:false,...values},legacy,0,config), /not supported/);
  assert.throws(() => buildOpenAICodexRequest({apiKey,baseUrl,images:[],model:legacy.id,modelConfig:legacy,prompt:"cat",size:"auto",...values}), /not supported/);
 }
 const request = buildOpenAICodexRequest({apiKey,baseUrl,images:[],model:legacy.id,prompt:"cat",size:"auto"});
 assert.deepEqual(request.body,{prompt:"cat",background:"auto",model:legacy.id,n:1,quality:"auto",size:"auto"});
 const wan = getModel(config,"wan");
 const command = resolveImageCommand({prompt:"cat",help:false},wan,0,config);
 const wanRequest = buildAliWanRequest({...command,apiKey,baseUrl:"https://token-plan.cn-beijing.maas.aliyuncs.com",images:[]});
 assert.deepEqual(wanRequest.body.parameters,{size:"2K",n:1,watermark:false,enable_sequential:false});
});

test("TUI filters invalid combinations in both selection orders and preserves other values", async () => {
 for (const jpegFirst of [true,false]) {
  const actions = jpegFirst ? ["outputFormat","jpeg","background","opaque","submit"] : ["background","transparent","outputFormat","webp","submit"];
  let index = 0;
  const result = await selectParameters({ui:{select:async(title,labels)=>{
   const action = actions[index++];
   if (title.endsWith(" - 参数")) return labels[parameterItems(model,"generate",{size:"auto"}).findIndex(o=>o.key===action)];
   if (title === "背景" && jpegFirst) assert.ok(!labels.some(l=>l === policyLabel(model.background!,"transparent")));
   if (title === "输出格式" && !jpegFirst) assert.ok(!labels.some(l=>l === policyLabel(model.outputFormat!,"jpeg")));
   return labels.find(l=>l===policyLabel(title==="背景"?model.background!:model.outputFormat!,action));
  }}},model,"generate");
  assert.equal(index,actions.length);
  assert.deepEqual(result,{size:"auto",quality:"auto",complexity:"high",outputFormat:jpegFirst?"jpeg":"webp",background:jpegFirst?"opaque":"transparent"});
 }
});
