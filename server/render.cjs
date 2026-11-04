'use strict';
const path=require('node:path');
function renderConfig(env=process.env){
  const raw=env.ARENA_PUBLIC_ORIGIN||env.RENDER_EXTERNAL_URL;
  if(!raw)throw new Error('Render must supply RENDER_EXTERNAL_URL, or set ARENA_PUBLIC_ORIGIN.');
  const url=new URL(raw);
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw new Error('The public origin must be a plain HTTPS origin.');
  if(!env.ARENA_ADMIN_TOKEN||env.ARENA_ADMIN_TOKEN.length<32)throw new Error('Generate ARENA_ADMIN_TOKEN before deploying.');
  const port=Number(env.PORT||10000);
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('PORT must be a valid TCP port.');
  return {publicOrigin:url.origin,adminToken:env.ARENA_ADMIN_TOKEN,dbPath:env.ARENA_DB||path.join(env.TMPDIR||'/tmp','agent-arena','arena.sqlite'),port};
}
if(require.main===module){
  const config=renderConfig();
  const {createArenaServer}=require('./http.cjs');
  const app=createArenaServer(config);
  app.server.listen(config.port,'0.0.0.0',()=>console.log('Agent Arena listening on port '+config.port+'. Free preview: match data is ephemeral.'));
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>app.close().then(()=>process.exit(0)));
}
module.exports={renderConfig};
