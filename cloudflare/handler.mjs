import { EventEmitter } from 'node:events';
import { timingSafeEqual } from 'node:crypto';
import core from '../server/store-core.cjs';
import mcpModule from '../server/mcp.cjs';
import adapter from './sql-adapter.cjs';

const {ArenaStore,ArenaError}=core;
const LEGACY=['2025-03-26','2025-06-18','2025-11-25'];
const MODERN='2026-07-28',VERSIONS=[MODERN,...LEGACY];
const headers={
  'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
  'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
};
const json=(status,data)=>new Response(JSON.stringify(data),{status,headers:{...headers,'Content-Type':'application/json; charset=utf-8'}});
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const decodeHeader=value=>typeof value==='string'&&value.startsWith('=?base64?')&&value.endsWith('?=')?Buffer.from(value.slice(9,-2),'base64').toString('utf8'):value;
async function readBody(request){
  if(!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))throw new ArenaError('unsupported_media_type','Use application/json.',415);
  if(!request.body)throw new ArenaError('invalid_json','JSON body required.');
  const reader=request.body.getReader(),chunks=[];let size=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>16384){await reader.cancel();throw new ArenaError('body_too_large','Request body exceeds 16 KB.',413);}chunks.push(value);}}finally{reader.releaseLock();}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new ArenaError('invalid_json','Request body must be valid JSON.');}
}

