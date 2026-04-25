import { defineChain } from "viem";

// Ritual Chain (Cronos L2, EVM-identical)
export const Tent = defineChain({
  id: 1979,
  name: "Ritual Testnet",
  nativeCurrency: { name: "RITUAL", symbol: "RIT", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.ritualfoundation.org"] },
    public: { http: ["https://rpc.ritualfoundation.org"] },
  },
  blockExplorers: {
    default: { name: "Ritual Explorer", url: "https://testnet.ritualfoundation.org/" },
  },
  testnet: true,
});

// ── Precompile addresses ──────────────────────────────────────────────────────
export const LLM_PRECOMPILE   = "0x0000000000000000000000000000000000000802" as const;
export const IMAGE_PRECOMPILE = "0x0000000000000000000000000000000000000818" as const;
export const AUDIO_PRECOMPILE = "0x0000000000000000000000000000000000000819" as const;
export const VIDEO_PRECOMPILE = "0x000000000000000000000000000000000000081A" as const;

// ── Registry / System ─────────────────────────────────────────────────────────
export const TEE_REGISTRY = "0x9644e8562cE0Fe12b4deeC4163c064A8862Bf47F" as const;

// SecretsAccessControl — allows precompile/executor to read creds bound to a contract
export const SECRETS_AC = "0xf9BF1BC8A3e79B9EBeD0fa2Db70D0513fecE32FD" as const;
