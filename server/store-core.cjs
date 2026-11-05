'use strict';
const {randomBytes,randomUUID,createHash}=require('node:crypto');
const {RULES,initialState,legalActions,applyAction,publicState}=require('./engine.cjs');
class ArenaError extends Error { constructor(code,message,status=400){super(message);this.code=code;this.status=status;} }
const fail=(code,message,status)=>{throw new ArenaError(code,message,status);};
const digest=token=>createHash('sha256').update(token).digest('hex');
const validString=(v,min,max)=>typeof v==='string'&&v.length>=min&&v.length<=max;

class ArenaStore {
  constructor(db, {clock=Date.now,onChange=()=>{},turnMs=120000}={}) {
    this.db=db;this.clock=clock;this.onChange=onChange;this.turnMs=turnMs;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS matches(id TEXT PRIMARY KEY,state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS seats(match_id TEXT NOT NULL REFERENCES matches(id),seat INTEGER NOT NULL,token_hash TEXT NOT NULL UNIQUE,agent_id TEXT,PRIMARY KEY(match_id,seat));
      CREATE TABLE IF NOT EXISTS events(match_id TEXT NOT NULL REFERENCES matches(id),version INTEGER NOT NULL,event TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(match_id,version));
      CREATE TABLE IF NOT EXISTS receipts(match_id TEXT NOT NULL,seat INTEGER NOT NULL,request_id TEXT NOT NULL,payload TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(match_id,seat,request_id));`);
  }
  transaction(fn) {if(this.db.transactionSync)return this.db.transactionSync(fn);this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  read(id){if(!validString(id,10,80))fail('not_found','Match not found.',404);const row=this.db.prepare('SELECT state FROM matches WHERE id=?').get(id);if(!row)fail('not_found','Match not found.',404);return JSON.parse(row.state);}
  record(s,event){s.version++;const entry={...event,version:s.version,turn:s.turn,at:s.updatedAt};this.db.prepare('UPDATE matches SET state=? WHERE id=?').run(JSON.stringify(s),s.id);this.db.prepare('INSERT INTO events VALUES(?,?,?,?)').run(s.id,s.version,JSON.stringify(entry),JSON.stringify(publicState(s)));return entry;}
  create(){const now=this.clock(),id=randomUUID(),s=initialState(id,now,this.turnMs),tokens=[randomBytes(32).toString('base64url'),randomBytes(32).toString('base64url')];this.transaction(()=>{this.db.prepare('INSERT INTO matches VALUES(?,?)').run(id,JSON.stringify(s));for(let seat=0;seat<2;seat++)this.db.prepare('INSERT INTO seats VALUES(?,?,?,NULL)').run(id,seat,digest(tokens[seat]));this.record(s,{kind:'created',seat:null,message:'Arena created. Waiting for two external agents.'});});return {match:publicState(s),seats:tokens.map((token,seat)=>({seat,seat_token:token}))};}
  authenticate(id,token){if(!validString(token,40,100))fail('unauthorized','A valid private seat token is required.',401);const row=this.db.prepare('SELECT seat,agent_id FROM seats WHERE match_id=? AND token_hash=?').get(id,digest(token));if(!row)fail('unauthorized','Invalid seat token for this match.',401);return row;}
  expire(s,now){let changed=false;while(s.phase==='active'&&s.deadline<=now){const time=s.deadline;const event=applyAction(s,s.turn%2,{type:'wait'},time,{timeout:true});this.record(s,event);changed=true;}return changed;}
  snapshot(id){let changed=false;const s=this.transaction(()=>{const s=this.read(id);changed=this.expire(s,this.clock());return s;});if(changed)this.onChange(id);return publicState(s);}
  join({match_id,seat_token,agent_id,name}){
    if(!validString(agent_id,8,80)||!/^[a-zA-Z0-9_-]+$/.test(agent_id))fail('invalid_agent_id','Use a stable agent_id of 8–80 letters, digits, underscores, or hyphens.');
    if(!validString(name,1,24)||!name.trim()||/[\x00-\x1f\x7f]/.test(name))fail('invalid_name','Agent name must contain 1–24 printable characters.');
    const result=this.transaction(()=>{const row=this.authenticate(match_id,seat_token),s=this.read(match_id);this.expire(s,this.clock());
      if(row.agent_id && row.agent_id!==agent_id)fail('seat_locked','This seat is already locked to another registered agent.',409);
      if(!row.agent_id){if(s.phase!=='waiting')fail('match_started','Cannot join a started match.',409);this.db.prepare('UPDATE seats SET agent_id=? WHERE match_id=? AND seat=?').run(agent_id,match_id,row.seat);s.agents[row.seat].joined=true;s.agents[row.seat].name=name.trim();s.updatedAt=this.clock();if(s.agents.every(a=>a.joined)){s.phase='active';s.deadline=this.clock()+s.turnMs;}this.record(s,{kind:'joined',seat:row.seat,message:`${name.trim()} joined seat ${row.seat+1}.${s.phase==='active'?' Match started.':''}`});}
      return this.observation(s,row.seat);});this.onChange(match_id);return result;
  }
  observation(s,seat){return {match:publicState(s),your_seat:seat,your_turn:s.phase==='active'&&s.turn%2===seat,expected_turn:s.turn,legal_actions:legalActions(s,seat),rules:RULES,next:s.phase==='finished'?'Match finished. Read the result.':s.phase==='waiting'?'Wait for the second agent. Call wait_for_turn.':s.turn%2===seat?'Choose one legal action and call submit_action using expected_turn and a unique request_id.':'Call wait_for_turn. Do not submit an action out of turn.'};}
  observe(id,token){this.snapshot(id);const row=this.authenticate(id,token);if(!row.agent_id)fail('not_joined','Call join_match before reading a player observation.',409);return this.observation(this.read(id),row.seat);}
  act({match_id,seat_token,expected_turn,request_id,action}){
    if(!Number.isInteger(expected_turn)||expected_turn<0||expected_turn>59)fail('invalid_turn','expected_turn must be an integer between 0 and 59.');
    if(!validString(request_id,8,80)||!/^[a-zA-Z0-9_-]+$/.test(request_id))fail('invalid_request_id','Use a unique request_id of 8–80 letters, digits, underscores, or hyphens.');
    if(!action||typeof action!=='object'||Array.isArray(action))fail('invalid_action','An action object is required.');
    const fields=Object.keys(action).sort().join(',');
    if(!['attack','move','wait'].includes(action.type)||fields!==(action.type==='move'?'type,x,y':'type')||(action.type==='move'&&(!Number.isInteger(action.x)||!Number.isInteger(action.y))))fail('invalid_action','Use {type:move,x,y}, {type:attack}, or {type:wait}. No extra fields are allowed.');
    const normalized=action.type==='move'?{type:'move',x:action.x,y:action.y}:{type:action.type};
    const payload=JSON.stringify({expected_turn,action:normalized});
    // Commit expired turns independently: an invalid late action cannot roll back a deadline.
    this.snapshot(match_id);
    const result=this.transaction(()=>{const row=this.authenticate(match_id,seat_token);if(!row.agent_id)fail('not_joined','Call join_match first.',409);
      const receipt=this.db.prepare('SELECT payload,result FROM receipts WHERE match_id=? AND seat=? AND request_id=?').get(match_id,row.seat,request_id);
      if(receipt){if(receipt.payload!==payload)fail('request_conflict','This request_id was used with a different action.',409);return {...JSON.parse(receipt.result),replayed:true};}
      const s=this.read(match_id);if(s.phase!=='active')fail('not_active','The match is not active.',409);
      if(s.turn!==expected_turn)fail('stale_turn','Turn has changed. Get a fresh observation.',409);
      if(s.turn%2!==row.seat)fail('out_of_turn','It is the other agent’s turn.',409);
      let event;try{event=applyAction(s,row.seat,normalized,this.clock());}catch(e){fail('illegal_action',e.message,422);}
      this.record(s,event);const output={...this.observation(s,row.seat),accepted:true,replayed:false};this.db.prepare('INSERT INTO receipts VALUES(?,?,?,?,?)').run(match_id,row.seat,request_id,payload,JSON.stringify(output));return output;
    });this.onChange(match_id);return result;
  }
  replay(id){this.snapshot(id);return {match_id:id,rules:RULES,frames:this.db.prepare('SELECT event,state FROM events WHERE match_id=? ORDER BY version').all(id).map(r=>({event:JSON.parse(r.event),state:JSON.parse(r.state)}))};}
  events(id){return this.db.prepare('SELECT event FROM events WHERE match_id=? ORDER BY version DESC LIMIT 80').all(id).map(r=>JSON.parse(r.event));}
  sweep(){for(const {id} of this.db.prepare("SELECT id FROM matches WHERE json_extract(state,'$.phase')='active'").all())this.snapshot(id);}
  close(){this.db.close();}
}
module.exports={ArenaStore,ArenaError};

