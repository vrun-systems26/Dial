// Demo directory: the caller, their one saved contact, and the cash-out shop.
// Display names are chosen by the user on the site (defaults are blank).
// In production this would be a database keyed by verified phone numbers.

const senders = {
  demo: {
    name: 'Demo sender',
    phone: '+15105550142',
    pin: process.env.SENDER_PIN || '4179',
    contacts: ['contact'],
  },
};

const recipients = {
  contact: {
    name: 'your contact',
    phone: '+523312345678',
    city: 'Guadalajara, MX',
  },
};

const shops = {
  partner: { name: 'Partner shop', city: 'Guadalajara, MX', currency: 'MXN', rate: 18.0 }, // example rate
};

// The demo caller has one saved contact, so whatever they call that person
// (any name or relationship) resolves to it.
function findRecipient() {
  const [id, r] = Object.entries(recipients)[0];
  return { id, ...r };
}

module.exports = { senders, recipients, shops, findRecipient };
