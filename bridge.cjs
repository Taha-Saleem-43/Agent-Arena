'use strict';
// stdio MCP adapter for desktop/CLI clients. It forwards to the SAME referee.
const readline=require('node:readline');
const endpoint=new URL(process.env.ARENA_URL||'http://127.0.0.1:4173/mcp');
if(endpoint.protocol!=='https:'&&!(endpoint.protocol==='http:'&&['127.0.0.1','localhost'].includes(endpoint.hostname)))throw new Error('Use HTTPS for remote arenas.');
const input=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
input.on('line',async line=>{
  let request;
  try{
    if(Buffer.byteLength(line)>16384)throw new Error('MCP request too large.');
    request=JSON.parse(line);
    const version=request.params?._meta?.['io.modelcontextprotocol/protocolVersion'];
    const headers={'Content-Type':'application/json',Accept:'application/json, text/event-stream'};
    if(version){headers['MCP-Protocol-Version']=version;headers['Mcp-Method']=request.method;if(request.method==='tools/call'){const name=request.params.name;headers['Mcp-Name']=/^[\x21-\x7e]+$/.test(name)&&!name.startsWith('=?base64?')?name:'=?base64?'+Buffer.from(name).toString('base64')+'?=';}}
    const response=await fetch(endpoint,{method:'POST',headers,body:JSON.stringify(request),signal:AbortSignal.timeout(30000)});
    if(response.status===202)return;
    const data=await response.json();
    if(!response.ok&&!data.jsonrpc)throw new Error(data.error?.message||'Arena connection failed.');
    process.stdout.write(JSON.stringify(data)+'\n');
  }catch(e){if(request?.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32603,message:e.message}})+'\n');else process.stderr.write('Arena bridge: invalid notification or connection error.\n');}
});
