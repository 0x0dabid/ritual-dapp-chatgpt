"use client";

import { useState, useCallback, useRef } from "react";
import { useAccount, useWalletClient } from "wagmi";
import { createPublicClient, http, parseAbiParameters, encodeAbiParameters } from "viem";
import { Tent } from "@/lib/tent";

const LLM_PRECOMPILE = "0x0000000000000000000000000000000000000802" as const;

export function useChatStreaming(encryptedSecrets: `0x${string}`[]) {
  const [text, setText] = useState("");
  const [status, setStatus] = useState<
    "idle" | "submitting" | "settling" | "done" | "error"
  >("idle");
  const [txHash, setTxHash] = useState<string>("");
  const [error, setError] = useState<string>("");
  const abortCtrl = useRef<AbortController | null>(null);

  const { address } = useAccount();
  const { data: wc } = useWalletClient();

  const send = useCallback(
    async (
      prompt: string,
      systemPrompt = "You are a helpful DeFi assistant."
    ) => {
      if (!wc || !address) {
        setError("Wallet not connected");
        setStatus("error");
        return;
      }
      if (!encryptedSecrets.length) {
        setError("encryptedSecrets missing — cannot store conversation history");
        setStatus("error");
        return;
      }

      setText("");
      setError("");
      setStatus("submitting");

      try {
        // Select executor dynamically
        const publicClient = createPublicClient({
          chain: Tent,
          transport: http(),
        });
        const TEE_REGISTRY = "0x9644e8562cE0Fe12b4deeC4163c064A8862Bf47F" as const;
        const CAP_LLM = 1;
        const services = await publicClient.readContract({
          address: TEE_REGISTRY,
          abi: [
            {
              name: "getServicesByCapability",
              type: "function",
              stateMutability: "view",
              inputs: [
                { name: "capability", type: "uint8" },
                { name: "checkValidity", type: "bool" },
              ],
              outputs: [
                {
                  type: "tuple[]",
                  components: [
                    {
                      name: "node",
                      type: "tuple",
                      components: [
                        { name: "paymentAddress", type: "address" },
                        { name: "teeAddress", type: "address" },
                        { name: "teeType", type: "uint8" },
                        { name: "publicKey", type: "bytes" },
                        { name: "endpoint", type: "string" },
                        { name: "certPubKeyHash", type: "bytes32" },
                        { name: "capability", type: "uint8" },
                      ],
                    },
                    { name: "isValid", type: "bool" },
                    { name: "workloadId", type: "bytes32" },
                  ],
                },
              ],
            },
          ],
          functionName: "getServicesByCapability",
          args: [CAP_LLM, true],
        });

        if (services.length === 0) {
          setError("No LLM executor registered on Ritual");
          setStatus("error");
          return;
        }
        const executor = services[0].node.teeAddress as `0x${string}`;

        // Encode 30-field ABI
        const messagesJson = JSON.stringify([
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt },
        ]);
        const convoHistory: [string, string, string] = [
          "gcs",
          `convos/${address?.slice(2, 10)}.jsonl`,
          "GCS_CREDS",
        ];

        const abi = parseAbiParameters(
          "address, bytes[], uint256, bytes[], bytes," +
          "string, string, int256, string, bool, int256, string, string," +
          "uint256, bool, int256, string, bytes, int256, string, string, bool," +
          "int256, bytes, bytes, int256, int256, string, bool," +
          "(string,string,string)"
        );

        const encoded = encodeAbiParameters(abi, [
          executor, // 0
          encryptedSecrets, // 1 — GCS credentials blob
          300n, // 2 ttl
          [], // 3 secretSignatures
          "0x", // 4 userPublicKey
          // ── LLM-specific ──
          messagesJson, // 5 messagesJson
          "zai-org/GLM-4.7-FP8", // 6 model
          0n, // 7 frequencyPenalty
          "", // 8 logitBiasJson
          false, // 9 logprobs
          4096n, //10 maxCompletionTokens — >=4096 for reasoning model
          "", //11 metadataJson
          "", //12 modalitiesJson
          1n, //13 n
          true, //14 parallelToolCalls
          0n, //15 presencePenalty
          "medium", //16 reasoningEffort
          "0x", //17 responseFormatData (no JSON schema)
          -1n, //18 seed
          "auto", //19 serviceTier
          "", //20 stopJson
          false, //21 stream (LLM: false; SSE used separately)
          700n, //22 temperature
          "0x", //23 toolChoiceData
          "0x", //24 toolsData
          -1n, //25 topLogprobs
          1000n, //26 topP
          "", //27 user
          false, //28 piiEnabled
          convoHistory, //29 convoHistory
        ]);

        const hash = await wc.sendTransaction({
          to: LLM_PRECOMPILE,
          data: encoded,
          gas: 3_000_000n,
        });
        setTxHash(hash);
        setStatus("settling");

        // Wait for settlement to read spcCalls
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        console.log("LLM settled:", receipt);
        setStatus("done");

        // Extract result from spcCalls
        const spcCalls: any = (receipt as any)?.spcCalls;
        if (!spcCalls || spcCalls.length === 0) {
          setError("No LLM result in receipt spcCalls — reverted?");
          setStatus("error");
          return;
        }
        // Find the LLM precompile output
        const llmOut = spcCalls.find(
          (c: any) => c.address.toLowerCase() === LLM_PRECOMPILE.toLowerCase()
        )?.output;
        if (!llmOut) {
          setError("spcCalls present but no LLM output");
          setStatus("error");
          return;
        }

        // Unwrap (simmedInput, actualOutput)
        const [, actualHex] = decodeAbi("(bytes,bytes)", llmOut as `0x${string}`);
        const [hasError, completionData] = decodeAbi("(bool,bytes)", actualHex as `0x${string}`);
        if (hasError) {
          const [, , , errorMessage] = decodeAbi("(bool,bytes,bytes,string)", actualHex as `0x${string}`);
          setError(errorMessage || "LLM execution error");
          setStatus("error");
          return;
        }

        // Decode completionData nested ABI for content
        const [, , , , , , , choices] = decodeAbi(
          "string,string,uint256,string,string,string,uint256,bytes[]",
          completionData as `0x${string}`
        );
        const choiceArr = choices as readonly `0x${string}`[];
        const [, contentText] = decodeAbi("uint256,string,bytes", choiceArr[0]);
        setText(contentText as string);
        setStatus("done");
      } catch (e: any) {
        setError(e.message ?? "Unknown error");
        setStatus("error");
      }
    },
    [address, wc, encryptedSecrets]
  );

  const stop = useCallback(() => {
    abortCtrl.current?.abort();
  }, []);

  return { text, status, txHash, error, send, stop };
}

/* ---------- tiny ABI helpers (avoid pulling in full viem decodeAbi for Hanami speed) ---------- */

function decodeAbi(types: string, hex: `0x${string}`) {
  // For Hanami agent — use ethers.js style rewrite trimmed to essentials.
  // This uses viem's built-in decodeRight here:
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { decodeAbiParameters, parseAbiParameters } = require("viem");
  return decodeAbiParameters(parseAbiParameters(types), hex);
}
