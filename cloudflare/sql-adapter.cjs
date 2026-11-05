'use strict';
// Adapt Cloudflare's synchronous SQLite API to the referee's database interface.
function durableSqlAdapter(storage){
  return {
    exec(sql){for(const statement of sql.split(';').map(s=>s.trim()).filter(Boolean))storage.sql.exec(statement).toArray();},
    prepare(sql){return {
      run(...bindings){storage.sql.exec(sql,...bindings).toArray();},
      get(...bindings){return storage.sql.exec(sql,...bindings).toArray()[0];},
      all(...bindings){return storage.sql.exec(sql,...bindings).toArray();}
    };},
    transactionSync(fn){return storage.transactionSync(fn);},
    close(){}
  };
}
module.exports={durableSqlAdapter};
