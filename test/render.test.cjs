'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const path=require('node:path');
const {renderConfig}=require('../server/render.cjs');
test('Render uses its HTTPS domain, generated host key, assigned port, and temporary SQLite',()=>{
  const config=renderConfig({RENDER_EXTERNAL_URL:'https://arena-test.onrender.com',ARENA_ADMIN_TOKEN:'k'.repeat(32),PORT:'10000'});
  assert.equal(config.publicOrigin,'https://arena-test.onrender.com');assert.equal(config.port,10000);assert.ok(config.dbPath.endsWith(path.join('agent-arena','arena.sqlite')));
});
test('Render deployment rejects missing credentials, insecure origins, and invalid ports',()=>{
  assert.throws(()=>renderConfig({}),/RENDER_EXTERNAL_URL/);
  assert.throws(()=>renderConfig({RENDER_EXTERNAL_URL:'https://arena.onrender.com'}),/ARENA_ADMIN_TOKEN/);
  const base={RENDER_EXTERNAL_URL:'https://arena.onrender.com',ARENA_ADMIN_TOKEN:'k'.repeat(32)};
  for(const url of ['http://arena.onrender.com','https://user:pass@arena.onrender.com','https://arena.onrender.com/mcp','https://arena.onrender.com?x=1'])assert.throws(()=>renderConfig({...base,RENDER_EXTERNAL_URL:url}),/HTTPS origin/);
  assert.throws(()=>renderConfig({...base,PORT:'bad'}),/PORT/);
});
test('deployment blueprint requests only Free compute with no paid disk or database',()=>{
  const yaml=readFileSync(path.join(__dirname,'../render.yaml'),'utf8');assert.match(yaml,/plan: free/);assert.doesNotMatch(yaml,/^\s*(disk|databases):/m);assert.match(yaml,/generateValue: true/);assert.match(yaml,/value: ephemeral/);
});
