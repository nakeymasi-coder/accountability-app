import { getStore } from '@netlify/blobs';
import { Db } from './api.mjs';
import { syncConnectedMembers } from '../../server/lib/google-calendar.mjs';
export default async function calendarSync() {
  const db=new Db(getStore({name:'accountability',consistency:'strong'}));
  const synced=await syncConnectedMembers(db);
  return new Response(JSON.stringify({synced}),{headers:{'Content-Type':'application/json'}});
}
export const config={schedule:'*/5 * * * *'};
