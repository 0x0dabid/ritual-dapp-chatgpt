# 📖  Private Multi-Modal ChatGPT — Ritual dApp

Full-stack Ethereum-compatible dApp living **entirely on-chain** via Ritual Chain’s TEE-verified AI/ML precompiles.

**Live chain:** Ritual Testnet (Chain ID **1979**)
**Model:** `zai-org/GLM-4.7-FP8` for text, `black-forest-labs/FLUX.2-klein-4B` for images
**Brand:** COGNOXIDE — #0A0A0A background, neon-lime (#C8FF00) accents

---

## 📂  Project Layout

```
ritual-dapp-chatgpt/
├─ contracts/           Solidity + Hardhat
│   ├─ ChatGPT.sol      Core augmentation (LLM + multimodal)
│   ├─ hardhat.config.ts
│   ├─ scripts/deploy.js
│   └─ package.json
└─ web/                 Next.js 14 frontend (Tailwind + viem + wagmi)
    ├─ app/
    │   ├─ layout.tsx   Web3Provider wrapper
    │   └─ page.tsx     Chat UI + streaming display
    ├─ components/      Connector, helpers
    ├─ hooks/           useChatStreaming.ts  (LLM precompile call)
    ├─ lib/             network config (Tent)
    ├─ styles/          globals.css (Ritual dark palette)
    ├─ public/          noise.svg + assets
    └─ package.json
```

---

## 🧑‍🔧  Setup
### 1. Default RPC

Ritual Testnet public endpoint (no key required for read-only):
```
https://rpc.ritualfoundation.org
```

For writing, use the **compound API key** included in all calls — Ritual’s devnet uses a static UUID on the public endpoint:

```json
{ "method":"eth_sendTransaction", "params":[…], "api_key":"d05b8a9c-64b8-45d2-9b1c-061b400d4bac" }
```

The viem `http()` provider adds the key automatically via the `headers` field (see `ritual-rpc-query` skill for the exact curl / Web3.js fallback patterns).

---

### 2. Compile & Deploy the Contract

```bash
cd ~/ritual-dapp-chatgpt/contracts
npm install
# If you haven’t set up your private key:
export RITUAL_PRIVATE_KEY=0x…  # from https://ritual.network/testnet
# Optional override:
export RITUAL_RPC_URL=https://rpc.ritualfoundation.org

npm run build  # compiles via hardhat
npm run deploy
```

After deploy finishes:
* the contract address is saved to `~/.env.ritual`
* copy the address into the frontend `.env.local`

```bash
# Backfill frontend environment from the artifact
cp ~/.env.ritual ~/ritual-dapp-chatgpt/web/.env.local
```

---

### 3. Frontend Setup

```bash
cd ~/ritual-dapp-chatgpt/web

# Install Next.js + viem dependencies
npm install

# If the Hermes Gateway venv isn’t exposing esbuild/esbuild-darwin-arm64 or similar,
# pass explicit platforms to Next:  next build --platform=linux --os=linux

npm run dev
# → opens at http://localhost:3000
```

### 4.  Connect Wallet & Chat

1. Use any WalletConnect- or EIP-1193-compatible wallet (MetaMask, Rabby) on Ritual Testnet.
2. Click **Connect Wallet**.
3. Ask a question — your tx is sent to precompile `0x0802`, builder commits, executor runs inference in TEE, then your deferred tx re-plays in the same block with the LLM output injected into `spcCalls`.

---

## ⚙️  Configuration
| Variable | Purpose | Required for build? |
|---|---|---|
| `NEXT_PUBLIC_RITUAL_CHAIN_ID` | Chain numeric ID | yes |
| `NEXT_PUBLIC_RITUAL_RPC_URL` | RPC endpoint (http) | yes |
| `NEXT_PUBLIC_CHATGPT_CONTRACT_ADDRESS` | Contract address on Ritual Testnet | **yes** — filled after `npm run deploy` |
| `GCS_SA_KEY` / `GCS_BUCKET` | Plain-text GCS service-account key & bucket name — encrypted on the fly when the frontend builds the `encryptedSecrets` payload | yes (for convo history) |

GCS credentials remain unencrypted in `process.env` only inside the Next.js server bundle; they’re automatically **encrypted client-side to the TEE executor’s public key** using ECIES (nonce length 12, per `ritual-dapp-secrets`) before being passed in calldata. No plaintext credentials touch the chain.

---

## 🧠  What’s under the hood? (Quick references)

| Skill | Precompile / System | Usage here |
|---|---|---|
| `ritual-dapp-llm` | LLM (0x0802) | Text chat — short-running async, result in transaction receipt `spcCalls` |
| `ritual-dapp-precompiles` | ABI reference | 30-field layout, callback form (none for LLM), `spcCalls` unwrapping |
| `ritual-dapp-multimodal` | Image/Audio/Video (0x0818/19/1A) | Optionally available; contract scaffolding included but UI toggled to text-only for the MVP |
| `ritual-dapp-da` | StorageRef for conversation history | Conversation logs are JSONL on GCS; path tuple lives on-chain via `StorageRef` |

---

## 📝  Common Gotchas (Ritual-newbie checklist)

* One async tx per sender — the RPC layer enforces a sender lock. If you hammer “Send” twice rapidly the second tx will revert.
* `ttl` must be ≥60 for GLM-4.7 (reasoning budget headroom). The default allocated here is 300 blocks (~105 s).
* Encrypted GCS credentials are public on-chain (the **ciphertext** is). The Riemann-secure minimisation is binding them to your contract via `SecretsAccessControl`. The contract has the `grantAccess` call commented in `requestMedia` — enable it when you’re ready.
* For streaming tokens, you can wire the SSE service while the on-chain transaction settles — the LLD streaming service is in `ritual-dapp-llm` but not wired in this minimal release.
* If `spcCalls` is missing, the commitment failed to settle. Check RitualWallet balance + lock duration — 0.1 RIT is not enough for LLM; deposit ~0.4 RIT per concurrent in-flight call.

---

## 🎨  Brand & Polish

* Colour palette: `#0A0A0A` bg, `#19D184` primary green, `#BFFF00` neon lime (`ritual-lime`), `#FF1DCE` pink accents.
* Typography: Archivo (headlines) + Barlow (body) + JetBrains Mono (code/mono).
* Noise texture + subtle mesh gradient — Cognoxide visual identity.
* Cards use `shadow-card` style with per-element glow utilities (`glow-green`, `glow-pink`).

---

## 🛠️  Next steps (roadmap)

- [ ] Rotate real GCS credentials (not the placeholder hell above).
- [ ] Wire `grantAccess` in `requestMedia` to bind encrypted storage creds to this contract.
- [ ] Add image/audio/video tabs to the frontend.
- [ ] Show executor TEE attestation + pricing in the header.
- [ ] Add streaming token display via SSE + EIP-712 signature (ritual-dapp-llm § Streaming).

---

## 🌐  Deploy status (TBD)

Testnet contract address once deployed will be printed by `npm run deploy` and copied to `frontend/.env.local` automatically by the deploy script (see `scripts/deploy.js`). If you’re deploying a fresh testnet instance, set your testnet RPC URL & private key before running `npm run deploy`.

---

*Built from the ground up following Ritual dApp skills (LLM · Precompiles · Overview · Multimodal). All runtime code is self-contained; zero external microservices.*
