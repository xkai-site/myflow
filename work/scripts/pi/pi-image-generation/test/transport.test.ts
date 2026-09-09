import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateAliWanImages } from '../src/ali-wan-images.ts';
import { saveGeneratedImages } from '../src/image-files.ts';
const image={data:Buffer.from([137,80,78,71,13,10,26,10]).toString('base64'),mimeType:'image/png'};
test('upstream rejection redacts opaque Key and disables redirects',async()=>{
 await assert.rejects(generateAliWanImages({apiKey:'opaque-secret',baseUrl:'https://token-plan.cn-beijing.maas.aliyuncs.com',prompt:'cat',model:'test',size:'2K',images:[],fetch:async(_url,options)=>{
  assert.equal(options?.redirect,'error');return Response.json({message:'invalid opaque-secret'},{status:401});
 }}),(error:Error)=>error.message.includes('[redacted]')&&!error.message.includes('opaque-secret'));
});
test('atomic image output: unique files, validation rollback and cancellation',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'image-files-'));
 try{
  const first=await saveGeneratedImages(dir,'provider','model',[image]);
  const second=await saveGeneratedImages(dir,'provider','model',[image]);
  assert.notEqual(first[0].path,second[0].path);
  assert.equal((await readFile(first[0].path)).length,8);
  await assert.rejects(saveGeneratedImages(dir,'provider','model',[image,{...image,mimeType:'image/jpeg'}]),/MIME/);
  const controller=new AbortController();controller.abort();
  await assert.rejects(saveGeneratedImages(dir,'provider','model',[image],controller.signal));
  const files=await readdir(path.join(dir,'.pi','generated-images'));
  assert.equal(files.length,2);assert.equal(files.some(f=>f.endsWith('.tmp')),false);
 }finally{await rm(dir,{recursive:true,force:true});}
});
