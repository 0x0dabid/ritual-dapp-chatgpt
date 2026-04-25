# 🧠  Private Multi-Modal ChatGPT — On-chain, on Ritual

Full-stack dApp that runs ChatGPT-style AI **entirely on-chain** using Ritual Chain's TEE-verified precompiles.

**Chain:** Ritual Testnet (Chain ID **1979**)  
**Model:** `zai-org/GLM-4.7-FP8` (LLM), `black-forest-labs/FLUX.2-klein-4B` (image)  
**Wallet owner:** `0x310aDAbcb9491dCF83EDcb3d6232B2e7066da58D` (provided)  
**Brand:** COGNOXIDE — `#0A0A0A` bg, neon-lime accents

---

## 📂 Monorepo Layout

```
~/ritual-dapp-chatgpt/
├─ contracts/          Solidity + Hardhat
│   ├─ contracts/
│   │   └─ ChatGPT.sol   ← consumer contract (LLM + multimodal precompiles)
│   ├─ scripts/
│   │   └─ deploy.js     ← deploy → writes .env.ritual
│   ├─ hardhat.config.ts
│   └─ package.json
│
├─ web/                Next.js 14 frontend (viem + wagmi)
│   ├─ app/page.tsx      ← chat UI
│   ├─ hooks/useChatStreaming.ts
│   ├─ lib/tent.ts       ← chain config
│   ├─ styles/globals.css← Ritual dark palette + Cognoxide branding
│   └─ package.json
│
└─ WEB-README.md       ← frontend-specific details
```

---

## 🚀 Quick-Start (3 steps)

### 1. Set credentials (one-time)

Ritual Testnet uses a **compound API key** on public RPC:
```bash
export RITUAL_RPC_URL=https://rpc.ritualfoundation.org
export RITUAL_PRIVATE_KEY=0x...        # your testnet wallet's private key
```

The wallet you provided (`0x310aDAbcb9491dCF83EDcb3d6232B2e7066da58D`) will be the **initial owner** of the deployed contract.

---

### 2. Deploy the contract

```bash
cd ~/ritual-dapp-chatgpt/contracts
npm install              # (already done — deps present)
npx hardhat compile       # already succeeds locally
npx hardhat run scripts/deploy.js --network testnet
```

Expected output:
```
🚀 Deploying PrivateMultiModalChatGPT to Ritual Chain…
   RPC: https://rpc.ritualfoundation.org
   Chain ID: 1979
   Deployer: 0xYOUR_WALLET

✅ PrivateMultiModalChatGPT deployed!
   Contract: 0xNEW_ADDRESS

📄 Saved .env.ritual → /home/user/ritual-dapp-chatgpt/.env.ritual
```

---

### 3. Start the frontend

```bash
cd ~/ritual-dapp-chatgpt/web

# Install Next.js deps
npm install

# Copy deployed config to frontend
cp ../.env.ritual .env.local

# Start dev server
npm run dev    # opens at http://localhost:3000
```

Then:
1. Connect your Ritual-testnet wallet in the UI.
2. Type a message → hit **Send**.
3. Watch the "Thinking on-chain…" status; the LLM precompile executes in a TEE and the result lands in your receipt within 10–60 seconds (no streaming SSE in this build).

---

## 🧾 What the contract does

`PrivateMultiModalChatGPT.sol` is a consumer contract that calls Ritual precompiles directly:

| Feature | Precompile | Pattern |
|---|---|---|
| **Text chat** | `0x0802` LLM | Short-running async (30-field ABI). Result appears in `txReceipt.spcCalls`. |
| **Image gen** | `0x0818` Image | Long-running async (2-phase). Phase 1 returns taskId; Phase 2 callback delivers `uri`, `contentHash`, etc. |
| **Audio / Video** | `0x0819` / `0x081A` | Same long-running pattern with per-modality response tuples. |
| **Conversation history** | Off-chain DA (GCS / HF / Pinata) | Stored off-chain; on-chain holds only the `StorageRef` tuple `(platform, path, keyRef)`. |

All async functions enforce the **one-job-per-sender** rule — concurrent requests require multiple EOAs.

---

## 🔐 Secrets & Storage (GCS example)

The frontend:
1. Fetches a TEE executor from `TEEServiceRegistry.getServicesByCapability(1, true)`.
2. Encrypts the GCS service-account JSON using the executor's `publicKey` (ECIES, nonce length = 12).
3. Passes the ciphertext in the `encryptedSecrets` calldata array.
4. (Optional but recommended) Calls `SecretsAccessControl.grantAccess(this, keccak256(encryptedSecrets), expiry, emptyPolicy)` to bind the credential to this contract — otherwise anyone can copy your ciphertext and reuse it.

