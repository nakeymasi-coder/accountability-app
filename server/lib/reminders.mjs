import crypto from 'node:crypto';
import { emailConfigured, sendAccountabilityEmail } from './email.mjs';
const keyFor = (id) => `rec:notifications:${id}`;
export function reminderEmail(to, startsAt, id, test = false) {
  const site = process.env.URL || 'https://accountability-app-glam.netlify.app';
  return { to, subject: `${test ? '[Test] ' : ''}Your accountability commitment is coming up`, text: `${test ? 'This is a delivery test, not a real commitment.\n\n' : ''}Your commitment starts at ${new Date(startsAt).toUTCString()}.\n\nOpen Accountability to view the details and supporters:\n${site}\n\nYou can turn off reminder emails in Account.`, idempotencyKey: `accountability-reminder/${id}` };
}
export async function createReminders(db, { userId, nowMs = Date.now(), deliverEmail = false, send = sendAccountabilityEmail, configured = emailConfigured } = {}) {
  const requests = await db.all('accountability_requests');
  const matches = await db.all('matches');
  const profiles = await db.all('profiles');
  let created = 0, emails = 0;
  const deadline = Date.now() + 20000;
  for (const request of requests) {
    if (!['open', 'matched'].includes(request.status)) continue;
    const until = new Date(request.scheduled_for).getTime() - nowMs;
    if (!Number.isFinite(until) || until <= 0 || until > 60 * 60000) continue;
    const stage = until <= 15 * 60000 ? 15 : 60;
    const ids = new Set([request.requester_id, ...matches.filter(m => m.request_id === request.id && m.status === 'active').map(m => m.partner_id)]);
    for (const id of ids) {
      if (userId && userId !== id) continue;
      const member = profiles.find(p => p.id === id);
      if (!member) continue;
      const notificationId = crypto.createHash('sha256').update(`${id}:${request.id}:${request.scheduled_for}:${stage}`).digest('hex');
      let note = await db.getDirect('notifications', notificationId);
      if (!note) {
        note = { id: notificationId, user_id: id, request_id: request.id, title: request.title, starts_at: request.scheduled_for, stage_minutes: stage, read_at: null, email_sent_at: null, created_at: new Date(nowMs).toISOString(), updated_at: new Date(nowMs).toISOString() };
        const result = await db.store.setJSON(keyFor(notificationId), note, { onlyIfNew: true });
        if (result.modified) created++;
        else note = await db.getDirect('notifications', notificationId);
        db.cache.delete('notifications');
      }
      if (deliverEmail && Date.now() < deadline && note && !note.email_sent_at && member.reminder_email_opt_in === true && configured()) {
        try {
          await send(reminderEmail(member.email, request.scheduled_for, notificationId));
          note.email_sent_at = new Date().toISOString(); await db.update('notifications', note); emails++;
        } catch (_) { /* Leave unsent; the next scheduled run retries with the same idempotency key. */ }
      }
    }
  }
  return { created, emails };
}
