"use client";

import { useState, useEffect } from "react";
import { useAccount, useWalletClient } from "wagmi";
import { createPublicClient, http, encodeFunctionData, decodeFunctionResult } from "viem";
import { Tent, LLM_PRECOMPILE, SECRETS_AC, TEE_REGISTRY } from "@/lib/tent";
import { Connector } from "@/components/Connector";

type Modality = "chat" | "image" | "audio" | "video";

// Minimal chat contract ABI for calls we need
const CHAT_ABI = [
  {
    name: "requestImage",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "executor", type: "address" },
      { name: "ttl", type: "uint256" },
      { name: "prompt", type: "string" },
      { name: "model", type: "string" },
      { name: "width", type: "uint32" },
      { name: "height", type: "uint32" },
      { name: "outputStorageRef", type: "tuple", components: [
          { name: "platform", type: "string" },
          { name: "path", type: "string" },
          { name: "keyRef", type: "string" },
        ]},
      { name: "encryptedSecrets", type: "bytes[]" },
    ],
    outputs: [{ name: "reqId", type: "bytes32" }],
  },
  {
    name: "requestAudio",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "executor", type: "address" },
      { name: "ttl", type: "uint256" },
      { name: "prompt", type: "string" },
      { name: "model", type: "string" },
      { name: "maxDurationMs", type: "uint32" },
      { name: "outputStorageRef", type: "tuple", components: [
          { name: "platform", type: "string" },
          { name: "path", type: "string" },
          { name: "keyRef", type: "string" },
        ]},
      { name: "encryptedSecrets", type: "bytes[]" },
    ],
    outputs: [{ name: "reqId", type: "bytes32" }],
  },
  {
    name: "requestVideo",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "executor", type: "address" },
      { name: "ttl", type: "uint256" },
      { name: "prompt", type: "string" },
      { name: "model", type: "string" },
      { name: "width", type: "uint32" },
      { name: "height", type: "uint32" },
      { name: "durationMs", type: "uint32" },
      { name: "outputStorageRef", type: "tuple", components: [
          { name: "platform", type: "string" },
          { name: "path", type: "string" },
          { name: "keyRef", type: "string" },
        ]},
      { name: "encryptedSecrets", type: "bytes[]" },
    ],
    outputs: [{ name: "reqId", type: "bytes32" }],
  },
  {
    name: "getMediaResult",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "jobId", type: "bytes32" }],
    outputs: [
      { name: "uri", type: "string" },
      { name: "contentHash", type: "bytes32" },
      { name: "timestamp", type: "uint256" },
      { name: "encrypted", type: "bool" },
    ],
  },
] as const;

