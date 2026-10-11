// Deploys TestAUSD + DialChecks to Mantle Sepolia, funds the demo wallets,
// and writes the addresses to deployments.json.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const load = name => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'build', `${name}.json`), 'utf8'));

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.MANTLE_RPC);
  const deployer = new ethers.Wallet(process.env.DEPLOYER_PK, provider);
  const sender = new ethers.Wallet(process.env.SENDER_PK, provider);
  const shop = new ethers.Wallet(process.env.SHOP_PK, provider);

  const bal = await provider.getBalance(deployer.address);
  console.log(`deployer ${deployer.address} has ${ethers.formatEther(bal)} MNT`);
  if (bal === 0n) throw new Error('Deployer has no MNT. Use the faucet first.');

  const T = load('TestAUSD');
  const token = await new ethers.ContractFactory(T.abi, T.bytecode, deployer).deploy();
  await token.waitForDeployment();
  console.log('TestAUSD', await token.getAddress());

  const C = load('DialChecks');
  const checks = await new ethers.ContractFactory(C.abi, C.bytecode, deployer).deploy(await token.getAddress());
  await checks.waitForDeployment();
  console.log('DialChecks', await checks.getAddress());

  // Gas for the sender (it signs createCheck). Receivers get topped up automatically at cash-out.
  await (await deployer.sendTransaction({ to: sender.address, value: bal / 5n })).wait();

  // Test dollars: sender gets $1,000; deployer (acting as the NGO) gets $10,000.
  await (await token.mint(sender.address, 1_000n * 10n ** 6n)).wait();
  await (await token.mint(deployer.address, 10_000n * 10n ** 6n)).wait();

  // Sender and NGO approve the checks contract once.
  const max = ethers.MaxUint256;
  await (await token.connect(sender).approve(await checks.getAddress(), max)).wait();
  await (await token.connect(deployer).approve(await checks.getAddress(), max)).wait();

  const deployments = {
    chainId: Number((await provider.getNetwork()).chainId),
    deployBlock: (await checks.deploymentTransaction().wait()).blockNumber,
    token: await token.getAddress(),
    checks: await checks.getAddress(),
    wallets: { deployer: deployer.address, sender: sender.address, shop: shop.address },
  };
  fs.writeFileSync(path.join(__dirname, '..', 'deployments.json'), JSON.stringify(deployments, null, 2));
  console.log(deployments);
}

main().catch(e => { console.error(e); process.exit(1); });
