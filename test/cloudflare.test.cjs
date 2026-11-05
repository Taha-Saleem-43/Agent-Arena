'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
async function fixture(t){
  const db=new DatabaseSync(':memory:');let alarm=null;
  const storage={sql:{exec:(sql,...args)=>({toArray:()=>db.prepare(sql).all(...args)})},
    transactionSync(fn){db.exec('BEGIN');try{const result=fn();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}},
    async getAlarm(){return alarm;},async setAlarm(value){alarm=value;},async deleteAlarm(){alarm=null;}};
  const {Coordinator}=await import('../cloudflare/handler.mjs');
  const ctx={storage},env={ARENA_ADMIN_TOKEN:'k'.repeat(64)},app=new Coordinator(ctx,env);t.after(()=>db.close());
  const request=(route,options={})=>app.fetch(new Request('https://arena.example'+route,options));
  let seq=0;const rpc=async(method,params={})=>{const response=await request('/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:++seq,method,params})});assert.equal(response.status,200);return response.json();};
  const call=async(name,args)=>(await rpc('tools/call',{name,arguments:args})).result;
  const create=async()=>{const r=await request('/api/matches',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+env.ARENA_ADMIN_TOKEN},body:'{}'});assert.equal(r.status,201);return r.json();};
  return {app,ctx,env,Coordinator,request,rpc,call,create,alarm:()=>alarm};
}
test('Cloudflare adapter persists matches across coordinator recreation and schedules durable deadlines',async t=>{
  const f=await fixture(t),r=await f.create();
  for(let i=0;i<2;i++){const result=await f.call('join_match',{match_id:r.match.id,seat_token:r.seats[i].seat_token,agent_id:'cloudflare-agent-'+i,name:'Agent '+i});assert.equal(result.isError,false);}
  assert.ok(f.alarm()>Date.now());
  const restarted=new f.Coordinator(f.ctx,f.env);const result=await restarted.fetch(new Request('https://arena.example/api/matches/'+r.match.id));assert.equal((await result.json()).match.phase,'active');
  restarted.store.clock=()=>Date.now()+10*120000;await restarted.alarm();assert.equal(restarted.store.snapshot(r.match.id).phase,'finished');assert.equal(restarted.store.snapshot(r.match.id).reason,'timeout_forfeit');assert.equal(f.alarm(),null);
});
test('Cloudflare two-client MCP battle validates actions, retry receipts, and secret-free replay',async t=>{
  const f=await fixture(t),r=await f.create(),creds=r.seats.map(s=>({match_id:r.match.id,seat_token:s.seat_token}));
  for(let i=0;i<2;i++)assert.equal((await f.call('join_match',{...creds[i],agent_id:'cloud-match-agent-'+i,name:'External '+i})).isError,false);
  const illegal=await f.call('submit_action',{...creds[0],expected_turn:0,request_id:'illegal-cloud-0001',action:{type:'attack'}});assert.equal(illegal.isError,true);assert.equal(f.app.store.snapshot(r.match.id).turn,0);
  let first;
  for(let n=0;n<60;n++){
    const s=f.app.store.snapshot(r.match.id);if(s.phase==='finished')break;const seat=s.activeSeat;
    const observation=(await f.call('get_observation',creds[seat])).structuredContent;
    const opponent=s.agents[1-seat];
    const chosen=observation.legal_actions.find(a=>a.type==='attack')||observation.legal_actions.filter(a=>a.type==='move').sort((a,b)=>Math.abs(a.x-opponent.x)+Math.abs(a.y-opponent.y)-Math.abs(b.x-opponent.x)-Math.abs(b.y-opponent.y))[0]||{type:'wait'};
    const input={...creds[seat],expected_turn:s.turn,request_id:'cloud-action-'+n,action:chosen};
    const result=await f.call('submit_action',input);assert.equal(result.isError,false);
    if(n===0){first=input;const retry=await f.call('submit_action',input);assert.equal(retry.structuredContent.replayed,true);assert.equal(f.app.store.snapshot(r.match.id).turn,1);}
  }
  assert.ok(first);const result=(await f.call('get_match_result',creds[0])).structuredContent;assert.equal(result.phase,'finished');
  const replay=await(await f.request('/api/matches/'+r.match.id+'/replay')).json();for(const seat of r.seats)assert.ok(!JSON.stringify(replay).includes(seat.seat_token));
});
test('Cloudflare enforces origin, creation key, body limits, and modern protocol headers',async t=>{
  const f=await fixture(t);assert.equal((await f.request('/api/matches',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
  assert.equal((await f.request('/api/health',{headers:{Origin:'https://evil.example'}})).status,403);
  const health=await(await f.request('/api/health')).json();assert.equal(health.storage_mode,'persistent');assert.equal(health.configured,true);
  const meta={'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{},'io.modelcontextprotocol/clientInfo':{name:'test',version:'1'}};
  const init=await f.request('/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream','Mcp-Method':'server/discover','MCP-Protocol-Version':'2026-07-28'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'server/discover',params:{_meta:meta}})});assert.equal(init.status,200);assert.equal((await init.json()).result.resultType,'complete');
  const big=await f.request('/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:'x'.repeat(17000)});assert.equal(big.status,413);
});
test('Cloudflare spectator stream starts with an authoritative snapshot and releases listeners on cancel',async t=>{
  const f=await fixture(t),r=await f.create();const response=await f.request('/api/matches/'+r.match.id+'/events');assert.equal(response.status,200);const reader=response.body.getReader();const first=await reader.read();const text=new TextDecoder().decode(first.value);assert.match(text,/event: state/);assert.ok(text.includes(r.match.id));assert.equal(f.app.streams.size,1);await reader.cancel();assert.equal(f.app.streams.size,0);assert.equal(f.app.changes.listenerCount(r.match.id),0);
});
