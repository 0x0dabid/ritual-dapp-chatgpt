"use client";

import { useAccount, useConnect, useDisconnect, useWalletClient } from "wagmi";
import { injected } from "wagmi/connectors";

export function Connector() {
  const { address, isConnected } = useAccount();
  const { connect } = useConnect();
  const { disconnect } = useDisconnect();

  if (isConnected) {
    return (
      <div className="flex items-center gap-2">
        <span className="font-mono text-sm text-ritual-lime bg-ritual-elevated px-3 py-1 rounded-full border border-ritual-lime/30">
          {address?.slice(0, 10)}…{address?.slice(-6)}
        </span>
        <button
          onClick={() => disconnect()}
          className="px-3 py-1 text-sm border border-white/20 rounded-full hover:bg-white/5"
        >
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={() => connect({ connector: injected() })}
      className="px-6 py-2 bg-ritual-green text-black font-semibold rounded-xl hover:bg-ritual-lime transition-colors"
    >
      Connect Wallet
    </button>
  );
}
