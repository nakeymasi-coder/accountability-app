export function emailConfigured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}
export async function sendAccountabilityEmail({ to, subject, text, idempotencyKey }) {
  if (!emailConfigured()) throw new Error('Email delivery is not configured.');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST', signal: AbortSignal.timeout(8000),
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [to], subject, text }),
  });
  if (!response.ok) throw new Error('The email service could not accept the message.');
  const result = await response.json();
  if (!result.id) throw new Error('The email service did not confirm the message.');
  return result.id;
}
