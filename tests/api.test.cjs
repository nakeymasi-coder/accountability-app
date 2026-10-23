const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
let source = fs.readFileSync('netlify/functions/api.mjs','utf8').replace('import { getStore } from "@netlify/blobs";', '').replace('import crypto from "node:crypto";', '').replace('export default async function handlerV2','async function handlerV2').replace('export async function handler','async function handler');
source += '\nthis.subject = { handle, Db };';
const context = { crypto, process, console, URL, Response };
vm.runInNewContext(source, context);
const { handle, Db } = context.subject;
function fixture() {
  const rows = new Map();
  const store = { async *list({prefix}) { const blobs=[...rows.keys()].filter(k=>k.startsWith(prefix)).map(key=>({key})); for(let i=0;i<blobs.length;i+=2) yield {blobs:blobs.slice(i,i+2)}; }, async get(k){return rows.has(k)?structuredClone(rows.get(k)):null},async getWithMetadata(k){const data=await this.get(k);return data?{data,etag:JSON.stringify(data)}:null},async setJSON(k,v,options={}){if(options.onlyIfMatch && JSON.stringify(rows.get(k))!==options.onlyIfMatch)return {modified:false};rows.set(k,structuredClone(v));return {modified:true}},async delete(k){rows.delete(k)} };
  const db = new Db(store);
  const seed = (table,row)=>store.setJSON(`rec:${table}:${row.id}`,row);
  const auth = { authorization:'Bearer test' };
  seed('profiles',{id:'owner',email:'nakeymasi@gmail.com',display_name:'Owner'});
  seed('profiles',{id:'partner',email:'partner@example.com',display_name:'Partner'});
  seed('sessions',{id:crypto.createHash('sha256').update('test').digest('hex'),token_hash:crypto.createHash('sha256').update('test').digest('hex'),user_id:'owner',expires_at:'2099-01-01'});
  return {db,seed,rows,store,call:(method,path,body={})=>handle(db,method,path,auth,body,'test')};
}
test('all records are read across multiple pages; storage failure is not an empty table', async()=>{
 const f=fixture(); for(let i=0;i<7;i++) await f.seed('messages',{id:String(i)});
 assert.equal((await f.db.all('messages')).length,7);
 f.store.list=async function*(){throw Error('outage')};
 await assert.rejects(()=>f.db.all('invites'),/outage/);
});
test('request rejects past times, invalid duration and missing date',async()=>{
 for(const values of [{scheduled_for:'2000-01-01',duration_minutes:30},{scheduled_for:'2099-01-01',duration_minutes:5.5},{duration_minutes:30}]){
 const f=fixture(); await assert.rejects(()=>f.call('POST','/api/requests',{title:'Test',what_needed:'Help',partner_duties:'Check in',...values}),e=>e.status===400);
 }
});
test('no-show closes request and a terminal match cannot reopen it',async()=>{
 const f=fixture(); await f.seed('accountability_requests',{id:'r',status:'matched'});await f.seed('matches',{id:'m',request_id:'r',requester_id:'owner',partner_id:'partner',status:'active'});
 await f.call('PATCH','/api/matches/m',{status:'no_show'});
 assert.equal((await f.db.get('accountability_requests','r')).status,'no_show');
 await assert.rejects(()=>f.call('PATCH','/api/matches/m',{status:'released'}),e=>e.status===409);
});
test('cancellation updates request, match and calendar together',async()=>{
 const f=fixture(); await f.seed('accountability_requests',{id:'r',requester_id:'owner',status:'matched'});await f.seed('matches',{id:'m',request_id:'r',status:'active'});await f.seed('calendar_events',{id:'e',request_id:'r',status:'scheduled'});
 await f.call('PATCH','/api/requests/r',{status:'cancelled'});
 assert.equal((await f.db.get('matches','m')).status,'released');assert.equal((await f.db.get('calendar_events','e')).status,'cancelled');
});
test('deleting partner reopens surviving request; deletes replies on owned requests',async()=>{
 const f=fixture(); await f.seed('accountability_requests',{id:'other',requester_id:'partner',status:'matched'});await f.seed('accountability_requests',{id:'own',requester_id:'owner',status:'open'});await f.seed('matches',{id:'m',request_id:'other',requester_id:'partner',partner_id:'owner',status:'active'});await f.seed('messages',{id:'reply',request_id:'own',sender_id:'partner'});
 await f.call('DELETE','/api/account'); assert.equal((await f.db.get('accountability_requests','other')).status,'open');assert.equal(await f.db.get('messages','reply'),null);
});
test('password reset does not claim to send an email',async()=>{
 const f=fixture();const result=await f.call('POST','/api/auth/password-reset',{email:'unknown@example.com'});assert.match(result.obj.message,/No reset email has been sent/);
});

test('simultaneous claims allow only one partner',async()=>{
 const f=fixture(); await f.seed('accountability_requests',{id:'r',requester_id:'partner',scheduled_for:'2099-01-01',duration_minutes:30,title:'Test',status:'open'});
 await f.seed('profiles',{id:'third',email:'third@example.com'});
 const tokenHash=crypto.createHash('sha256').update('third').digest('hex');
 await f.seed('sessions',{id:tokenHash,token_hash:tokenHash,user_id:'third',expires_at:'2099-01-01'});
 const outcomes=await Promise.allSettled([f.call('POST','/api/requests/r/claim'),handle(new Db(f.store),'POST','/api/requests/r/claim',{authorization:'Bearer third'},{},'third')]);
 assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
 assert.equal((await new Db(f.store).all('matches')).length,1);
 assert.equal((await new Db(f.store).all('calendar_events')).length,1);
});
