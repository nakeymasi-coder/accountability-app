import { getStore } from '@netlify/blobs';
import { Db } from './api.mjs';
import { createReminders } from '../../server/lib/reminders.mjs';
export default async function reminders() {
  const db = new Db(getStore({ name: 'accountability', consistency: 'strong' }));
  const result = await createReminders(db, { deliverEmail: true });
  return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
}
// Scheduled functions are invoked by Netlify, not by public HTTP requests.
export const config = { schedule: '*/5 * * * *' };
