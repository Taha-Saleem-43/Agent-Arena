'use strict';
const {DatabaseSync}=require('node:sqlite');
const {mkdirSync}=require('node:fs');
const path=require('node:path');
const {ArenaStore:CoreStore,ArenaError}=require('./store-core.cjs');
class ArenaStore extends CoreStore {
  constructor(filename,options={}) {
    if(filename!==':memory:')mkdirSync(path.dirname(filename),{recursive:true});
    const db=new DatabaseSync(filename);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    super(db,options);
  }
}
module.exports={ArenaStore,ArenaError};
