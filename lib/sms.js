// Real text messages through Twilio. Turned on only when TWILIO_SID, TWILIO_TOKEN and
// TWILIO_FROM are set; otherwise Dial shows the text on the receiver's phone page instead.
const enabled = () => Boolean(process.env.TWILIO_SID && process.env.TWILIO_TOKEN && process.env.TWILIO_FROM);

async function sendSms(to, body) {
  if (!enabled()) return { sent: false, reason: 'sms-off' };
  const sid = process.env.TWILIO_SID;
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      authorization: 'Basic ' + Buffer.from(`${sid}:${process.env.TWILIO_TOKEN}`).toString('base64'),
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: to, From: process.env.TWILIO_FROM, Body: body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { sent: false, reason: data.message || `Twilio error ${res.status}` };
  return { sent: true, sid: data.sid };
}

module.exports = { enabled, sendSms };
