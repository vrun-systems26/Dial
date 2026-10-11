// Creates (or updates) the Dial voice agent on ElevenLabs: Gemini as the brain,
// two webhook tools pointing at the live site, English + Spanish.
// Run: node scripts/create-agent.js https://dial-a-dollar.vercel.app
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const BASE = (process.argv[2] || 'https://dial-a-dollar.vercel.app').replace(/\/$/, '');
const KEY = process.env.ELEVENLABS_API_KEY;
const API = 'https://api.elevenlabs.io/v1/convai';
const headers = { 'xi-api-key': KEY, 'content-type': 'application/json' };

async function call(method, url, body) {
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${text.slice(0, 600)}`);
  return text ? JSON.parse(text) : {};
}

const tools = [
  {
    type: 'webhook',
    name: 'send_money',
    description: 'Sends money to one of the caller\'s saved contacts. Only call this after the caller has confirmed the recipient and amount AND said their 4-digit PIN. Returns a message to read back.',
    api_schema: {
      url: `${BASE}/api/tools/send_money`,
      method: 'POST',
      request_headers: { 'x-tool-secret': process.env.TOOL_SECRET },
      request_body_schema: {
        type: 'object',
        description: 'Transfer details',
        required: ['recipient', 'amount_usd', 'pin'],
        properties: {
          recipient: { type: 'string', description: 'Who to send to, as the caller said it, e.g. "mom" or "María López".' },
          amount_usd: { type: 'number', description: 'Amount in US dollars, e.g. 50.' },
          pin: { type: 'string', description: 'The 4-digit PIN the caller spoke, digits only, e.g. "4179".' },
        },
      },
    },
  },
  {
    type: 'webhook',
    name: 'check_status',
    description: 'Checks on the blockchain whether the caller\'s latest transfer to a contact was collected, is still waiting, or was refunded.',
    api_schema: {
      url: `${BASE}/api/tools/check_status`,
      method: 'POST',
      request_headers: { 'x-tool-secret': process.env.TOOL_SECRET },
      request_body_schema: {
        type: 'object',
        description: 'Which contact to check',
        required: ['recipient'],
        properties: {
          recipient: { type: 'string', description: 'The contact, e.g. "mom".' },
        },
      },
    },
  },
];

const prompt = `You are Dial, a phone agent that helps people send money to family in other countries.
The caller is Carlos, calling from Oakland (identified by caller ID). His saved contact is María López, his mom, in Guadalajara, Mexico.

How to handle a transfer:
1. Find out who to send to and how much (US dollars, between $1 and $500).
2. Read it back in one short sentence: "$50 to María López in Guadalajara. It arrives in seconds and there is no fee."
3. Ask for his 4-digit PIN.
4. Call send_money with the recipient, amount and PIN. Never call it without a PIN, and never guess or repeat the PIN out loud.
5. Read back the result simply: the money is locked for her, she gets a text with a code, she can collect cash at a partner shop within 7 days, and unclaimed money comes back automatically.

If he asks whether she received it, call check_status and tell him the answer.

Rules:
- This is a phone call: keep every reply to one or two short sentences.
- Reply in the language the caller uses. Spanish speakers get natural Mexican Spanish.
- Never read out transaction hashes, wallet addresses or technical terms like "smart contract". Say "secured on the blockchain" at most once.
- If a tool returns ok: false, explain the message kindly and offer to try again.
- Do not discuss anything unrelated to sending money home.`;

(async () => {
  if (!KEY) throw new Error('ELEVENLABS_API_KEY missing in .env');

  const toolIds = process.env.EL_TOOL_IDS ? process.env.EL_TOOL_IDS.split(',') : [];
  for (const t of toolIds.length ? [] : tools) {
    const created = await call('POST', `${API}/tools`, { tool_config: t });
    toolIds.push(created.id);
    console.log(`tool ${t.name}: ${created.id}`);
  }

  const agentConfig = {
    name: 'Dial',
    conversation_config: {
      agent: {
        first_message: 'Hi Carlos, this is Dial. Who would you like to send money to today?',
        language: 'en',
        prompt: { prompt, llm: 'gemini-2.5-flash', temperature: 0.3, tool_ids: toolIds },
      },
      tts: { model_id: 'eleven_flash_v2' },
      language_presets: {
        es: { overrides: { agent: { language: 'es', first_message: 'Hola Carlos, habla Dial. ¿A quién le quieres enviar dinero hoy?' } } },
      },
    },
    platform_settings: {
      auth: { enable_auth: false, allowlist: [{ hostname: new URL(BASE).hostname }, { hostname: 'localhost' }] },
    },
  };

  let agentId = process.env.ELEVENLABS_AGENT_ID;
  if (agentId) {
    await call('PATCH', `${API}/agents/${agentId}`, agentConfig);
    console.log(`updated agent ${agentId}`);
  } else {
    agentId = (await call('POST', `${API}/agents/create`, agentConfig)).agent_id;
    console.log(`created agent ${agentId}`);
    fs.appendFileSync(path.join(__dirname, '..', '.env'), `ELEVENLABS_AGENT_ID=${agentId}\n`);
  }

  const a = await call('GET', `${API}/agents/${agentId}`);
  const p = a.conversation_config.agent.prompt;
  console.log('llm:', p.llm, '| tools:', (p.tool_ids || []).length, '| languages:', Object.keys(a.conversation_config.language_presets || {}).join(',') || 'en');
})().catch(e => { console.error(e.message); process.exit(1); });
