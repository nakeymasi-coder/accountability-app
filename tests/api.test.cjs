const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
let source = fs.readFileSync('netlify/functions/api.mjs','utf8').replace(/^import .*;$/gm, '').replace('export { Db };', '').replace('export default async function handlerV2','async function handlerV2').replace('export async function handler','async function handler');
source += '\nthis.subject = { handle, Db };';
const reminderModule = import('../server/lib/reminders.mjs');
const context = { crypto, process, console, URL, Response, googleReady: () => false, emailConfigured: () => false, sendAccountabilityEmail: async () => { throw Error('not configured'); }, createReminders: async (...args) => (await reminderModule).createReminders(...args) };
vm.runInNewContext(source, context);
const { handle, Db } = context.subject;
function fixture() {
  const rows = new Map();
  const store = { async *list({prefix}) { const blobs=[...rows.keys()].filter(k=>k.startsWith(prefix)).map(key=>({key})); for(let i=0;i<blobs.length;i+=2) yield {blobs:blobs.slice(i,i+2)}; }, async get(k){return rows.has(k)?structuredClone(rows.get(k)):null},async getWithMetadata(k){const data=await this.get(k);return data?{data,etag:JSON.stringify(data)}:null},async setJSON(k,v,options={}){if(options.onlyIfNew && rows.has(k))return {modified:false};if(options.onlyIfMatch && JSON.stringify(rows.get(k))!==options.onlyIfMatch)return {modified:false};rows.set(k,structuredClone(v));return {modified:true}},async delete(k){rows.delete(k)} };
  const db = new Db(store);
  const seed = (table,row)=>store.setJSON(`rec:${table}:${row.id}`,row);
  const auth = { authorization:'Bearer test' };
  seed('profiles',{id:'owner',email:'nakeymasi@gmail.com',display_name:'Owner'});
  seed('profiles',{id:'partner',email:'partner@example.com',display_name:'Partner'});
  seed('sessions',{id:crypto.createHash('sha256').update('test').digest('hex'),token_hash:crypto.createHash('sha256').update('test').digest('hex'),user_id:'owner',expires_at:'2099-01-01'});
  return {db,seed,rows,store,call:async(method,path,body={})=>{context.reminderEmail=(await reminderModule).reminderEmail;return handle(db,method,path,auth,body,'test')}};
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
 const f=fixture();await assert.rejects(()=>f.call('POST','/api/auth/password-reset',{email:'unknown@example.com'}),e=>e.status===503);
});

test('different members can support the same request simultaneously',async()=>{
 const f=fixture(); await f.seed('accountability_requests',{id:'r',requester_id:'partner',scheduled_for:'2099-01-01',duration_minutes:30,title:'Test',status:'open'});
 await f.seed('profiles',{id:'third',email:'third@example.com'});
 const tokenHash=crypto.createHash('sha256').update('third').digest('hex');
 await f.seed('sessions',{id:tokenHash,token_hash:tokenHash,user_id:'third',expires_at:'2099-01-01'});
 const outcomes=await Promise.allSettled([f.call('POST','/api/requests/r/claim'),handle(new Db(f.store),'POST','/api/requests/r/claim',{authorization:'Bearer third'},{},'third')]);
 assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,2);
 assert.equal((await new Db(f.store).all('matches')).length,2);
 assert.equal((await new Db(f.store).all('calendar_events')).length,2);
 const calendar=await f.call('GET','/api/calendar');assert.equal(calendar.obj.events.length,1);assert.equal(calendar.obj.events[0].supporters.length,2);
});

