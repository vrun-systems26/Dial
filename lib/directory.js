// Demo directory: who can call in, who they send to, and the cash-out shops.
// In production this would be a database keyed by verified phone numbers.

const senders = {
  carlos: {
    name: 'Carlos',
    phone: '+15105550142',
    city: 'Oakland',
    pin: process.env.SENDER_PIN || '4179',
    contacts: ['maria'],
  },
};

const recipients = {
  maria: {
    name: 'María López',
    phone: '+523312345678',
    city: 'Guadalajara, MX',
    aliases: ['mom', 'my mom', 'mother', 'mamá', 'mama', 'mi mamá', 'mi mama', 'maria', 'maría', 'maría lópez', 'maria lopez'],
  },
};

const shops = {
  lupita: { name: 'Abarrotes Lupita', city: 'Guadalajara, MX', currency: 'MXN', rate: 18.0 }, // example rate
};

function findRecipient(text) {
  const t = String(text || '').trim().toLowerCase();
  for (const [id, r] of Object.entries(recipients)) {
    if (r.aliases.includes(t) || r.phone === t || id === t) return { id, ...r };
  }
  // loose match: "send it to my mom please"
  for (const [id, r] of Object.entries(recipients)) {
    if (r.aliases.some(a => t.includes(a))) return { id, ...r };
  }
  return null;
}

module.exports = { senders, recipients, shops, findRecipient };
