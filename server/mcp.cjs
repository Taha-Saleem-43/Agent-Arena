'use strict';
const {ArenaError}=require('./store.cjs');
const {RULES}=require('./engine.cjs');
const string=(description,minLength=1,maxLength=200)=>({type:'string',description,minLength,maxLength});
const match=string('Match ID from the invitation.',10,80), token=string('Private seat credential from the user. Never include it in public messages or share it with the opponent.',40,100);
const schema=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
const tools=[
  {name:'get_rules',description:'Read the deterministic arena rules and connection instructions. No model API is used by the arena.',inputSchema:schema({}),annotations:{readOnlyHint:true}},
  {name:'join_match',description:'Join one invited seat as the user’s external agent. Pick a stable agent_id and reuse it on reconnect. A different agent_id cannot replace a registered agent. The match begins when both seats join.',inputSchema:schema({match_id:match,seat_token:token,agent_id:string('Stable registration ID, 8–80 letters/digits/underscore/hyphen. Keep for reconnects.',8,80),name:string('Public agent display name, 1–24 characters.',1,24)}),annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true}},
  {name:'get_observation',description:'Get your seat, turn number, deadline, full visible board, and legal actions. Call after errors or reconnects. Opponent credentials are never returned.',inputSchema:schema({match_id:match,seat_token:token}),annotations:{readOnlyHint:true}},
  {name:'wait_for_turn',description:'Wait up to 20 seconds for your turn, the second player, or the result. If still waiting, call again. Do not rapidly poll get_observation. A client may require the user to say continue.',inputSchema:schema({match_id:match,seat_token:token,wait_seconds:{type:'integer',minimum:1,maximum:20}},['match_id','seat_token']),annotations:{readOnlyHint:true}},
  {name:'submit_action',description:'Submit exactly one action selected from legal_actions. Use the observed expected_turn and a new request_id. Retry the SAME request_id and action after a lost response; it is applied only once. The referee generates public action summaries.',inputSchema:schema({match_id:match,seat_token:token,expected_turn:{type:'integer',minimum:0,maximum:59},request_id:string('Unique action ID, 8–80 letters/digits/underscore/hyphen.',8,80),action:{oneOf:[schema({type:{type:'string',enum:['move']},x:{type:'integer',minimum:0,maximum:6},y:{type:'integer',minimum:0,maximum:6}}),schema({type:{type:'string',enum:['attack','wait']}})]}}),annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true}},
  {name:'get_match_result',description:'Read the current status, winner, result reason, and replay path. No subjective AI judge is involved.',inputSchema:schema({match_id:match,seat_token:token}),annotations:{readOnlyHint:true}}
];
function validate(value,s,path='arguments') {
  if(s.oneOf){if(s.oneOf.filter(option=>{try{validate(value,option,path);return true;}catch{return false;}}).length!==1)throw new ArenaError('invalid_arguments',`${path} does not match an allowed action.`);return;}
  if(s.type==='object'){
    if(!value||typeof value!=='object'||Array.isArray(value))throw new ArenaError('invalid_arguments',`${path} must be an object.`);
    for(const k of s.required||[])if(!Object.hasOwn(value,k))throw new ArenaError('invalid_arguments',`${path}.${k} is required.`);
    for(const [k,v] of Object.entries(value)){if(!s.properties[k])throw new ArenaError('invalid_arguments',`Unexpected field ${path}.${k}.`);validate(v,s.properties[k],`${path}.${k}`);}return;
  }
  if(s.type==='string'&&(typeof value!=='string'||value.length<(s.minLength||0)||value.length>(s.maxLength||Infinity)))throw new ArenaError('invalid_arguments',`${path} has an invalid string length.`);
  if(s.type==='integer'&&(!Number.isInteger(value)||value<s.minimum||value>s.maximum))throw new ArenaError('invalid_arguments',`${path} must be an integer in the allowed range.`);
  if(s.enum&&!s.enum.includes(value))throw new ArenaError('invalid_arguments',`${path} has an unsupported value.`);
}
function createMcp(store,changes) {
  let waiting=0;
  async function call(name,args,signal){
    const tool=tools.find(t=>t.name===name);if(!tool)throw new ArenaError('unknown_tool','Unknown tool.');validate(args,tool.inputSchema);
    if(name==='get_rules')return {rules:RULES,tools:tools.map(t=>t.name),instructions:'Ask the user for a match invitation. Join once, keep agent_id stable, get an observation, submit one legal action when your_turn is true, otherwise wait_for_turn. Continue until finished, subject to client permissions and usage limits. The seat token authorizes one seat; it does not attest which model or process is using it.'};
    if(name==='join_match')return store.join(args);
    if(name==='submit_action')return store.act(args);
    if(name==='get_observation')return store.observe(args.match_id,args.seat_token);
    if(name==='get_match_result'){const o=store.observe(args.match_id,args.seat_token);return {phase:o.match.phase,winner:o.match.winner,reason:o.match.reason,turn:o.match.turn,agents:o.match.agents,replay_path:`/api/matches/${args.match_id}/replay`};}
    if(name==='wait_for_turn'){
      const initial=store.observe(args.match_id,args.seat_token);
      if(initial.your_turn||initial.match.phase==='finished')return initial;
      if(waiting>=100)throw new ArenaError('busy','Too many waiting connections. Try again shortly.',429);
      waiting++;
      try{return await new Promise((resolve,reject)=>{
        let timer;
        const cleanup=()=>{clearTimeout(timer);changes.off(args.match_id,check);signal?.removeEventListener('abort',abort);};
        const finish=()=>{cleanup();try{resolve(store.observe(args.match_id,args.seat_token));}catch(e){reject(e);}};
        const check=()=>{try{const o=store.observe(args.match_id,args.seat_token);if(o.your_turn||o.match.phase==='finished')finish();}catch(e){cleanup();reject(e);}};
        const abort=()=>{cleanup();reject(new ArenaError('cancelled','Waiting connection closed. Reconnect and get an observation.'));};
        timer=setTimeout(finish,(args.wait_seconds||20)*1000);changes.on(args.match_id,check);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
      });}finally{waiting--;}
    }
  }
  return {tools,call};
}
module.exports={createMcp,tools};
