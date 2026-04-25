"use client";

import type { ReactNode } from "react";
import { WagmiProvider, http, createConfig, injected } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Tent } from "../lib/tent";

const config = createConfig({
  chains: [Tent],
  transports: {
    [Tent.id]: http(process.env.NEXT_PUBLIC_RITUAL_RPC_URL!),
  },
  connectors: [injected()], // only browser injectors (MetaMask, Brave, etc.)
});

const qc = new QueryClient();

export function Web3Provider({ children }: { children: ReactNode }) {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
