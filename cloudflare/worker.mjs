import { DurableObject } from 'cloudflare:workers';
import { Coordinator } from './handler.mjs';

// One small coordinator serializes the prototype's matches and persists their SQLite state.
export class ArenaCoordinator extends DurableObject {
  constructor(ctx,env){super(ctx,env);this.arena=new Coordinator(ctx,env);}
  fetch(request){return this.arena.fetch(request);}
  alarm(){return this.arena.alarm();}
}

export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(url.pathname==='/mcp'||url.pathname.startsWith('/api/'))return env.ARENA.get(env.ARENA.idFromName('foundry-v1')).fetch(request);
    return env.ASSETS.fetch(request);
  }
};
