'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {mkdtempSync,rmSync,readFileSync}=require('node:fs');
const os=require('node:os'),path=require('node:path');
const {ArenaStore}=require('../server/store.cjs');
const {initialState,legalActions,applyAction,clearSight,publicState}=require('../server/engine.cjs');
const {createArenaServer}=require('../server/http.cjs');
function ready(store){const r=store.create();for(let i=0;i<2;i++)store.join({match_id:r.match.id,seat_token:r.seats[i].seat_token,agent_id:'test-agent-'+i,name:i?'EMBER':'ATLAS'});return r;}
function action(store,r,seat,turn,move,id='action-0001'){return store.act({match_id:r.match.id,seat_token:r.seats[seat].seat_token,expected_turn:turn,request_id:id,action:move});}

test('seat credentials are scoped, hashed, and registration is locked',()=>{
  const store=new ArenaStore(':memory:');try{const r=ready(store),other=store.create();assert.equal(store.snapshot(r.match.id).phase,'active');assert.throws(()=>store.join({match_id:r.match.id,seat_token:r.seats[0].seat_token,agent_id:'replacement-agent',name:'Intruder'}),e=>e.code==='seat_locked');assert.throws(()=>store.observe(other.match.id,r.seats[0].seat_token),e=>e.code==='unauthorized');assert.throws(()=>store.observe(r.match.id,'x'.repeat(43)),e=>e.code==='unauthorized');const joined=store.join({match_id:r.match.id,seat_token:r.seats[0].seat_token,agent_id:'test-agent-0',name:'Changed'});assert.equal(joined.match.agents[0].name,'ATLAS');const serialized=JSON.stringify(store.replay(r.match.id));for(const seat of r.seats){assert.ok(!serialized.includes(seat.seat_token));assert.notEqual(store.db.prepare('SELECT token_hash FROM seats WHERE match_id=? AND seat=?').get(r.match.id,seat.seat).token_hash,seat.seat_token);}}finally{store.close();}
});
test('illegal, out-of-turn, stale, and forged actions do not mutate state',()=>{
  const store=new ArenaStore(':memory:');try{const r=ready(store),before=store.snapshot(r.match.id);assert.throws(()=>action(store,r,1,0,{type:'wait'}),e=>e.code==='out_of_turn');assert.throws(()=>action(store,r,0,0,{type:'attack'}),e=>e.code==='illegal_action');assert.throws(()=>action(store,r,0,0,{type:'move',x:1,y:3}),e=>e.code==='illegal_action');assert.throws(()=>action(store,r,0,0,{type:'wait',hp:1000}),e=>e.code==='invalid_action');assert.throws(()=>action(store,r,0,0,{type:'move',x:1.5,y:2}),e=>e.code==='invalid_action');assert.deepEqual(store.snapshot(r.match.id),before);action(store,r,0,0,{type:'move',x:0,y:2});assert.throws(()=>action(store,r,1,0,{type:'wait'},'stale-0001'),e=>e.code==='stale_turn');assert.equal(store.snapshot(r.match.id).turn,1);}finally{store.close();}
});
test('action receipts make retries exactly once, and reject reused IDs with other payloads',()=>{
  const store=new ArenaStore(':memory:');try{const r=ready(store);const a=action(store,r,0,0,{type:'wait'});const retry=action(store,r,0,0,{type:'wait'});assert.equal(retry.replayed,true);assert.equal(a.match.version,retry.match.version);assert.equal(store.snapshot(r.match.id).turn,1);assert.throws(()=>action(store,r,0,0,{type:'move',x:0,y:2}),e=>e.code==='request_conflict');}finally{store.close();}
});
test('deadlines auto-wait, reconnects preserve identity, repeated misses forfeit',()=>{
  let now=1000;const store=new ArenaStore(':memory:',{clock:()=>now,turnMs:100});try{const r=ready(store);now=1101;const s=store.snapshot(r.match.id);assert.equal(s.turn,1);assert.equal(s.agents[0].timeouts,1);const recovered=store.observe(r.match.id,r.seats[0].seat_token);assert.equal(recovered.your_seat,0);now=1501;const done=store.snapshot(r.match.id);assert.equal(done.phase,'finished');assert.equal(done.reason,'timeout_forfeit');assert.equal(done.winner,1);assert.equal(done.turn,5);}finally{store.close();}
});
test('invalid late actions cannot roll back expired turns',()=>{
  let now=0;const store=new ArenaStore(':memory:',{clock:()=>now,turnMs:100});try{const r=ready(store);now=101;assert.throws(()=>action(store,r,0,0,{type:'attack'}),e=>e.code==='stale_turn');assert.equal(store.read(r.match.id).turn,1);}finally{store.close();}
});
test('cover blocks shots, adjacent cover reduces damage, pickups restore bounded resources',()=>{
  assert.equal(clearSight({x:0,y:3},{x:6,y:3}),false);assert.equal(clearSight({x:0,y:0},{x:3,y:0}),true);
  const s=initialState('test-match',0,1000);s.phase='active';s.agents[0].x=0;s.agents[0].y=0;s.agents[1].x=1;s.agents[1].y=0;
  applyAction(s,0,{type:'attack'},1);assert.equal(s.agents[1].hp,82);assert.equal(s.agents[0].energy,2);
  s.turn=0;s.agents[0].x=3;s.agents[0].y=0;s.agents[1].x=3;s.agents[1].y=1;s.agents[1].hp=100;
  applyAction(s,0,{type:'attack'},2);assert.equal(s.agents[1].hp,88);
  s.turn=0;s.agents[0].x=0;s.agents[0].y=1;s.agents[0].hp=96;s.agents[0].energy=4;
  applyAction(s,0,{type:'move',x:1,y:1},3);assert.equal(s.agents[0].hp,100);assert.equal(s.agents[0].energy,6);assert.ok(!s.pickups.some(p=>p.x===1&&p.y===1));
});
test('identical inputs reproduce states, danger activates at defined turns, integrity decides ties',()=>{
  const a=initialState('same-match',0,100),b=structuredClone(a);a.phase=b.phase='active';for(let n=0;n<30;n++){applyAction(a,n%2,{type:'wait'},n);applyAction(b,n%2,{type:'wait'},n);}assert.deepEqual(a,b);assert.equal(a.agents[0].hp,73);assert.equal(a.agents[1].hp,73);assert.equal(publicState(a).dangerRing,1);
  const s=initialState('tie-match',0,100);s.phase='active';s.turn=59;s.agents[0].x=2;s.agents[0].y=2;s.agents[1].x=4;s.agents[1].y=4;applyAction(s,1,{type:'wait'},60);assert.equal(s.phase,'finished');assert.equal(s.winner,null);
});
test('SQLite restart preserves board, identity, replay, and action receipts',()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'arena-test-'));const file=path.join(dir,'arena.sqlite');let store;try{store=new ArenaStore(file);const r=ready(store);action(store,r,0,0,{type:'move',x:0,y:2});const state=store.snapshot(r.match.id);store.close();store=new ArenaStore(file);assert.deepEqual(store.snapshot(r.match.id),state);assert.equal(store.observe(r.match.id,r.seats[0].seat_token).your_seat,0);assert.equal(action(store,r,0,0,{type:'move',x:0,y:2}).replayed,true);assert.equal(store.replay(r.match.id).frames.length,4);}finally{store?.close();rmSync(dir,{recursive:true,force:true});}
});

