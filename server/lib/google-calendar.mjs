import crypto from 'node:crypto';
const SCOPE = 'https://www.googleapis.com/auth/calendar.app.created';
const origin = () => (process.env.URL || 'https://accountability-app-glam.netlify.app').replace(/\/$/,'');
const digest = v => crypto.createHash('sha256').update(v).digest('hex');
export const googleReady = () => Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
function encrypt(value) {
  const iv=crypto.randomBytes(12), key=crypto.createHash('sha256').update(process.env.GOOGLE_CLIENT_SECRET).digest();
  const cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
  const data=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
  return [iv,cipher.getAuthTag(),data].map(b=>b.toString('base64url')).join('.');
}
function decrypt(value) {
  const [iv,tag,data]=value.split('.').map(v=>Buffer.from(v,'base64url'));
  const decipher=crypto.createDecipheriv('aes-256-gcm',crypto.createHash('sha256').update(process.env.GOOGLE_CLIENT_SECRET).digest(),iv);
  decipher.setAuthTag(tag);return JSON.parse(Buffer.concat([decipher.update(data),decipher.final()]).toString('utf8'));
}
async function oauth(values) {
  const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',signal:AbortSignal.timeout(8000),headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(values)});
  if(!response.ok)throw Error('Google needs you to reconnect your calendar.');
  return response.json();
}
async function google(access,path,method='GET',body) {
  const response=await fetch('https://www.googleapis.com/calendar/v3'+path,{method,signal:AbortSignal.timeout(8000),headers:{Authorization:`Bearer ${access}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
  if(!response.ok){const error=Error('Calendar update could not finish. Try Sync now or reconnect.');error.status=response.status;throw error;}
  return response.status===204?{}:response.json();
}
export async function beginGoogle(db,userId) {
  if(!googleReady())throw Error('The owner must finish Google Calendar setup before members can connect.');
  const state=crypto.randomBytes(32).toString('hex'), verifier=crypto.randomBytes(32).toString('base64url');
  await db.insertWithId('google_oauth_states',{id:digest(state),user_id:userId,verifier:encrypt(verifier),expires_at:new Date(Date.now()+10*60000).toISOString(),used_at:null});
  const params=new URLSearchParams({client_id:process.env.GOOGLE_CLIENT_ID,redirect_uri:origin()+'/api/google/callback',response_type:'code',scope:SCOPE,state,access_type:'offline',prompt:'consent',code_challenge:crypto.createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'});
  return 'https://accounts.google.com/o/oauth2/v2/auth?'+params;
}
export async function finishGoogle(db,query) {
  const state=String(query.state||'');if(!/^[a-f0-9]{64}$/.test(state))throw Error('Invalid calendar connection.');
  const record=await db.getDirect('google_oauth_states',digest(state));
  if(!record||record.used_at||new Date(record.expires_at)<=new Date())throw Error('Calendar connection expired.');
  await db.compareUpdate('google_oauth_states',record.id,row=>{if(row.used_at||new Date(row.expires_at)<=new Date())throw Error('Calendar connection expired.');return {...row,used_at:new Date().toISOString()};});
  if(query.error||!query.code)throw Error('Calendar permission was not granted.');
  if(!await db.getDirect('profiles',record.user_id))throw Error('Account no longer exists.');
  const tokens=await oauth({client_id:process.env.GOOGLE_CLIENT_ID,client_secret:process.env.GOOGLE_CLIENT_SECRET,code:String(query.code),grant_type:'authorization_code',redirect_uri:origin()+'/api/google/callback',code_verifier:decrypt(record.verifier)});
  if(!tokens.refresh_token||!tokens.access_token||!(tokens.scope||'').split(' ').includes(SCOPE))throw Error('Google did not grant calendar sync. Please reconnect and approve calendar access.');
  const previous=await db.getDirect('google_connections',record.user_id);
  const calendar=previous?.calendar_id?{id:previous.calendar_id}:await google(tokens.access_token,'/calendars','POST',{summary:'Glam Accountability',description:'Your accountability commitments. Private to your Google account.',timeZone:'UTC'});
  await db.insertWithId('google_connections',{id:record.user_id,user_id:record.user_id,calendar_id:calendar.id,tokens:encrypt({...tokens,expires_at:Date.now()+(tokens.expires_in||3600)*1000}),status:'connected',last_synced_at:null,last_error:''});
  return record.user_id;
}
async function accessToken(db,connection) {
  let tokens=decrypt(connection.tokens);
  if(tokens.expires_at>Date.now()+60000)return tokens.access_token;
  const fresh=await oauth({client_id:process.env.GOOGLE_CLIENT_ID,client_secret:process.env.GOOGLE_CLIENT_SECRET,refresh_token:tokens.refresh_token,grant_type:'refresh_token'});
  tokens={...tokens,...fresh,expires_at:Date.now()+(fresh.expires_in||3600)*1000};
  connection.tokens=encrypt(tokens);await db.update('google_connections',connection);return tokens.access_token;
}
export function memberCalendarEvent(request,userId,matches) {
  const participating=request.requester_id===userId||matches.some(m=>m.request_id===request.id&&m.partner_id===userId&&['active','completed','no_show'].includes(m.status));
  if(!participating||request.status==='cancelled')return null;
  const start=new Date(request.scheduled_for);if(isNaN(start))return null;
  return {id:digest(`accountability:${request.id}:${userId}`),summary:request.title,description:`${request.what_needed||''}\n\nSupport needed: ${request.partner_duties||''}${request.link_url?'\n'+request.link_url:''}`,location:request.location_or_link||'',start:{dateTime:start.toISOString()},end:{dateTime:new Date(start.getTime()+request.duration_minutes*60000).toISOString()},visibility:'private',reminders:{useDefault:false,overrides:[{method:'popup',minutes:60},{method:'popup',minutes:15}]}};
}
export async function syncMemberCalendar(db,userId,{limit=40}={}) {
  const connection=await db.getDirect('google_connections',userId);if(!connection||!googleReady())return {connected:false};
  try {
    const access=await accessToken(db,connection),requests=await db.all('accountability_requests'),matches=await db.all('matches');
    const base='/calendars/'+encodeURIComponent(connection.calendar_id)+'/events';
    const previous=(await db.all('google_event_sync')).filter(e=>e.user_id===userId);
    const candidates=requests.filter(r=>r.requester_id===userId||matches.some(m=>m.request_id===r.id&&m.partner_id===userId)||previous.some(e=>e.request_id===r.id)).sort((a,b)=>b.updated_at?.localeCompare(a.updated_at||'')||0);
    let updated=0;const deadline=Date.now()+18000;
    for(const request of candidates) {
      if(Date.now()>deadline||updated>=limit)break;
      const event=memberCalendarEvent(request,userId,matches),id=digest(`accountability:${request.id}:${userId}`),stamp=digest(JSON.stringify(event));
      const old=previous.find(e=>e.request_id===request.id);
      if(old?.stamp===stamp)continue;
      if(event) {
        try{await google(access,base+'/'+id,'PUT',event);}catch(error){if(error.status!==404)throw error;try{await google(access,base,'POST',event);}catch(e){if(e.status!==409)throw e;await google(access,base+'/'+id,'PUT',event);}}
      } else if(old) {try{await google(access,base+'/'+id,'DELETE');}catch(error){if(![404,410].includes(error.status))throw error;}}
      await db.insertWithId('google_event_sync',{id:digest(userId+':'+request.id),user_id:userId,request_id:request.id,stamp});updated++;
    }
    connection.last_synced_at=new Date().toISOString();connection.last_error='';connection.status='connected';await db.update('google_connections',connection);return {connected:true,updated};
  }catch(error){connection.last_error='Sync needs attention. Try Sync now, or disconnect and reconnect Google.';await db.update('google_connections',connection);throw Error(connection.last_error);}
}
export async function syncConnectedMembers(db) {
  const connections=(await db.all('google_connections')).slice().sort((a,b)=>(a.last_synced_at||'').localeCompare(b.last_synced_at||''));let synced=0;const deadline=Date.now()+18000;
  for(const c of connections){if(Date.now()>deadline)break;try{await syncMemberCalendar(db,c.user_id,{limit:10});synced++;}catch(_){}}
  return synced;
}
