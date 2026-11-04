'use strict';
const http=require('node:http');
const {readFileSync}=require('node:fs');
const path=require('node:path');
const {timingSafeEqual}=require('node:crypto');
const {EventEmitter}=require('node:events');
const {ArenaStore,ArenaError}=require('./store.cjs');
const {createMcp}=require('./mcp.cjs');
const LEGACY=['2025-03-26','2025-06-18','2025-11-25'];
const MODERN='2026-07-28', VERSIONS=[MODERN,...LEGACY];
function decodeHeader(value){if(typeof value!=='string')return value;if(value.startsWith('=?base64?')&&value.endsWith('?='))return Buffer.from(value.slice(9,-2),'base64').toString('utf8');return value;}
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));}
function body(req){return new Promise((resolve,reject)=>{let size=0,parts=[],tooLarge=false;req.on('data',chunk=>{size+=chunk.length;if(size>16384){tooLarge=true;parts=[];}else if(!tooLarge)parts.push(chunk);});req.on('end',()=>{if(tooLarge)return reject(new ArenaError('body_too_large','Request body exceeds 16 KB.',413));try{resolve(JSON.parse(Buffer.concat(parts).toString('utf8')));}catch{reject(new ArenaError('invalid_json','Request body must be valid JSON.'));}});req.on('error',reject);});}
function createArenaServer(options={}){
  const changes=new EventEmitter();changes.setMaxListeners(220);
  const publicOrigin=options.publicOrigin||process.env.ARENA_PUBLIC_ORIGIN||null;
  const adminToken=options.adminToken||process.env.ARENA_ADMIN_TOKEN||null;
  if(publicOrigin&&(!publicOrigin.startsWith('https://')||!adminToken||adminToken.length<32))throw new Error('Public mode requires an HTTPS ARENA_PUBLIC_ORIGIN and ARENA_ADMIN_TOKEN of at least 32 characters.');
  const store=options.store||new ArenaStore(options.dbPath||process.env.ARENA_DB||path.join(__dirname,'../data/arena.sqlite'),{turnMs:options.turnMs||120000,onChange:id=>changes.emit(id)});
  // Preserve the event hook even when a test supplies the store.
  store.onChange=id=>changes.emit(id);
  const mcp=createMcp(store,changes),buckets=new Map(),streams=new Set();
  const assets={'/':['index.html','text/html'],'/index.html':['index.html','text/html'],'/style.css':['style.css','text/css'],'/arena.css':['arena.css','text/css'],'/game.js':['game.js','text/javascript']};
  let closing=false;
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const controller=new AbortController();res.on('close',()=>{if(!res.writableEnded)controller.abort();});
    let rpc;
    try{
      const address=server.address(),localOrigins=[`http://127.0.0.1:${address.port}`,`http://localhost:${address.port}`],origins=[...localOrigins,...(publicOrigin?[publicOrigin]:[])];
      const hosts=origins.map(o=>new URL(o).host);
      if(!hosts.includes(req.headers.host))throw new ArenaError('invalid_host','Host is not allowed.',403);
      if(req.headers.origin&&!origins.includes(req.headers.origin))throw new ArenaError('invalid_origin','Origin is not allowed.',403);
      if(closing)throw new ArenaError('closing','Server is shutting down.',503);
      const url=new URL(req.url,localOrigins[0]),route=url.pathname;
      const now=Date.now(),ip=req.socket.remoteAddress,bucket=buckets.get(ip)||{start:now,count:0,creates:0};
      if(now-bucket.start>=60000){bucket.start=now;bucket.count=0;bucket.creates=0;}
      bucket.count++;buckets.set(ip,bucket);if(bucket.count>360)throw new ArenaError('rate_limited','Too many requests. Try again in a minute.',429);
      if(req.method==='GET'&&assets[route]){const [file,type]=assets[route];res.writeHead(200,{'Content-Type':type+'; charset=utf-8'});res.end(readFileSync(path.join(__dirname,'../dist',file)));return;}
      if(route==='/api/health'&&req.method==='GET'){json(res,200,{ok:true,version:'0.2.0',model_api_calls:false,public_origin:publicOrigin,creation_requires_key:!!adminToken,storage_mode:process.env.ARENA_STORAGE_MODE==='ephemeral'?'ephemeral':'persistent',mcp_path:'/mcp',protocol_versions:VERSIONS});return;}
      if(route==='/mcp'&&req.method!=='POST'){res.setHeader('Allow','POST');json(res,405,{error:'Use Streamable HTTP POST. No standalone MCP SSE stream is offered.'});return;}
      if(req.method==='POST'){
        if(!String(req.headers['content-type']||'').toLowerCase().startsWith('application/json'))throw new ArenaError('unsupported_media_type','Use application/json.',415);
        const input=await body(req);
        if(route==='/api/matches'){
          if(adminToken&&!equal(req.headers.authorization,`Bearer ${adminToken}`))throw new ArenaError('unauthorized','A host creation key is required.',401);
          if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length)throw new ArenaError('invalid_arguments','Create match accepts an empty object.');
          if(++bucket.creates>10)throw new ArenaError('rate_limited','Match creation limit reached. Try again in a minute.',429);
          json(res,201,store.create());return;
        }
        if(route==='/mcp'){
          rpc=input;
          if(!rpc||rpc.jsonrpc!=='2.0'||typeof rpc.method!=='string'||Array.isArray(rpc)||(rpc.id!==undefined&&typeof rpc.id!=='string'&&typeof rpc.id!=='number')){json(res,400,{jsonrpc:'2.0',id:null,error:{code:-32600,message:'Invalid JSON-RPC request.'}});return;}
          const accept=String(req.headers.accept||'');if(!accept.includes('application/json')||!accept.includes('text/event-stream'))throw new ArenaError('not_acceptable','Accept must include application/json and text/event-stream.',406);
          const version=req.headers['mcp-protocol-version'],meta=rpc.params?._meta,bodyVersion=meta?.['io.modelcontextprotocol/protocolVersion'];
          const modern=!!bodyVersion||version===MODERN;
          if(version&&!VERSIONS.includes(version)||bodyVersion&&!VERSIONS.includes(bodyVersion)){json(res,400,{jsonrpc:'2.0',id:rpc.id??null,error:{code:-32022,message:'Unsupported protocol version',data:{supported:VERSIONS,requested:bodyVersion||version}}});return;}
          if(modern&&(version!==bodyVersion||req.headers['mcp-method']!==rpc.method||(rpc.method==='tools/call'&&decodeHeader(req.headers['mcp-name'])!==rpc.params?.name))){json(res,400,{jsonrpc:'2.0',id:rpc.id??null,error:{code:-32020,message:'Required MCP headers are missing or do not match the request body.'}});return;}
          if(modern&&(bodyVersion!==MODERN||!meta['io.modelcontextprotocol/clientCapabilities']||typeof meta['io.modelcontextprotocol/clientCapabilities']!=='object'||Array.isArray(meta['io.modelcontextprotocol/clientCapabilities']))){json(res,400,{jsonrpc:'2.0',id:rpc.id??null,error:{code:-32602,message:'Modern requests require protocolVersion and clientCapabilities metadata.'}});return;}
          if(rpc.id===undefined){if(!['notifications/initialized','notifications/cancelled'].includes(rpc.method))throw new ArenaError('invalid_notification','Unsupported notification.');res.writeHead(202);res.end();return;}
          let result;
          if(rpc.method==='server/discover')result={supportedVersions:VERSIONS,capabilities:{tools:{}},_meta:{'io.modelcontextprotocol/serverInfo':{name:'agent-arena',version:'0.2.0'}},instructions:'Join with a private seat invitation. Use observations, legal actions, and wait_for_turn. No model API calls are made by the arena.'};
          else if(rpc.method==='initialize'&&!modern){const requested=rpc.params?.protocolVersion;result={protocolVersion:LEGACY.includes(requested)?requested:LEGACY.at(-1),capabilities:{tools:{}},serverInfo:{name:'agent-arena',version:'0.2.0'},instructions:'Use get_rules, then join_match with a private seat invitation. Play through get_observation, submit_action, and wait_for_turn. Never disclose seat tokens. No model calls are made by this server.'};}
          else if(rpc.method==='ping')result={};
          else if(rpc.method==='tools/list')result={tools:mcp.tools};
          else if(rpc.method==='tools/call'){
            try{const data=await mcp.call(rpc.params?.name,rpc.params?.arguments||{},controller.signal);result={content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data,isError:false};}
            catch(e){if(!(e instanceof ArenaError))throw e;result={content:[{type:'text',text:JSON.stringify({code:e.code,message:e.message})}],isError:true};}
          } else {json(res,modern?404:200,{jsonrpc:'2.0',id:rpc.id,error:{code:-32601,message:'Method not found.'}});return;}
          if(modern)result={resultType:'complete',...result};
          if(!res.destroyed)json(res,200,{jsonrpc:'2.0',id:rpc.id,result});return;
        }
      }
      const matchRoute=route.match(/^\/api\/matches\/([a-f0-9-]{36})(?:\/(events|replay))?$/);
      if(matchRoute&&req.method==='GET'){
        const [,id,kind]=matchRoute;
        if(kind==='replay'){json(res,200,store.replay(id));return;}
        if(!kind){json(res,200,{match:store.snapshot(id),events:store.events(id)});return;}
        // Every event carries a complete authoritative snapshot: reconnects recover even after a server restart.
        store.snapshot(id);
        if(streams.size>=100)throw new ArenaError('busy','Spectator connection limit reached.',429);
        res.writeHead(200,{'Content-Type':'text/event-stream','Connection':'keep-alive','X-Accel-Buffering':'no'});streams.add(res);
        const send=()=>{if(!res.destroyed){const state=store.snapshot(id);res.write(`id: ${state.version}\nevent: state\ndata: ${JSON.stringify({match:state,events:store.events(id)})}\n\n`);}};
        const heartbeat=setInterval(()=>res.write(': heartbeat\n\n'),15000);heartbeat.unref();
        changes.on(id,send);res.on('close',()=>{clearInterval(heartbeat);changes.off(id,send);streams.delete(res);});send();return;
      }
      json(res,404,{error:{code:'not_found',message:'Route not found.'}});
    }catch(e){if(res.destroyed||res.writableEnded)return;if(res.headersSent){res.end();return;}const known=e instanceof ArenaError;if(!known)console.error('Arena request failed:',e.name);json(res,known?e.status:500,{error:{code:known?e.code:'internal_error',message:known?e.message:'An internal server error occurred.'}});}
  });
  server.requestTimeout=30000;server.headersTimeout=15000;
  const sweep=setInterval(()=>{try{store.sweep();}catch(e){console.error('Deadline sweep failed:',e.name);}const now=Date.now();for(const [ip,b] of buckets)if(now-b.start>120000)buckets.delete(ip);},1000);sweep.unref();
  return {server,store,mcp,changes,async close(){closing=true;clearInterval(sweep);for(const stream of streams)stream.end();await new Promise(resolve=>{server.close(resolve);server.closeIdleConnections();});store.close();}};
}
if(require.main===module){
  const port=Number(process.env.PORT||4173),host=process.env.ARENA_BIND||'127.0.0.1';
  if(host!=='127.0.0.1'&&host!=='localhost'&&!process.env.ARENA_PUBLIC_ORIGIN)throw new Error('External binding requires ARENA_PUBLIC_ORIGIN and ARENA_ADMIN_TOKEN.');
  const app=createArenaServer();app.server.listen(port,host,()=>console.log(`Agent Arena: http://${host}:${port}\nMCP: http://${host}:${port}/mcp\nModel API calls: none`));
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>app.close().then(()=>process.exit(0)));
}
module.exports={createArenaServer};

