// Compatibility entry point: previews must include the live referee, not just static files.
const {createArenaServer}=require('./server/http.cjs');
const app=createArenaServer();
app.server.listen(4173,'127.0.0.1',()=>console.log('Agent Arena: http://127.0.0.1:4173'));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>app.close().then(()=>process.exit(0)));
