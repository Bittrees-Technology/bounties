#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const safeAddress = "0x594f3B031992C2d6855383b3755653D6Fde35F01";
const ownerAddress = "0xE5350D96FC3161BF5c385843ec5ee24E8B465B2f";
const createCallAddress = "0x9b35Af71d77eaf8d7e40252370304687390A1A52";
const saltPhrase = "bounties-escrow-v3-staged-milestone-funding-2026-08-16";
const networks = [
  { chainId: "11155111", name: "Ethereum Sepolia" },
  { chainId: "84532", name: "Base Sepolia" },
  { chainId: "46630", name: "Robinhood Testnet" },
];

const artifact = JSON.parse(readFileSync(new URL("../out/BountyEscrow.sol/BountyEscrow.json", import.meta.url)));
const creationBytecode = artifact.bytecode.object;
const cast = (...args) => execFileSync("cast", args, { encoding: "utf8" }).trim();
const salt = cast("keccak", saltPhrase);
const contractAddress = cast(
  "create2",
  "--deployer",
  createCallAddress,
  "--salt",
  salt,
  "--init-code",
  creationBytecode,
  "--json",
);
const data = cast("calldata", "performCreate2(uint256,bytes,bytes32)", "0", creationBytecode, salt);
const outputDir = process.argv[2] || "/tmp/bounties-safe-deploy-v3";

mkdirSync(outputDir, { recursive: true });
for (const network of networks) {
  const batch = {
    version: "1.0",
    chainId: network.chainId,
    createdAt: Date.now(),
    meta: {
      name: `BountyEscrow testnet-v3 deployment - ${network.name}`,
      description: `Deploy BountyEscrow testnet-v3 with Safe CreateCall 1.4.1 performCreate2 to ${contractAddress}.`,
      txBuilderVersion: "2.0.1",
      createdFromSafeAddress: safeAddress,
      createdFromOwnerAddress: ownerAddress,
    },
    transactions: [{ to: createCallAddress, value: "0", data }],
  };
  writeFileSync(join(outputDir, `bounty-escrow-v3-${network.chainId}.json`), `${JSON.stringify(batch, null, 2)}\n`);
}

const zeroAddress = "0x0000000000000000000000000000000000000000";
const prevalidatedSignature = `${cast("abi-encode", "f(address)", ownerAddress)}${"0".repeat(64)}01`;
const safeExecData = cast(
  "calldata",
  "execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)",
  createCallAddress,
  "0",
  data,
  "0",
  "0",
  "0",
  "0",
  zeroAddress,
  zeroAddress,
  prevalidatedSignature,
);
const robinhoodRequest = {
  chainId: "0xb626",
  chainName: "Robinhood Chain Testnet",
  rpcUrls: ["https://rpc.testnet.chain.robinhood.com"],
  blockExplorerUrls: ["https://explorer.testnet.chain.robinhood.com"],
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  from: ownerAddress,
  to: safeAddress,
  value: "0x0",
  data: safeExecData,
  deployedContract: contractAddress,
};
writeFileSync(
  join(outputDir, "bounty-escrow-v3-46630-safe-exec.json"),
  `${JSON.stringify(robinhoodRequest, null, 2)}\n`,
);
writeFileSync(
  join(outputDir, "robinhood-safe-deploy.html"),
  `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>BountyEscrow Robinhood Testnet deployment</title>
<style>
body{font:16px/1.45 system-ui,sans-serif;max-width:760px;margin:48px auto;padding:0 24px;color:#13231f;background:#f6f4ed}
main{background:white;border:1px solid #cbded6;border-radius:18px;padding:28px}button{font:inherit;font-weight:700;padding:14px 20px;border:0;border-radius:12px;background:#0d6b57;color:white;cursor:pointer}code{overflow-wrap:anywhere}#status{margin-top:18px;white-space:pre-wrap}
</style>
<main><h1>Deploy BountyEscrow</h1><p>Robinhood Chain Testnet · Safe <code>${safeAddress}</code></p><p>Expected contract <code>${contractAddress}</code></p><button id="deploy">Open Rabby approval</button><div id="status"></div></main>
<script type="module">
const request=await fetch('./bounty-escrow-v3-46630-safe-exec.json').then(r=>r.json());
let rabby;
addEventListener('eip6963:announceProvider',({detail})=>{if(detail?.provider?.isRabby||/rabby/i.test(detail?.info?.name||''))rabby=detail.provider});
dispatchEvent(new Event('eip6963:requestProvider'));
const status=document.querySelector('#status');
document.querySelector('#deploy').onclick=async()=>{try{
  const provider=rabby||window.ethereum;
  if(!provider)throw new Error('Rabby was not detected.');
  const accounts=await provider.request({method:'eth_requestAccounts'});
  if((accounts[0]||'').toLowerCase()!==request.from.toLowerCase())throw new Error('Connect the expected Safe owner wallet.');
  if(await provider.request({method:'eth_chainId'})!==request.chainId){try{await provider.request({method:'wallet_switchEthereumChain',params:[{chainId:request.chainId}]})}catch(error){if(error?.code!==4902)throw error;await provider.request({method:'wallet_addEthereumChain',params:[{chainId:request.chainId,chainName:request.chainName,rpcUrls:request.rpcUrls,blockExplorerUrls:request.blockExplorerUrls,nativeCurrency:request.nativeCurrency}]})}}
  status.textContent='Rabby is opening the final transaction approval…';
  const hash=await provider.request({method:'eth_sendTransaction',params:[{from:request.from,to:request.to,value:request.value,data:request.data}]});
  status.innerHTML='Submitted: <a target="_blank" rel="noreferrer" href="https://explorer.testnet.chain.robinhood.com/tx/'+hash+'">'+hash+'</a>';
}catch(error){status.textContent=error?.message||String(error)}};
</script>`,
);

process.stdout.write(
  `${JSON.stringify({ outputDir, safeAddress, ownerAddress, createCallAddress, saltPhrase, salt, contractAddress }, null, 2)}\n`,
);
