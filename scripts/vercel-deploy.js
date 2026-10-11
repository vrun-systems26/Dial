// One-shot Vercel setup: links the project, copies server secrets from .env into
// Vercel's encrypted environment variables (never into the code), then deploys.
// Run: node scripts/vercel-deploy.js            (add --skip-env to only redeploy)
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const env = require('dotenv').parse(fs.readFileSync(path.join(root, '.env')));
const KEYS = ['MANTLE_RPC', 'CHAIN_ID', 'DEPLOYER_PK', 'SENDER_PK', 'SHOP_PK', 'WALLET_SEED', 'CODE_SECRET', 'TOOL_SECRET', 'SENDER_PIN', 'ELEVENLABS_AGENT_ID'];

function vercel(args, input) {
  const r = spawnSync('npx.cmd', ['--yes', 'vercel', ...args], { cwd: root, input, stdio: [input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'], shell: true });
  return r.status;
}

if (vercel(['link', '--yes', '--project', 'dial-a-dollar']) !== 0) process.exit(1);

if (!process.argv.includes('--skip-env')) {
  const only = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7);
  for (const k of only ? only.split(',') : KEYS) {
    if (!env[k]) continue;
    vercel(['env', 'rm', k, 'production', '--yes']); // ignore "not found"
    console.log(`setting ${k}`);
    if (vercel(['env', 'add', k, 'production'], env[k]) !== 0) { console.error(`failed to set ${k}`); process.exit(1); }
  }
}

process.exit(vercel(['deploy', '--prod', '--yes']));