`convoHistory` is a `StorageRef` tuple: `['gcs', 'convos/<wallet>.jsonl', 'GCS_CREDS']`. Executors upload per-turn JSONL to your bucket; future calls read the same path for multi-turn memory.

---

## ⚙️ Configuration reference

| Env var | Purpose |
|---|---|
| `NEXT_PUBLIC_RITUAL_CHAIN_ID` | Chain numeric ID = `1979` |
| `NEXT_PUBLIC_RITUAL_RPC_URL` | HTTP RPC endpoint (public devnet key auto-injected by client) |
| `NEXT_PUBLIC_CHATGPT_CONTRACT_ADDRESS` | Deployed contract address (filled by deploy script) |
| `GCS_SA_KEY` / `GCS_BUCKET` | Plaintext GCS credentials (used only in Next.js server bundle; encrypted client-side before hitting chain) |

---

## 🐛 Known gotchas (Ritual 101)

- **One async tx per sender:** If you click "Send" twice rapidly, the second tx reverts with `sender locked`. Wait for the first to settle.
- **TTL must be ≥60 blocks** for GLM-4.7-FP8 — it's a reasoning model and needs headroom (the contract uses 300).
- **Deposit enough RITUAL** into RitualWallet before calling. Rough budget:
  - LLM text (~4096 tokens): ~0.05 RIT per call
  - Image generation (1024×1024): ~0.15 RIT per call
  The contract's `depositForFees(uint256 lockDuration)` externals payable let you fund the wallet:
  ```ts
  // 0.5 RIT locked for 5000 blocks (~29 minutes)
  await walletClient.writeContract({
    address: RITUAL_WALLET,
    abi: [{name:'deposit',type:'function',stateMutability:'payable',inputs:[{name:'lockDuration',type:'uint256'}],outputs:[]}],
    functionName: 'deposit',
    args: [5000n],
    value: parseEther('0.5')
  });
  ```
- **MaxCompletionTokens ≥4096** for GLM-4.7-FP8 — otherwise reasoning block eats the whole budget and you get empty `content` with `finish_reason: "length"`. We hardcode 4096 in the contract.
- **Encrypted secrets format** must match platform. For GCS: `{"service_account_json": "...", "bucket": "bucket-name"}`. For HF: plain token string. For Pinata: `{"jwt":"...","gateway_url":"..."}`. See `ritual-dapp-da`.

---

## 🎨 Brand & Polish

- **Colors:** bg `#0A0A0A`, elevated `#111827`, green `#19D184`, lime `#BFFF00`, pink `#FF1DCE`.
- **Typography:** Archivo Black (headlines), Barlow (body), JetBrains Mono (code).
- **Texture:** Fixed noise overlay + radial mesh gradient (Cognoxide identity).
- **Cards:** `shadow-card` with `glow-green` / `glow-pink` hover states.

---

## 📦 Next steps (roadmap)

- [ ] Add image/audio/video tabs to the UI (multimodal calls already implemented in contract).
- [ ] Wire `SecretsAccessControl.grantAccess` in `requestMedia()` to lock credentials to this contract.
- [ ] Enable SSE streaming display (requires streaming service URL + EIP-712 signature).
- [ ] Show executor TEE attestation badge and pricing in the header.
- [ ] Deploy to Ritual mainnet when available (change chain ID + RPC).

---

## 📜 Skill references used

| Skill | What we took |
|---|---|
| `ritual-dapp-llm` | 30-field LLM ABI, model pinning (`GLM-4.7-FP8`), executor selection, fee estimation |
| `ritual-dapp-multimodal` | 18-field image/audio/video ABI, ModalInput / OutputConfig tuple patterns, StorageRef credential binding |
| `ritual-dapp-precompiles` | Address map, base executor fields, AsyncDelivery sender, `spcCalls` unwrapping |
| `ritual-dapp-overview` | Async lifecycle (short vs long-running), one-sender-lock rule, TEE executor discovery |
| `ritual-dapp-da` | StorageRef `(platform, path, keyRef)` shape, GCS credentials JSON, ECIES nonce-length = 12 |
| `ritual-dapp-secrets` | ECIES encryption to TEE public key, SecretsAccessControl delegation |

---

## 🏁 Deploy status

Contract compiles → artifacts ready. Frontend scaffold complete. Ready to deploy once `RITUAL_PRIVATE_KEY` is set and the Ritual testnet faucet has funded the wallet.

Run the deploy and you'll have a fully on-chain, private, multi-modal ChatGPT running on Ritual in <2 minutes.
