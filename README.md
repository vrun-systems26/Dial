# Dial

**say it out loud and the money is home before you hang up**

Dial lets anyone send money home by talking to a voice agent in their own language. It locks digital dollars for their family on the Mantle blockchain in seconds; the family collects cash at a corner shop with a 6-digit code, and anything they don't collect is refunded automatically. No smartphone, bank account or app needed on either side.

**Live:** https://dial-a-dollar.vercel.app · Built at B@BHacks 2.0 (Track 2: Decentralized AI Primitives & Autonomous On-Chain Agents)

## Why

About $685B a year is sent home to lower- and middle-income countries, and the average fee is about 6.4% (World Bank). The UN target is under 3% by 2030. The people left out most often have no smartphone, no bank and no English. Dial settles in seconds for a fraction of a cent, and the interface is a phone call.

## How it works

1. **Call.** The sender talks to an ElevenLabs voice agent (Gemini 2.5 Flash as the brain). It confirms one amount, asks for a PIN, then calls the `send_money` tool.
2. **Lock.** The server creates a check in the `DialChecks` contract on Mantle: stablecoin moves from the sender's wallet into the contract, addressed to the receiver's wallet. Every phone number gets its own wallet automatically.
3. **Text.** The receiver gets a 6-digit code through a private link (or SMS via Twilio when enabled).
4. **Collect.** A partner shop enters the phone number + code; the check is cashed on-chain to the shop, which hands over local currency.
5. **Refund.** If nobody collects in time, the refund agent returns the money to the sender. It can only ever go back to the sender.

Also: **NGO payouts** (pay many families in one transaction, with a live donor report) and an **income passport** (a verifiable history of money received, for people with no bank records).

## Tech

| Layer | What |
| --- | --- |
| Voice agent | ElevenLabs Conversational AI (WebRTC), Gemini 2.5 Flash, two webhook tools, dynamic variables for phone / window / visitor |
| Contract | `contracts/DialChecks.sol` (Solidity 0.8.24): `createCheck`, `cashCheck`, `refund`, `createChecks` (bulk) |
| Chain | Mantle Sepolia (Ethereum L2), test stand-in for Agora's AUSD (6 decimals), ethers.js v6 |
| Server | Node.js + Express on Vercel serverless, daily cron for the refund agent |
| Frontend | Plain HTML/CSS/JS, mobile-first, OKLCH design tokens in `public/tokens.css` |

**Contracts (Mantle Sepolia):** DialChecks `0x49F1760C86783a5a383E4Fe387eF438D1862BaCa` · Test AUSD `0x6E7D3e33e938A315A16dFa6c6146C6A8A1d1C974`

## Security

- The claim secret is 32 random bytes; only its keccak256 hash is on-chain. Codes can't be derived from public data.
- Only the receiver's wallet can cash a check, and only with the secret.
- Receiver codes are only visible through a private link signed with HMAC-SHA256 (obtainable with the PIN).
- 5 wrong codes lock a number for 15 minutes; amounts capped at $1–$500; duplicate-send guard.
- Expired checks can only be refunded to the original sender.
- Voice tools require a secret header; all keys live in Vercel's encrypted environment, never in the repo.
- Each browser gets its own private wallet, demo phone, ledger and NGO fund.

Demo limits: testnet funds, a fixed demo PIN (4179), custodial receiver wallets.

## Run locally

```bash
npm install
cp .env.example .env   # fill in keys (see below)
node scripts/compile.js
node scripts/deploy.js           # deploys contracts, writes deployments.json
node server/local.js 3010
node scripts/create-agent.js http://localhost:3010   # needs a public URL for the voice tools
```

`.env` keys: `MANTLE_RPC`, `CHAIN_ID`, `DEPLOYER_PK`, `SENDER_PK`, `SHOP_PK`, `WALLET_SEED`, `CODE_SECRET`, `TOOL_SECRET`, `SENDER_PIN`, `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`, optional `TWILIO_SID` / `TWILIO_TOKEN` / `TWILIO_FROM`.