async function fixture(t,options={}){const app=createArenaServer({dbPath:':memory:',...options});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+app.server.address().port;let seq=0;const rpc=async(method,params={})=>{const r=await fetch(base+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:++seq,method,params})});assert.equal(r.status,200);return r.json();};const call=async(name,args)=>{const r=await rpc('tools/call',{name,arguments:args});return r.result;};t.after(()=>app.close());return {...app,base,rpc,call};}
test('MCP initialization, discovery, argument validation, notifications, and origin protection',async t=>{
  const f=await fixture(t);const init=await f.rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'1'}});assert.equal(init.result.protocolVersion,'2025-11-25');const listed=await f.rpc('tools/list');assert.equal(listed.result.tools.length,6);assert.ok(listed.result.tools.every(tool=>tool.inputSchema.additionalProperties===false));const bad=await f.call('join_match',{match_id:'invalid'});assert.equal(bad.isError,true);const unknown=await f.call('not_a_tool',{});assert.equal(unknown.isError,true);const origin=await fetch(f.base+'/api/matches',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://evil.example'},body:'{}'});assert.equal(origin.status,403);const hostStatus=await new Promise((resolve,reject)=>{require('node:http').get(f.base+'/api/health',{headers:{Host:'evil.example'}},r=>{r.resume();resolve(r.statusCode);}).on('error',reject);});assert.equal(hostStatus,403);const notify=await fetch(f.base+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})});assert.equal(notify.status,202);assert.equal((await fetch(f.base+'/mcp')).status,405);assert.equal((await fetch(f.base+'/data/arena.sqlite')).status,404);
});
test('two independent MCP clients complete a battle; spectators and replays contain no secrets',async t=>{
  const f=await fixture(t);const response=await fetch(f.base+'/api/matches',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}),r=await response.json();assert.equal(response.status,201);
  const credentials=r.seats.map(seat=>({match_id:r.match.id,seat_token:seat.seat_token}));
  for(let i=0;i<2;i++){const result=await f.call('join_match',{...credentials[i],agent_id:'external-client-'+i,name:i?'GAMMA':'BETA'});assert.equal(result.isError,false);}
  // A deliberately basic external policy. All actions go through HTTP MCP, not direct engine calls.
  let moves=0;while(moves<60){const state=f.store.snapshot(r.match.id);if(state.phase==='finished')break;const seat=state.activeSeat;const observation=(await f.call('get_observation',credentials[seat])).structuredContent;let choice=observation.legal_actions.find(a=>a.type==='attack');if(!choice){const opponent=observation.match.agents[1-seat];choice=observation.legal_actions.filter(a=>a.type==='move').sort((a,b)=>Math.abs(a.x-opponent.x)+Math.abs(a.y-opponent.y)-Math.abs(b.x-opponent.x)-Math.abs(b.y-opponent.y))[0]||{type:'wait'};}const result=await f.call('submit_action',{...credentials[seat],expected_turn:observation.expected_turn,request_id:'external-action-'+moves,action:choice});assert.equal(result.isError,false);moves++;}
  const result=await f.call('get_match_result',credentials[0]);assert.equal(result.structuredContent.phase,'finished');assert.ok(moves>0&&moves<=60);const publicData=await (await fetch(f.base+'/api/matches/'+r.match.id)).json(),replay=await (await fetch(f.base+'/api/matches/'+r.match.id+'/replay')).json();assert.equal(publicData.match.phase,'finished');assert.equal(replay.frames.length,moves+3);for(const seat of r.seats)assert.ok(!JSON.stringify({publicData,replay}).includes(seat.seat_token));
});
test('concurrent submissions apply once; wait_for_turn wakes after opponent action',async t=>{
  const f=await fixture(t),r=ready(f.store),creds={match_id:r.match.id,seat_token:r.seats[0].seat_token};
  const submissions=await Promise.all(['concurrent-0001','concurrent-0002'].map(request_id=>f.call('submit_action',{...creds,expected_turn:0,request_id,action:{type:'wait'}})));assert.equal(submissions.filter(r=>!r.isError).length,1);assert.equal(f.store.snapshot(r.match.id).turn,1);
  const waiting=f.call('wait_for_turn',{...creds,wait_seconds:2});await new Promise(resolve=>setTimeout(resolve,40));const opponent=await f.call('submit_action',{match_id:r.match.id,seat_token:r.seats[1].seat_token,expected_turn:1,request_id:'opponent-0001',action:{type:'wait'}});assert.equal(opponent.isError,false);const woke=await waiting;assert.equal(woke.structuredContent.your_turn,true);assert.equal(woke.structuredContent.expected_turn,2);
});
test('SSE sends full current state on initial connection and reconnect',async t=>{
  const f=await fixture(t),r=ready(f.store),url=f.base+'/api/matches/'+r.match.id+'/events';
  async function firstEvent(){const controller=new AbortController();const response=await fetch(url,{signal:controller.signal});assert.equal(response.status,200);assert.ok(response.headers.get('content-type').includes('text/event-stream'));const reader=response.body.getReader();let text='';while(!text.includes('\n\n')){const {value}=await reader.read();text+=new TextDecoder().decode(value);}controller.abort();return JSON.parse(text.split('data: ')[1].split('\n')[0]);}
  const first=await firstEvent();assert.equal(first.match.turn,0);action(f.store,r,0,0,{type:'wait'});const next=await firstEvent();assert.equal(next.match.turn,1);assert.equal(next.events[0].kind,'action');
});
test('public hosting fails closed without HTTPS/admin key; host key controls creation',async t=>{
  assert.throws(()=>createArenaServer({dbPath:':memory:',publicOrigin:'https://arena.example'}),/requires/);const f=await fixture(t,{adminToken:'k'.repeat(32)});const request={method:'POST',headers:{'Content-Type':'application/json'},body:'{}'};assert.equal((await fetch(f.base+'/api/matches',request)).status,401);request.headers.Authorization='Bearer '+'k'.repeat(32);assert.equal((await fetch(f.base+'/api/matches',request)).status,201);
});
test('UI references existing elements; JavaScript and styles are served',async t=>{
  const f=await fixture(t),html=await(await fetch(f.base)).text(),script=readFileSync(path.join(__dirname,'../dist/game.js'),'utf8');for(const [,id] of script.matchAll(/\$\('([^']+)'\)/g)){if(['name','hp','bar','energy','damage','thought','seatStatus','agentState','prompt'].includes(id))continue;assert.ok(html.includes('id="'+id+'"'),'Missing element '+id);}for(const file of ['game.js','style.css','arena.css'])assert.equal((await fetch(f.base+'/'+file)).status,200);
});

