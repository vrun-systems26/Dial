// End-to-end test on Mantle Sepolia: send → read code → cash out → status → short-expiry refund.
const chain = require('../lib/chain');
(async () => {
  const phone = '+523312345678';
  const c = await chain.createCheck({ phone, amountUsd: 5 });
  console.log('created', c.id, c.code, c.txUrl);
  const out = await chain.cashOut({ phone, code: c.code, payTo: chain.shopWallet.address });
  console.log('cashout', out);
  const bad = await chain.cashOut({ phone, code: '000000', payTo: chain.shopWallet.address });
  console.log('wrong code ->', bad.error);
  const r = await chain.createCheck({ phone: '+10000000001', amountUsd: 2, ttlSeconds: 5 });
  console.log('short check', r.id);
  await new Promise(s => setTimeout(s, 8000));
  console.log('refunded', await chain.refundExpired());
  console.log('feed', (await chain.feed()).map(i => `${i.type}#${i.id} $${i.amountUsd}`).join(' | '));
  console.log('balances', await chain.balances());
})().catch(e => { console.error(e); process.exit(1); });