export default function Home() {
  const [modality, setModality] = useState<Modality>("chat");
  const [chatInput, setChatInput] = useState("");
  const [prompt, setPrompt] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "settling" | "error">("idle");
  const [txHash, setTxHash] = useState<string>("");
  const [reply, setReply] = useState<{ type: "text" | "uri"; content: string } | null>(null);
  const [error, setError] = useState("");
  const { address, isConnected } = useAccount();
  const { data: wc } = useWalletClient();

  const [encryptedSecrets, setEncryptedSecrets] = useState<`0x${string}`[]>([]);
  const [selectedExecutor, setSelectedExecutor] = useState<`0x${string}` | null>(null);
  const [contractAddr, setContractAddr] = useState<`0x${string}` | null>(null);

  /* ── On connect ── */
  useEffect(() => {
    if (!isConnected) return;
    (async () => {
      try {
        const mod = await import("eciesjs");
        const { default: ECIES } = mod;
        mod.ECIES_CONFIG.symmetricNonceLength = 12;

        const publicClient = createPublicClient({ chain: Tent, transport: http() });

        // 1. Executor
        const services: any = await publicClient.readContract({
          address: TEE_REGISTRY,
          abi: [{
            name: "getServicesByCapability",
            type: "function",
            stateMutability: "view",
            inputs: [{ name: "capability", type: "uint8" }, { name: "checkValidity", type: "bool" }],
            outputs: [{
              type: "tuple[]",
              components: [{
                name: "node", type: "tuple", components: [
                  { name: "paymentAddress", type: "address" },
                  { name: "teeAddress", type: "address" },
                  { name: "teeType", type: "uint8" },
                  { name: "publicKey", type: "bytes" },
                  { name: "endpoint", type: "string" },
                  { name: "certPubKeyHash", type: "bytes32" },
                  { name: "capability", type: "uint8" },
                ],
              }, { name: "isValid", type: "bool" }, { name: "workloadId", type: "bytes32" }],
            }],
          }],
          functionName: "getServicesByCapability",
          args: [1, true],
        });
        if (services.length === 0) throw new Error("No LLM executor registered.");
        setSelectedExecutor(services[0].node.teeAddress as `0x${string}`);

        // 2. Contract address
        const ca = process.env.NEXT_PUBLIC_CHATGPT_CONTRACT_ADDRESS as `0x${string}` | undefined;
        if (ca && ca !== "0x") setContractAddr(ca);

        // 3. Encrypt GCS creds
        const pubKeyHex = services[0].node.publicKey as `0x${string}`;
        const payload = {
          type: "service_account",
          project_id: process.env.NEXT_PUBLIC_GCS_PROJECT_ID || "cognoxide-dev",
          private_key_id: "placeholder",
          private_key: process.env.GCS_SA_KEY || "-----BEGIN PRIVATE KEY-----\nplaceholder\n-----END PRIVATE KEY-----",
          client_email: process.env.GCS_CLIENT_EMAIL || "placeholder@cognoxide.iam.gserviceaccount.com",
          client_id: "placeholder",
          auth_uri: "https://accounts.google.com/o/oauth2/auth",
          token_uri: "https://oauth2.googleapis.com/token",
          auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
          client_x509_cert_url: "",
        };
        const pubKeyBuf = Buffer.from(pubKeyHex.slice(2), "hex");
        const encrypted = ECIES.encrypt(pubKeyBuf, Buffer.from(JSON.stringify(payload)));
        setEncryptedSecrets([`0x${Buffer.from(encrypted).toString("hex")}`]);
      } catch (e) {
        console.error("Setup failed:", e);
      }
    })();
  }, [isConnected]);

  /* ── LLM direct to precompile ── */
  async function sendChat() {
    if (!wc || !isConnected || encryptedSecrets.length === 0 || !selectedExecutor || !address) return;
    setStatus("submitting"); setError(""); setReply(null);

    try {
      const publicClient = createPublicClient({ chain: Tent, transport: http() });
      const { decodeAbiParameters, parseAbiParameters, encodeAbiParameters } = require("viem");

      const msgs = [
        { role: "system", content: "You are a helpful, private, multi-modal AI assistant." },
        { role: "user", content: chatInput },
      ];
      const convoRef: [string, string, string] = ["gcs", `convos/${address.slice(2, 10)}.jsonl`, "GCS_CREDS"];

      const all30 = parseAbiParameters(
        "address, bytes[], uint256, bytes[], bytes, string, string, int256, string, bool, int256, string, string, uint256, bool, int256, string, bytes, int256, string, string, bool, int256, bytes, bytes, int256, int256, string, bool, (string,string,string)"
      );
      const encoded = encodeAbiParameters(all30, [
        selectedExecutor,
        encryptedSecrets,
        300n,
        [],
        "0x",
        JSON.stringify(msgs),
        "zai-org/GLM-4.7-FP8",
        0n,
        "",
        false,
        4096n,
        "",
        "",
        1n,
        true,
        0n,
        "medium",
        "0x",
        -1n,
        "auto",
        "",
        false,
        700n,
        "0x",
        "0x",
        -1n,
        1000n,
        "",
        false,
        convoRef,
      ]);

      const hash = await wc.sendTransaction({ to: LLM_PRECOMPILE, data: encoded, gas: 3_000_000n });
      setTxHash(hash);
      setStatus("settling");

      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      const spc: any = (receipt as any)?.spcCalls;
      const llmOut = spc?.find((c: any) => c.address.toLowerCase() === LLM_PRECOMPILE.toLowerCase())?.output;
      if (!llmOut) throw new Error("No LLM output in spcCalls");

      const [, actual] = decodeAbiParameters(parseAbiParameters("(bool,bytes)"), llmOut as `0x${string}`);
      const [hasError, completion] = decodeAbiParameters(parseAbiParameters("(bool,bytes)"), actual as `0x${string}`);
      if (hasError) {
        const [, , , errMsg] = decodeAbiParameters(parseAbiParameters("(bool,bytes,bytes,string)"), actual as `0x${string}`);
        throw new Error(errMsg);
      }
      const [,, , , , , , choices] = decodeAbiParameters(
        parseAbiParameters("string,string,uint256,string,string,string,uint256,bytes[]"),
        completion as `0x${string}`
      );
      const choiceAbi = parseAbiParameters("uint256,string,bytes");
      const [, contentRaw] = decodeAbiParameters(choiceAbi, (choices[0] as any));
      setReply({ type: "text", content: contentRaw as string });
      setStatus("idle");
    } catch (e: any) {
      setError(e.message); setStatus("error");
    }
  }

  /* ── Media (image/audio/video) via contract ── */
  async function sendMedia() {
    if (!wc || !isConnected || encryptedSecrets.length === 0 || !selectedExecutor || !contractAddr || !prompt.trim()) return;
    setStatus("submitting"); setError(""); setReply(null);

    try {
      const publicClient = createPublicClient({ chain: Tent, transport: http() });
      const storageRef = ["gcs", `convos/${address!.slice(2, 10)}.jsonl`, "GCS_CREDS"] as [string, string, string];

      let fnName: "requestImage" | "requestAudio" | "requestVideo";
      let args: any[];
      if (modality === "image") {
        fnName = "requestImage";
        args = [selectedExecutor, 300n, prompt.trim(), "black-forest-labs/FLUX.2-klein-4B", 1024, 1024, storageRef, encryptedSecrets];
      } else if (modality === "audio") {
        fnName = "requestAudio";
        args = [selectedExecutor, 300n, prompt.trim(), "hexgrad/Kokoro-82M", 5000, storageRef, encryptedSecrets];
      } else {
        fnName = "requestVideo";
        args = [selectedExecutor, 300n, prompt.trim(), "cogvideo/2.0", 512, 512, 5000, storageRef, encryptedSecrets];
      }

      // Initialize UI state
      setStatus("submitting");
      setError("");
      setReply(null);

      // Build calldata
      const data = encodeFunctionData({ abi: CHAT_ABI, functionName: fnName, args: args as any });

      // eth_call to get return value (bytes32 reqId) without state change
      const returnData = await publicClient.call({
        to: contractAddr,
        data,
        value: 0n,
      });
      // Uint8Array -> hex string
      const dataHex = "0x" + Buffer.from(returnData as any).toString("hex");
      const reqId = decodeFunctionResult({
        abi: CHAT_ABI,
        functionName: fnName,
        data: dataHex as any,
      }) as `0x${string}`;

      // Send transaction
      const hash = await wc.sendTransaction({ to: contractAddr, data, gas: 3_000_000n });
      setTxHash(hash);

      // Wait for inclusion
      await publicClient.waitForTransactionReceipt({ hash });

      setStatus("settling");

      // Poll getMediaResult(reqId)
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const res = await publicClient.readContract({
          address: contractAddr,
          abi: CHAT_ABI,
          functionName: "getMediaResult",
          args: [reqId],
        }) as [string, `0x${string}`, bigint, boolean];
        const [uri] = res;
        if (uri && uri !== "") {
          setReply({ type: "uri", content: uri });
          setStatus("idle");
          return;
        }
      }
      throw new Error("Media generation timed out after 120s.");
    } catch (e: any) {
      setError(e.message); setStatus("error");
    }
  }

  function send() {
    if (modality === "chat") sendChat();
    else sendMedia();
  }

  return (
    <div className="min-h-screen bg-ritual-bg text-ritual-primary">
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute inset-0 bg-noise opacity-30" />
        <div className="absolute inset-0 mesh-gradient" />
      </div>

      <header className="relative z-10 border-b border-[rgba(255,255,255,0.1)] px-6 py-4 flex items-center">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-ritual-green to-ritual-pink flex items-center justify-center glow-green">
            <span className="text-black font-bold">C</span>
          </div>
          <span className="font-archivo text-2xl">Cognoxide ChatGPT</span>
        </div>
        <div className="ml-auto flex items-center gap-4">
          <span className="text-ritual-secondary text-sm font-mono">Ritual Chain (1979)</span>
          <Connector />
        </div>
      </header>

      <main className="relative z-10 max-w-3xl mx-auto px-6 py-12">
        {/* Modality tabs */}
        <div className="flex gap-2 mb-6">
          {(["chat", "image", "audio", "video"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setModality(m)}
              className={`px-4 py-2 rounded-lg capitalize font-semibold transition-all ${
                modality === m
                  ? "bg-ritual-pink text-white shadow-card"
                  : "bg-ritual-elevated border border-[rgba(255,255,255,0.1)] text-ritual-secondary hover:border-ritual-green-40"
              }`}
            >
              {m}
            </button>
          ))}
        </div>

        {/* Chat history */}
        {modality === "chat" && reply?.type === "text" && (
          <div className="mb-6 font-barlow">
            <span className="font-semibold text-ritual-pink">assistant:</span>
            <p>{reply.content}</p>
          </div>
        )}
        {modality === "chat" && error && (
          <div className="mb-6 text-red-400 font-mono text-sm">Error: {error}</div>
        )}

        {/* Media preview */}
        {reply?.type === "uri" && (
          <div className="mb-6 font-barlow">
            <span className="font-semibold text-ritual-pink block mb-2">Result:</span>
            {modality === "image" && <img src={reply.content} alt="Generated" className="rounded-xl border border-[rgba(255,255,255,0.1)] max-w-md" crossOrigin="anonymous" />}
            {modality === "audio" && <audio controls src={reply.content} className="w-full max-w-md">Your browser does not support audio.</audio>}
            {modality === "video" && <video controls src={reply.content} className="rounded-xl border border-[rgba(255,255,255,0.1)] max-w-md">Your browser does not support video.</video>}
            <a href={reply.content} target="_blank" rel="noreferrer" className="text-ritual-green text-sm mt-2 block hover:underline">
              Open asset ↗
            </a>
          </div>
        )}

        {/* Status */}
        {(status === "submitting" || status === "settling") && (
          <div className="mb-6 flex items-center gap-2 text-ritual-lime font-barlow">
            <span className="w-3 h-3 rounded-full bg-ritual-lime animate-pulse" />
            {status === "submitting" ? "Sending transaction…" : "Generating on-chain… 10–60s"}
            {txHash && <span className="text-ritual-secondary text-xs ml-2 font-mono">· Tx: {txHash.slice(0, 18)}…</span>}
          </div>
        )}

        {/* Input form */}
        <div className="bg-ritual-elevated border border-[rgba(255,255,255,0.1)] rounded-2xl p-4 shadow-card">
          {/* Chat input */}
          {modality === "chat" && (
            <div className="flex gap-3">
              <input
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && send()}
                placeholder="Ask anything…"
                className="flex-1 bg-ritual-bg border border-[rgba(255,255,255,0.2)] rounded-xl px-4 py-3 text-ritual-primary placeholder-ritual-secondary focus:outline-none"
                disabled={status === "submitting"}
              />
              <button onClick={send} disabled={status === "submitting" || !chatInput.trim() || !isConnected}
                className="px-6 py-3 bg-ritual-pink text-white font-semibold rounded-xl hover:bg-[rgba(255,29,206,0.9)] disabled:opacity-50">
                {status === "submitting" ? "…" : "Send"}
              </button>
            </div>
          )}

          {/* Media input */}
          {(modality === "image" || modality === "audio" || modality === "video") && (
            <div className="space-y-3">
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder={
                  modality === "image"
                    ? "A neon-lit cyberpunk city street at night with rain and glowing billboards"
                    : modality === "audio"
                    ? "A futuristic synthwave track with driving bass and retro arpeggios"
                    : "A slow pan across a futuristic city skyline at golden hour"
                }
                rows={3}
                className="w-full bg-ritual-bg border border-[rgba(255,255,255,0.2)] rounded-xl px-4 py-3 text-ritual-primary placeholder-ritual-secondary focus:outline-none"
                disabled={status === "submitting"}
              />
              {modality === "image" && (
                <div>
                  <label className="block text-ritual-secondary text-xs mb-1">Negative prompt (optional)</label>
                  <input
                    type="text"
                    // negPrompt state omitted for brevity — reserved for future
                    placeholder="blurry, low quality, watermark..."
                    className="w-full bg-ritual-bg border border-[rgba(255,255,255,0.2)] rounded-xl px-4 py-2 text-sm text-ritual-secondary placeholder-ritual-secondary focus:outline-none opacity-50 cursor-not-allowed"
                    disabled
                  />
                </div>
              )}
              <button
                onClick={send}
                disabled={status === "submitting" || !prompt.trim() || !isConnected}
                className="w-full px-6 py-3 bg-ritual-pink text-white font-semibold rounded-xl hover:bg-[rgba(255,29,206,0.9)] disabled:opacity-50"
              >
                {status === "submitting" ? "…" : `Generate ${modality}`}
              </button>
            </div>
          )}

          <p className="text-ritual-secondary text-xs mt-3 font-mono">
            {modality === "chat"
              ? "LLM precompile (0x0802) · Model: GLM-4.7-FP8 · History: GCS"
              : modality === "image"
              ? "Image precompile (0x0818) via contract · Model: FLUX.2-klein"
              : modality === "audio"
              ? "Audio precompile (0x0819) via contract · Model: Kokoro-82M"
              : "Video precompile (0x081A) via contract · Model: cogvideo/2.0"}
          </p>
        </div>
      </main>
    </div>
  );
}
