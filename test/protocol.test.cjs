'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const {createArenaServer}=require('../server/http.cjs');
const meta={'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'modern-test',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}};
async function fixture(t){const app=createArenaServer({dbPath:':memory:'});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+app.server.address().port+'/mcp';t.after(()=>app.close());return {app,url};}
test('modern MCP discovery, tools, results, header matching, and version errors',async t=>{
  const {url}=await fixture(t);
  const send=async(method,params={},override={})=>{const headers={'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2026-07-28','Mcp-Method':method,...(method==='tools/call'?{'Mcp-Name':params.name}:{}),...override};const response=await fetch(url,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:{...params,_meta:meta}})});return {status:response.status,data:await response.json()};};
  const discovery=await send('server/discover');assert.equal(discovery.status,200);assert.equal(discovery.data.result.resultType,'complete');assert.ok(discovery.data.result.supportedVersions.includes('2025-11-25'));
  const listed=await send('tools/list');assert.equal(listed.data.result.tools.length,6);assert.equal(listed.data.result.resultType,'complete');
  const result=await send('tools/call',{name:'get_rules',arguments:{}});assert.equal(result.data.result.isError,false);assert.equal(result.data.result.resultType,'complete');
  const mismatch=await send('tools/call',{name:'get_rules',arguments:{}},{'Mcp-Name':'submit_action'});assert.equal(mismatch.status,400);assert.equal(mismatch.data.error.code,-32020);
  const missing=await send('tools/list',{}, {'Mcp-Method':''});assert.equal(missing.data.error.code,-32020);
  const unknown=await send('unsupported/method');assert.equal(unknown.status,404);assert.equal(unknown.data.error.code,-32601);
  const unsupported=await send('tools/list',{}, {'MCP-Protocol-Version':'2099-01-01'});assert.equal(unsupported.data.error.code,-32022);
});
test('stdio bridge forwards legacy and modern requests without leaking diagnostics into stdout',async t=>{
  const {url}=await fixture(t);let handler,output='';const context={require:name=>name==='node:readline'?{createInterface:()=>({on:(event,fn)=>{handler=fn;}})}:require(name),process:{env:{ARENA_URL:url},stdin:{},stdout:{write:text=>output+=text},stderr:{write() {}}},URL,Buffer,fetch,AbortSignal};vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(__dirname,'../bridge.cjs'),'utf8'),context);
  await handler(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25'}}));
  await handler(JSON.stringify({jsonrpc:'2.0',id:2,method:'server/discover',params:{_meta:meta}}));
  const lines=output.trim().split('\n').map(JSON.parse);assert.equal(lines.length,2);assert.equal(lines[0].result.protocolVersion,'2025-11-25');assert.equal(lines[1].result.resultType,'complete');
});
