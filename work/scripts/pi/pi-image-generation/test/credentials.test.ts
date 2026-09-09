import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readImageConfig } from '../src/model-config.ts';
import { saveImageKey, deleteImageKey, readSavedKey, getCredentialPath, resolveImageAuth, getAccountStatus, requireImageEndpoint } from '../src/credentials.ts';
import { SecretInputState } from '../src/secret-input.ts';
import { sanitizeError } from '../src/http.ts';
const config = await readImageConfig();

test('saved Key persists, overrides fallback without mixing headers, deletion restores fallback', async () => {
 const dir = await mkdtemp(path.join(tmpdir(), 'image-auth-'));
 let calls = 0;
 const registry = {
  getProvider: () => ({baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'}),
  getProviderAuthStatus: () => ({configured:true}),
  getProviderAuth: async () => { calls++; return {auth:{apiKey:'legacy-key',headers:{'x-test':'legacy'}}}; }
 };
 try {
  const provider = config.providers[1];
  assert.equal((await resolveImageAuth(provider,dir,registry,{})).apiKey,'legacy-key');
  await saveImageKey(dir,provider.id,'saved-key');
  assert.equal(await readSavedKey(dir,provider.id),'saved-key');
  const resolved = await resolveImageAuth(provider,dir,registry,{PI_IMAGE_QWEN_API_KEY:'env-key'});
  assert.equal(resolved.apiKey,'saved-key'); assert.equal(resolved.headers,undefined); assert.equal(calls,1);
  await deleteImageKey(dir,provider.id);
  assert.equal((await resolveImageAuth(provider,dir,registry,{PI_IMAGE_QWEN_API_KEY:'env-key'})).apiKey,'env-key');
  assert.equal((await resolveImageAuth(provider,dir,registry,{})).apiKey,'legacy-key');
  await Promise.all(['a','b','c'].map(id=>saveImageKey(dir,id,`${id}-key`)));
  for (const id of ['a','b','c']) assert.equal(await readSavedKey(dir,id),`${id}-key`);
  assert.deepEqual((await readdir(path.dirname(getCredentialPath(dir)))).sort(),['auth.json']);
  await writeFile(getCredentialPath(dir),'{broken secret}');
  await assert.rejects(saveImageKey(dir,'qwen','new-key'));
  assert.equal(await readFile(getCredentialPath(dir),'utf8'),'{broken secret}');
  assert.equal((await getAccountStatus(provider,dir,registry,{})).configured,false);
  await assert.rejects(resolveImageAuth(provider,dir,registry,{}),/no fallback/);
 } finally { await rm(dir,{recursive:true,force:true}); }
});
test('OpenAI resolves fresh each request and never creates image credential file',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'image-oauth-')); let count=0;
 const registry={getProvider:()=>({baseUrl:'https://chatgpt.com/backend-api'}),getProviderAuthStatus:()=>({configured:true}),getProviderAuth:async()=>({auth:{apiKey:`token-${++count}`}})};
 try {
  assert.equal((await resolveImageAuth(config.providers[0],dir,registry,{})).apiKey,'token-1');
  assert.equal((await resolveImageAuth(config.providers[0],dir,registry,{})).apiKey,'token-2');
  assert.deepEqual(await readdir(dir),[]);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('official endpoint boundary and explicit secret redaction',()=>{
 for(const url of ['http://chatgpt.com/backend-api','https://evil.test/backend-api','https://user:pass@chatgpt.com/backend-api','https://chatgpt.com/backend-api?token=x']) assert.throws(()=>requireImageEndpoint(url,'openai-codex-images'));
 assert.equal(sanitizeError('upstream echoed opaque-secret',['opaque-secret']),'upstream echoed [redacted]');
});
test('secret state supports split paste, rejects controls, cancels and never exposes value in state labels',()=>{
 const state=new SecretInputState();
 state.feed('\x1b[20');state.feed('0~synthetic-');state.feed('key\n\x1b[2');state.feed('01~');
 assert.equal(state.entered,true);assert.equal(state.submit(),'synthetic-key');
 state.clear();assert.equal(state.entered,false);assert.equal(state.submit(),undefined);
 state.clear();state.feed('valid');state.feed('\x00');assert.equal(state.submit(),undefined);
});