test('repeat join by the same member creates only one commitment', async()=>{
 const f=fixture();await f.seed('accountability_requests',{id:'r',requester_id:'partner',scheduled_for:'2099-01-01',duration_minutes:30,title:'Test',status:'open'});
 await Promise.all([f.call('POST','/api/requests/r/claim'),handle(new Db(f.store),'POST','/api/requests/r/claim',{authorization:'Bearer test'},{},'test')]);
 assert.equal((await new Db(f.store).all('matches')).length,1);
 assert.equal((await new Db(f.store).all('calendar_events')).length,1);
});
test('one supporter leaving keeps other supporters active',async()=>{
 const f=fixture();await f.seed('accountability_requests',{id:'r',requester_id:'partner',status:'matched'});
 await f.seed('matches',{id:'m1',request_id:'r',partner_id:'owner',requester_id:'partner',status:'active'});
 await f.seed('matches',{id:'m2',request_id:'r',partner_id:'third',requester_id:'partner',status:'active'});
 await f.call('PATCH','/api/matches/m1',{status:'released'});
 assert.equal((await f.db.get('accountability_requests','r')).status,'matched');
 assert.equal((await f.db.get('matches','m2')).status,'active');
});

test('reset emails contain a one-time token; password changes revoke sessions', async()=>{
 const f=fixture();let sent;
 context.emailConfigured=()=>true;context.sendAccountabilityEmail=async email=>{sent=email;return 'email-id'};
 try {
  await f.seed('credentials',{id:'cred',user_id:'owner',password_hash:'old',password_salt:'old'});
  const result=await f.call('POST','/api/auth/password-reset',{email:'nakeymasi@gmail.com'});
  assert.equal(result.status,200);assert.equal(result.obj.resetToken,undefined);
  const token=sent.text.match(/#reset=([a-f0-9]{64})/)[1];
  const stored=[...f.rows.values()].find(r=>r.credential_id==='cred');assert.notEqual(stored.id,token);
  await f.call('POST','/api/auth/password-reset/confirm',{resetToken:token,password:'new-password-123'});
  assert.equal((await f.db.all('sessions')).length,0);
  const cred=await f.db.get('credentials','cred');assert.notEqual(cred.password_hash,'old');
  await assert.rejects(()=>f.call('POST','/api/auth/password-reset/confirm',{resetToken:token,password:'another-password'}),e=>e.status===400);
 } finally {context.emailConfigured=()=>false;}
});
test('expired reset links cannot change credentials',async()=>{
 const f=fixture();const token='a'.repeat(64);const id=crypto.createHash('sha256').update(token).digest('hex');
 await f.seed('password_resets',{id,credential_id:'cred',user_id:'owner',expires_at:'2000-01-01',used_at:null});
 await assert.rejects(()=>f.call('POST','/api/auth/password-reset/confirm',{resetToken:token,password:'new-password'}),e=>e.status===400);
});
test('reminders deduplicate requesters across multiple supporters and repeated runs',async()=>{
 const {createReminders}=await reminderModule;const f=fixture();const nowMs=Date.now();
 await f.seed('accountability_requests',{id:'r',requester_id:'owner',title:'Test',scheduled_for:new Date(nowMs+30*60000).toISOString(),status:'matched'});
 await f.seed('matches',{id:'m',request_id:'r',requester_id:'owner',partner_id:'partner',status:'active'});
 await f.seed('matches',{id:'m2',request_id:'r',requester_id:'owner',partner_id:'partner',status:'active'});
 await createReminders(f.db,{nowMs});await createReminders(new Db(f.store),{nowMs});
 assert.equal((await new Db(f.store).all('notifications')).length,2);
 await createReminders(new Db(f.store),{nowMs:nowMs+20*60000});
 assert.equal((await new Db(f.store).all('notifications')).length,4);
});
test('reminder email is opt-in and never repeats after successful delivery',async()=>{
 const {createReminders}=await reminderModule;const f=fixture();const nowMs=Date.now();let sends=0;
 await f.seed('profiles',{id:'owner',email:'owner@example.com',reminder_email_opt_in:true});
 await f.seed('accountability_requests',{id:'r',requester_id:'owner',title:'Test',scheduled_for:new Date(nowMs+30*60000).toISOString(),status:'open'});
 const options={nowMs,deliverEmail:true,configured:()=>true,send:async()=>{sends++;return 'ok'}};
 await createReminders(f.db,options);await createReminders(new Db(f.store),options);assert.equal(sends,1);
});
test('notifications belong only to the signed-in member',async()=>{
 const f=fixture();const starts_at=new Date(Date.now()+120*60000).toISOString();
 await f.seed('accountability_requests',{id:'r',requester_id:'owner',title:'Test',scheduled_for:starts_at,status:'open'});
 await f.seed('notifications',{id:'other',user_id:'partner',request_id:'r',starts_at});
 const result=await f.call('GET','/api/notifications');assert.equal(result.obj.notifications.length,0);
});

test('email service status is current and never exposes credentials',async()=>{
 const f=fixture();context.emailConfigured=()=>true;
 try {const r=await f.call('GET','/api/services');assert.equal(r.obj.emailReady,true);assert.equal(r.obj.personalEmailConnectionRequired,false);assert.equal(Object.keys(r.obj).length,2);}
 finally {context.emailConfigured=()=>false;}
});
test('test reminder sends only to the signed-in account email',async()=>{
 const f=fixture();let sent;context.emailConfigured=()=>true;context.sendAccountabilityEmail=async value=>{sent=value;return 'ok'};
 try {await f.call('POST','/api/me/test-reminder',{email:'someone-else@example.com'});assert.equal(sent.to,'nakeymasi@gmail.com');assert.match(sent.subject,/Test/);}
 finally {context.emailConfigured=()=>false;}
});
test('unsupported integrations are clearly distinguished from available features',async()=>{
 const f=fixture();await f.seed('user_roles',{id:'admin',user_id:'owner',role:'admin'});
 const r=await f.call('GET','/api/admin/integrations');
 assert.equal(r.obj.integrations.find(x=>x.provider==='Private Google Calendar sync').status,'Owner Google setup required');
 assert.equal(r.obj.integrations.find(x=>x.provider==='Shared app calendar').status,'Available');
});

test('new request notifications are per-member and visible only to their recipient',async()=>{
 const f=fixture();await f.call('POST','/api/requests',{title:'Test new request',what_needed:'Help',partner_duties:'Check in',scheduled_for:'2099-01-01',duration_minutes:30});
 const notes=await f.db.all('notifications');assert.equal(notes.length,1);assert.equal(notes[0].user_id,'partner');assert.equal(notes[0].kind,'request_posted');
 const own=await f.call('GET','/api/notifications');assert.equal(own.obj.notifications.length,0);
});
test('Google connection status never exposes another member tokens',async()=>{
 const f=fixture();await f.seed('google_connections',{id:'partner',user_id:'partner',tokens:'secret',calendar_id:'private'});
 const result=await f.call('GET','/api/google/status');assert.equal(result.obj.connected,false);assert.equal(JSON.stringify(result).includes('secret'),false);
});
test('Google events contain only a member own commitments without attendees',async()=>{
 const {memberCalendarEvent}=await import('../server/lib/google-calendar.mjs');
 const r={id:'r',requester_id:'owner',title:'Test',what_needed:'Help',partner_duties:'Check in',scheduled_for:'2099-01-01',duration_minutes:30,status:'open'};
 assert.equal(memberCalendarEvent(r,'stranger',[]),null);
 const event=memberCalendarEvent(r,'owner',[]);assert.equal(event.visibility,'private');assert.equal('attendees' in event,false);
 assert.equal(memberCalendarEvent({...r,status:'cancelled'},'owner',[]),null);
});
test('Google authorization uses single-purpose scope and stores no plaintext state verifier',async()=>{
 const {beginGoogle}=await import('../server/lib/google-calendar.mjs');const f=fixture();
 const oldId=process.env.GOOGLE_CLIENT_ID,oldSecret=process.env.GOOGLE_CLIENT_SECRET;
 process.env.GOOGLE_CLIENT_ID='test-client';process.env.GOOGLE_CLIENT_SECRET='test-secret';
 try {const url=new URL(await beginGoogle(f.db,'owner'));assert.equal(url.searchParams.get('scope'),'https://www.googleapis.com/auth/calendar.app.created');assert.equal(url.searchParams.get('code_challenge_method'),'S256');const state=await f.db.all('google_oauth_states');assert.notEqual(state[0].id,url.searchParams.get('state'));assert.match(state[0].verifier,/^[^.]+\.[^.]+\.[^.]+$/);}
 finally {if(oldId===undefined)delete process.env.GOOGLE_CLIENT_ID;else process.env.GOOGLE_CLIENT_ID=oldId;if(oldSecret===undefined)delete process.env.GOOGLE_CLIENT_SECRET;else process.env.GOOGLE_CLIENT_SECRET=oldSecret;}
});

test('Google callback encrypts tokens, rejects replay and syncs only the member calendar',async()=>{
 const {beginGoogle,finishGoogle,syncMemberCalendar}=await import('../server/lib/google-calendar.mjs');const f=fixture();
 const oldFetch=global.fetch,oldId=process.env.GOOGLE_CLIENT_ID,oldSecret=process.env.GOOGLE_CLIENT_SECRET;const calls=[];
 process.env.GOOGLE_CLIENT_ID='test-client';process.env.GOOGLE_CLIENT_SECRET='test-secret';
 global.fetch=async(url,options)=>{calls.push({url,options});if(url.includes('oauth2.googleapis.com/token'))return new Response(JSON.stringify({access_token:'access-secret',refresh_token:'refresh-secret',expires_in:3600,scope:'https://www.googleapis.com/auth/calendar.app.created'}),{status:200});if(url.endsWith('/calendars'))return new Response(JSON.stringify({id:'my-private-calendar'}),{status:200});return new Response('{}',{status:200});};
 try {
  const url=new URL(await beginGoogle(f.db,'owner'));const query={state:url.searchParams.get('state'),code:'code'};
  await finishGoogle(f.db,query);const c=await f.db.get('google_connections','owner');assert.equal(c.tokens.includes('refresh-secret'),false);
  await assert.rejects(()=>finishGoogle(f.db,query),/expired/);
  await f.seed('accountability_requests',{id:'own',requester_id:'owner',title:'Mine',what_needed:'Help',scheduled_for:'2099-01-01',duration_minutes:30,status:'open'});
  await f.seed('accountability_requests',{id:'other',requester_id:'partner',title:'Other private request',scheduled_for:'2099-01-01',duration_minutes:30,status:'open'});
  const result=await syncMemberCalendar(f.db,'owner');assert.equal(result.updated,1);assert.equal(calls.filter(x=>x.url.includes('/events/')).length,1);assert.equal(calls.some(x=>String(x.options.body||'').includes('Other private request')),false);
 } finally {global.fetch=oldFetch;if(oldId===undefined)delete process.env.GOOGLE_CLIENT_ID;else process.env.GOOGLE_CLIENT_ID=oldId;if(oldSecret===undefined)delete process.env.GOOGLE_CLIENT_SECRET;else process.env.GOOGLE_CLIENT_SECRET=oldSecret;}
});

test('reusable invite allows multiple separate member accounts and remains active',async()=>{
 const f=fixture();await f.seed('invites',{id:'shared',code:'COMMUNITY',max_uses:null,use_count:0,is_active:true,expires_at:null});
 for(let n=0;n<3;n++) {const result=await f.call('POST','/api/auth/signup',{name:'Member '+n,email:`new${n}@example.com`,password:'Password123!',consent:true,inviteCode:'community'});assert.equal(result.status,201);}
 const invite=await f.db.get('invites','shared');assert.equal(invite.use_count,3);assert.equal(invite.is_active,true);
});
test('owner can upgrade existing code; new codes are reusable; disabled codes stay disabled',async()=>{
 const f=fixture();await f.seed('user_roles',{id:'owner-admin',user_id:'owner',role:'admin'});await f.seed('invites',{id:'existing',code:'OLD',max_uses:1,use_count:1,is_active:false});await f.seed('invites',{id:'disabled',code:'OFF',max_uses:1,use_count:0,is_active:false});
 await f.call('POST','/api/admin/invites/reuse');assert.equal((await f.db.get('invites','existing')).max_uses,null);assert.equal((await f.db.get('invites','existing')).is_active,true);assert.equal((await f.db.get('invites','disabled')).is_active,false);
 assert.equal((await f.call('POST','/api/admin/invites')).obj.invite.max_uses,null);
});
