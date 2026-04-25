#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
CONTRACTS_DIR="$PROJECT_ROOT/contracts"
WEB_DIR="$PROJECT_ROOT/web"

echo "==============================="
echo "  Ritual ChatGPT Quick-Start"
echo "==============================="

cmd="${1:-help}"

case "$cmd" in
  install-contracts)
    echo "📦 Installing contract dependencies..."
    cd "$CONTRACTS_DIR"
    npm install
    ;;

  compile)
    echo "🔨 Compiling contracts..."
    cd "$CONTRACTS_DIR"
    npx hardhat compile
    ;;

  deploy)
    echo "🚀 Deploying to Ritual testnet..."
    if [[ -z "${RITUAL_PRIVATE_KEY:-}" ]]; then
      echo "❌ RITUAL_PRIVATE_KEY not set. Export it first:"
      echo "   export RITUAL_PRIVATE_KEY=0x..."
      exit 1
    fi
    cd "$CONTRACTS_DIR"
    npx hardhat run scripts/deploy.js --network testnet
    echo ""
    echo "✅ Deployed. Next:"
    echo "   cp .env.ritual $WEB_DIR/.env.local"
    ;;

  install-web)
    echo "📦 Installing frontend dependencies..."
    cd "$WEB_DIR"
    npm install
    ;;

  dev)
    echo "🌐 Starting Next.js dev server..."
    cd "$WEB_DIR"
    npm run dev
    ;;

  all)
    echo "▶️  Running full first-time setup: install → compile → deploy → copy env"
    "$0" install-contracts
    "$0" compile
    "$0" deploy
    cp "$CONTRACTS_DIR/.env.ritual" "$WEB_DIR/.env.local"
    echo "✅ All set. Run '$0 dev' to start the frontend."
    ;;

  *)
    echo "Usage: $0 {install-contracts|compile|deploy|install-web|dev|all}"
    echo ""
    echo "  install-contracts  npm install in contracts/"
    echo "  compile            hardhat compile"
    echo "  deploy             hardhat run --network testnet (needs RITUAL_PRIVATE_KEY)"
    echo "  install-web        npm install in web/"
    echo "  dev                npm run dev in web/"
    echo "  all                one-click setup (after setting RITUAL_PRIVATE_KEY)"
    exit 1
    ;;
esac
