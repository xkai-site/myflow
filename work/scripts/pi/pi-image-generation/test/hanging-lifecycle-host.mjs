// Child-process-only probe: intentionally never resolves the mocked HTTP operation.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSdkUrl, siblingEntry } from './sdk.mjs';

const sdk=resolveSdkUrl({candidate:process.argv[2]});
const phase=process.argv[3];assert.ok(['fetch','body'].includes(phase));
const {createJiti}=createRequire(sdk)('jiti');
const jiti=createJiti(import.meta.url,{moduleCache:false,fsCache:false,alias:{
 '@earendil-works/pi-coding-agent':fileURLToPath(sdk),
 '@earendil-works/pi-ai':siblingEntry(sdk,'@earendil-works/pi-ai'),
 '@earendil-works/pi-tui':siblingEntry(sdk,'@earendil-works/pi-tui'),
}});
const dir=await mkdtemp(path.join(tmpdir(),'image-permanent-hang-'));
process.env.PI_CODING_AGENT_DIR=dir;
const oldFetch=globalThis.fetch;
let calls=0,entered=false,requestSignal,loader,doneCount=0,completed=false;
const notices=[],entries=[];
const never=new Promise(()=>{});
globalThis.fetch=async(_url,request)=>{
 calls++;entered=true;requestSignal=request.signal;
 if(phase==='fetch')return never;
 const response=Response.json({});response.arrayBuffer=()=>never;return response;
};
try {
 const {default:extension}=await jiti.import('../extensions/index.ts');
 const {initTheme}=await import(sdk);initTheme('dark',false);
 const {theme}=await import(new URL('./modes/interactive/theme/theme.js',sdk));
 const {getKeybindings}=await jiti.import('@earendil-works/pi-tui');
 const token=`header.${Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'offline'}})).toString('base64url')}.signature`;
 let handler;
 const pi={registerEntryRenderer(){},registerCommand(_name,c){handler=c.handler},on(){},appendEntry(_type,data){entries.push(data)}};
 const ctx={mode:'tui',cwd:dir,isIdle:()=>true,modelRegistry:{
  getProvider:id=>id==='openai-codex'?{baseUrl:'https://chatgpt.com/backend-api/codex'}:undefined,
  getProviderAuthStatus:()=>({configured:true}),getProviderAuth:async()=>({auth:{apiKey:token}}),
 },ui:{theme,notify:(text,type)=>notices.push({text,type}),editor:async()=> 'offline',
  select:async(title,options)=>options[0],
  custom:factory=>new Promise(resolve=>{loader=factory({terminal:{columns:80},requestRender(){}},theme,getKeybindings(),value=>{doneCount++;loader.dispose();resolve(value)})}),
 }};
 await extension(pi);
 const pending=handler('',ctx);pending.then(()=>{completed=true},error=>assert.fail(error));
 for(let i=0;i<2000&&!entered;i++)await new Promise(setImmediate);
 assert.equal(entered,true);loader.handleInput('\x1b');
 for(let i=0;i<2000&&!notices.some(n=>n.text.startsWith('已取消图片生成'));i++)await new Promise(setImmediate);
 assert.equal(doneCount,1);assert.equal(requestSignal.aborted,true);assert.equal(completed,false);
 await extension(pi); // An extension reload must retain the process-wide execution lock.
 for(let i=0;i<5;i++) {
  await handler('',ctx);await new Promise(resolve=>setTimeout(resolve,10));
  assert.match(notices.at(-1).text,/底层操作尚未结束.*重启/);
  assert.match(notices.at(-1).text,/reload.*不会解除/);
 }
 assert.equal(calls,1);assert.equal(entries.length,0);assert.equal(doneCount,1);assert.equal(completed,false);
 assert.equal(notices.filter(n=>n.type==='error').length,0);
 assert.deepEqual(await readdir(dir),[]);
 console.log(`permanent-hang safety passed: ${phase}`);
} finally {
 globalThis.fetch=oldFetch;loader?.dispose();await rm(dir,{recursive:true,force:true});
}
// No process.exit(): disposed loaders and unresolved Promises must not keep Node alive.
