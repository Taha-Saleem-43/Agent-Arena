'use strict';

const WALLS = [[2,1],[4,1],[1,3],[3,3],[5,3],[2,5],[4,5]];
const PICKUPS = [[1,1],[5,1],[3,2],[3,4],[1,5],[5,5]];
const RULES = Object.freeze({
  version: 'foundry-1', boardSize: 7, maxTurns: 60, attackRange: 3,
  attackCost: 2, damage: 18, coveredDamage: 12, maxEnergy: 6,
  energyPerTurn: 1, pickupEnergy: 3, pickupRepair: 8,
  dangerDamage: 9, dangerStartsAfter: [24,40], consecutiveTimeoutsToForfeit: 3,
  description: 'Full board visibility. Alternate one orthogonal move, attack, or wait. Attacks require range and unobstructed line of sight; touching a cover corner blocks a shot. Adjacent cover reduces damage. Energy regenerates before each accepted turn. Danger damages the acting agent after its action. After 60 actions remaining integrity decides; equal integrity is a draw. Three consecutive timeouts for a seat forfeit the match.'
});
const same = (a,b) => a.x === b.x && a.y === b.y;
const distance = (a,b) => Math.abs(a.x-b.x)+Math.abs(a.y-b.y);
const isWall = p => WALLS.some(([x,y]) => x===p.x && y===p.y);
const ring = turn => turn >= 40 ? 2 : turn >= 24 ? 1 : 0;
const danger = (p,turn) => Math.min(p.x,p.y,6-p.x,6-p.y) < ring(turn);
const cover = p => WALLS.some(([x,y]) => Math.abs(x-p.x)+Math.abs(y-p.y)===1);

function clearSight(a,b) {
  // Segment versus each closed cover square. Corner contacts count as blocked.
  return !WALLS.some(([x,y]) => {
    let low=0, high=1;
    for (const [start,delta,min,max] of [[a.x,b.x-a.x,x-.5,x+.5],[a.y,b.y-a.y,y-.5,y+.5]]) {
      if (delta===0) { if(start<min || start>max) return false; }
      else { const t0=(min-start)/delta,t1=(max-start)/delta; low=Math.max(low,Math.min(t0,t1)); high=Math.min(high,Math.max(t0,t1)); if(low>high) return false; }
    }
    return high>0 && low<1;
  });
}
function initialState(id, now, turnMs) {
  return {id, rulesVersion:RULES.version, phase:'waiting', turn:0, version:0,
    turnMs, deadline:null, createdAt:now, updatedAt:now, winner:null, reason:null,
    agents:[{name:'ATLAS',joined:false,x:0,y:3,hp:100,energy:3,damage:0,timeouts:0,lastAction:'Waiting for an external agent.'},
      {name:'EMBER',joined:false,x:6,y:3,hp:100,energy:3,damage:0,timeouts:0,lastAction:'Waiting for an external agent.'}],
    pickups:PICKUPS.map(([x,y])=>({x,y}))};
}
function legalActions(s,seat) {
  if(s.phase!=='active' || s.turn%2!==seat) return [];
  const a=s.agents[seat], b=s.agents[1-seat];
  const moves=[[0,-1],[1,0],[0,1],[-1,0]].map(([dx,dy])=>({type:'move',x:a.x+dx,y:a.y+dy})).filter(p=>p.x>=0&&p.x<7&&p.y>=0&&p.y<7&&!isWall(p)&&!same(p,b));
  if(distance(a,b)<=3 && clearSight(a,b) && Math.min(6,a.energy+1)>=2) moves.push({type:'attack'});
  moves.push({type:'wait'});
  return moves;
}
function finish(s,reason,now,forcedWinner) {
  s.phase='finished'; s.deadline=null; s.reason=reason;
  s.winner=forcedWinner!==undefined?forcedWinner:s.agents[0].hp===s.agents[1].hp?null:s.agents[0].hp>s.agents[1].hp?0:1;
  s.updatedAt=now;
}
function applyAction(s,seat,action,now,{timeout=false}={}) {
  const legal=legalActions(s,seat);
  if(!legal.some(p=>JSON.stringify(p)===JSON.stringify(action))) throw new Error('Action is not legal. Choose an action from legal_actions.');
  const a=s.agents[seat],b=s.agents[1-seat];
  a.energy=Math.min(6,a.energy+1); a.timeouts=timeout?a.timeouts+1:0;
  let message;
  if(action.type==='move') {
    a.x=action.x;a.y=action.y;
    message=`Moves to ${String.fromCharCode(65+a.x)}${a.y+1}.`;
    const pickup=s.pickups.findIndex(p=>same(p,a));
    if(pickup>=0){s.pickups.splice(pickup,1);a.energy=Math.min(6,a.energy+3);a.hp=Math.min(100,a.hp+8);message+=' Collects energy (+3) and repairs (+8).';}
  } else if(action.type==='attack') {
    const amount=cover(b)?12:18;a.energy-=2;b.hp=Math.max(0,b.hp-amount);a.damage+=amount;
    message=`Attacks ${b.name} for ${amount} damage${cover(b)?' through cover':''}.`;
  } else message=timeout?'Turn deadline missed; automatic wait.':'Holds position and conserves energy.';
  if(danger(a,s.turn)){a.hp=Math.max(0,a.hp-9);message+=' Danger zone deals 9 damage.';}
  a.lastAction=message;s.turn++;s.updatedAt=now;s.deadline=now+s.turnMs;
  if(a.timeouts>=3) finish(s,'timeout_forfeit',now,1-seat);
  else if(s.agents.some(p=>p.hp<=0)) finish(s,'elimination',now);
  else if(s.turn>=60) finish(s,'turn_limit',now);
  return {kind:timeout?'timeout':'action',seat,action,message};
}
function publicState(s) {
  return {...structuredClone(s), activeSeat:s.phase==='active'?s.turn%2:null,
    dangerRing:ring(s.turn),walls:WALLS.map(([x,y])=>({x,y}))};
}
module.exports={RULES,WALLS,initialState,legalActions,applyAction,publicState,clearSight,danger,cover};