export class Coordinator {
  constructor(ctx,env){
    this.ctx=ctx;this.env=env;this.changes=new EventEmitter();this.changes.setMaxListeners(220);
    this.store=new ArenaStore(adapter.durableSqlAdapter(ctx.storage),{onChange:id=>this.changes.emit(id)});
    this.mcp=mcpModule.createMcp(this.store,this.changes);this.buckets=new Map();this.streams=new Set();
  }
  async scheduleAlarm(){
    const previous=await this.ctx.storage.getAlarm();
    const row=this.store.db.prepare("SELECT MIN(json_extract(state,'$.deadline')) AS deadline FROM matches WHERE json_extract(state,'$.phase')='active'").get();
    const next=row?.deadline?Math.max(Date.now()+1,row.deadline):null;
    if(next!==previous){if(next)await this.ctx.storage.setAlarm(next);else if(previous!==null)await this.ctx.storage.deleteAlarm();}
  }
  async alarm(){this.store.sweep();await this.scheduleAlarm();}
  async fetch(request){
    try{
      const url=new URL(request.url),origin=request.headers.get('origin');
      if(origin&&origin!==url.origin&&origin!==this.env.ARENA_PUBLIC_ORIGIN)throw new ArenaError('invalid_origin','Origin is not allowed.',403);
      const now=Date.now(),ip=request.headers.get('cf-connecting-ip')||'local';
      for(const [key,bucket] of this.buckets)if(now-bucket.start>120000)this.buckets.delete(key);
      if(this.buckets.size>=10000&&!this.buckets.has(ip))throw new ArenaError('busy','Connection capacity reached.',429);
      const bucket=this.buckets.get(ip)||{start:now,count:0,creates:0};if(now-bucket.start>=60000){bucket.start=now;bucket.count=0;bucket.creates=0;}bucket.count++;this.buckets.set(ip,bucket);
      if(bucket.count>360)throw new ArenaError('rate_limited','Too many requests. Try again in a minute.',429);
      const response=await this.route(request,url,bucket);
      await this.scheduleAlarm();return response;
    }catch(error){
      // A rejected late action may still have committed expired turns. Persist their next alarm too.
      try{await this.scheduleAlarm();}catch{}
      const known=error instanceof ArenaError;
      return json(known?error.status:500,{error:{code:known?error.code:'internal_error',message:known?error.message:'An internal server error occurred.'}});
    }
  }
  async route(request,url,bucket){
    const path=url.pathname;
    if(path==='/api/health'&&request.method==='GET')return json(200,{ok:true,version:'0.3.0',model_api_calls:false,public_origin:url.origin,creation_requires_key:true,storage_mode:'persistent',hosting:'cloudflare',configured:typeof this.env.ARENA_ADMIN_TOKEN==='string'&&this.env.ARENA_ADMIN_TOKEN.length>=32,mcp_path:'/mcp',protocol_versions:VERSIONS});
    if(path==='/mcp'&&request.method!=='POST')return new Response('Use Streamable HTTP POST.',{status:405,headers:{...headers,Allow:'POST'}});
    if(path==='/api/matches'&&request.method==='POST'){
      if(!this.env.ARENA_ADMIN_TOKEN||this.env.ARENA_ADMIN_TOKEN.length<32)throw new ArenaError('not_configured','The host must configure its private creation key.',503);
      if(!equal(request.headers.get('authorization'),'Bearer '+this.env.ARENA_ADMIN_TOKEN))throw new ArenaError('unauthorized','A host creation key is required.',401);
      const input=await readBody(request);if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length)throw new ArenaError('invalid_arguments','Create match accepts an empty object.');
      if(++bucket.creates>10)throw new ArenaError('rate_limited','Match creation limit reached. Try again in a minute.',429);
      return json(201,this.store.create());
    }
    if(path==='/mcp'&&request.method==='POST')return this.rpc(request,await readBody(request));
    const match=path.match(/^\/api\/matches\/([a-f0-9-]{36})(?:\/(events|replay))?$/);
    if(match&&request.method==='GET'){
      const [,id,kind]=match;
      if(kind==='replay')return json(200,this.store.replay(id));
      if(kind==='events')return this.events(request,id);
      return json(200,{match:this.store.snapshot(id),events:this.store.events(id)});
    }
    return json(404,{error:{code:'not_found',message:'Route not found.'}});
  }
  async rpc(request,rpc){
    if(!rpc||rpc.jsonrpc!=='2.0'||typeof rpc.method!=='string'||Array.isArray(rpc)||(rpc.id!==undefined&&typeof rpc.id!=='string'&&typeof rpc.id!=='number'))return json(400,{jsonrpc:'2.0',id:null,error:{code:-32600,message:'Invalid JSON-RPC request.'}});
    const reply=(status,result)=>json(status,{jsonrpc:'2.0',id:rpc.id,result});
    const error=(status,code,message,data)=>json(status,{jsonrpc:'2.0',id:rpc.id??null,error:{code,message,...(data?{data}:{})}});
    const accept=request.headers.get('accept')||'';if(!accept.includes('application/json')||!accept.includes('text/event-stream'))return error(406,-32600,'Accept must include application/json and text/event-stream.');
    const version=request.headers.get('mcp-protocol-version'),meta=rpc.params?._meta,bodyVersion=meta?.['io.modelcontextprotocol/protocolVersion'];
    const modern=!!bodyVersion||version===MODERN;
    if(version&&!VERSIONS.includes(version)||bodyVersion&&!VERSIONS.includes(bodyVersion))return error(400,-32022,'Unsupported protocol version',{supported:VERSIONS,requested:bodyVersion||version});
    if(modern&&(version!==bodyVersion||request.headers.get('mcp-method')!==rpc.method||(rpc.method==='tools/call'&&decodeHeader(request.headers.get('mcp-name'))!==rpc.params?.name)))return error(400,-32020,'Required MCP headers are missing or do not match the body.');
    if(modern&&(bodyVersion!==MODERN||!meta['io.modelcontextprotocol/clientCapabilities']||typeof meta['io.modelcontextprotocol/clientCapabilities']!=='object'||Array.isArray(meta['io.modelcontextprotocol/clientCapabilities'])))return error(400,-32602,'Modern requests require protocolVersion and clientCapabilities metadata.');
    if(rpc.id===undefined){if(!['notifications/initialized','notifications/cancelled'].includes(rpc.method))return error(400,-32600,'Unsupported notification.');return new Response(null,{status:202,headers});}
    let result;
    if(rpc.method==='server/discover')result={supportedVersions:VERSIONS,capabilities:{tools:{}},_meta:{'io.modelcontextprotocol/serverInfo':{name:'agent-arena',version:'0.3.0'}},instructions:'Join with a private seat invitation. Use observations, legal actions, and wait_for_turn. No model API calls are made by the arena.'};
    else if(rpc.method==='initialize'&&!modern)result={protocolVersion:LEGACY.includes(rpc.params?.protocolVersion)?rpc.params.protocolVersion:LEGACY.at(-1),capabilities:{tools:{}},serverInfo:{name:'agent-arena',version:'0.3.0'},instructions:'Use get_rules, join_match, get_observation, submit_action, and wait_for_turn. Keep seat tokens private.'};
    else if(rpc.method==='ping')result={};
    else if(rpc.method==='tools/list')result={tools:this.mcp.tools};
    else if(rpc.method==='tools/call'){
      try{const data=await this.mcp.call(rpc.params?.name,rpc.params?.arguments||{},request.signal);result={content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data,isError:false};}
      catch(e){if(!(e instanceof ArenaError))throw e;result={content:[{type:'text',text:JSON.stringify({code:e.code,message:e.message})}],isError:true};}
    }else return error(modern?404:200,-32601,'Method not found.');
    if(modern)result={resultType:'complete',...result};return reply(200,result);
  }
  events(request,id){
    this.store.snapshot(id);if(this.streams.size>=100)throw new ArenaError('busy','Spectator connection limit reached.',429);
    const encoder=new TextEncoder();let cleanup=()=>{};
    const stream=new ReadableStream({
      start:controller=>{
        let closed=false,heartbeat;
        cleanup=()=>{if(closed)return;closed=true;clearInterval(heartbeat);this.changes.off(id,send);request.signal.removeEventListener('abort',abort);this.streams.delete(cleanup);};
        const abort=()=>{cleanup();try{controller.close();}catch{}};
        const send=()=>{
          if(closed)return;
          try{const match=this.store.snapshot(id);controller.enqueue(encoder.encode(`id: ${match.version}\nevent: state\ndata: ${JSON.stringify({match,events:this.store.events(id)})}\n\n`));if(match.phase==='finished')abort();}
          catch{abort();}
        };
        heartbeat=setInterval(()=>{if(!closed)try{controller.enqueue(encoder.encode(': heartbeat\n\n'));}catch{abort();}},15000);
        this.streams.add(cleanup);this.changes.on(id,send);request.signal.addEventListener('abort',abort,{once:true});send();if(request.signal.aborted)abort();
      },
      cancel(){cleanup();}
    });
    return new Response(stream,{headers:{...headers,'Content-Type':'text/event-stream','X-Accel-Buffering':'no'}});
  }
}
