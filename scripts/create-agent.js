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
    disable_interruptions: true,
    response_timeout_secs: 30,
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
          recipient: { type: 'string', description: 'Who to send to, as the caller said it, e.g. "mom", "my friend" or {{recipient_name}}.' },
          amount_usd: { type: 'number', description: 'The single amount the caller confirmed, in US dollars with cents, e.g. 31.99 or 50.' },
          pin: { type: 'string', description: 'The 4-digit PIN the caller spoke, digits only, e.g. "4179".' },
          // Filled automatically from the caller's saved settings on the site.
          recipient_phone: { type: 'string', dynamic_variable: 'recipient_phone' },
          expiry_minutes: { type: 'number', dynamic_variable: 'expiry_minutes' },
          sender_name: { type: 'string', dynamic_variable: 'sender_name' },
        },
      },
    },
  },
  {
    type: 'webhook',
    name: 'check_status',
    disable_interruptions: true,
    response_timeout_secs: 30,
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
          recipient_phone: { type: 'string', dynamic_variable: 'recipient_phone' },
        },
      },
    },
  },
];

const prompt = `You are Dial, a phone agent that helps people send money to family in other countries.
The caller is {{sender_name}}. Their saved contact is {{recipient_name}}, in Guadalajara, Mexico. Whatever the caller calls that person (mom, dad, a friend, a cousin, {{recipient_name}}), it is the same saved contact. Use the caller's word when you talk about them.

How to handle a transfer:
1. Find out how much to send, in US dollars, between $1 and $500. Cents are fine.
2. If the caller says more than one amount, or changes their mind mid-sentence, do not guess. Ask: "Just to be sure, how much should I send?" and wait for one clear amount.
3. Read it back with the exact cents: "$31.99 to your mom. It arrives in seconds with no fee. What's your PIN?"
4. When you have the PIN, call send_money once, with the recipient, the exact amount and the PIN. Never call it without a PIN, never call it twice for the same request, and never repeat the PIN out loud.
5. Read back the result simply: the money is locked for them, they get a text with a code, they can collect cash at a partner shop within the time the result says, and unclaimed money comes back automatically. If the result says duplicate, tell the caller it already went through and nothing extra was sent.

If the caller asks whether it was received, call check_status and tell them the answer.

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
        first_message: 'Hi {{sender_name}}, this is Dial. How much would you like to send to {{recipient_name}} today?',
        language: 'en',
        prompt: { prompt, llm: 'gemini-2.5-flash', temperature: 0.2, tool_ids: toolIds },
        dynamic_variables: { dynamic_variable_placeholders: { sender_name: 'Varun', recipient_name: 'Relative', recipient_phone: '+523312345678', expiry_minutes: 10080 } },
      },
      tts: { model_id: 'eleven_flash_v2' },
      language_presets: {
        es: { overrides: { agent: { language: 'es', first_message: 'Hola {{sender_name}}, habla Dial. ¿Cuánto le quieres enviar a {{recipient_name}} hoy?' } } },
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
