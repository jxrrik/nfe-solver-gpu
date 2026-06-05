#!/bin/bash
# ═══════════════════════════════════════════════════
#  Atualizar solvers GPU remotamente via WebSocket
# ═══════════════════════════════════════════════════
#
#  Uso:
#    bash update-solvers.sh                    # Atualiza TODOS os solvers
#    bash update-solvers.sh --node SOLVER_ID    # Atualiza solver específico
#
#  O que acontece em cada solver:
#    1. git pull origin master
#    2. npm install (se package.json mudou)
#    3. pm2 restart nfe-solver

SECRET="vidal_websocket_secret_key_2025"
WS_URL="https://log.vidal-app.com"
BRANCH="master"
NODE_ID=""

# Parse args
while [[ $# -gt 0 ]]; do
  case $1 in
    --dev)     WS_URL="http://localhost:4000"; shift ;;
    --branch)  BRANCH="$2"; shift 2 ;;
    --node)    NODE_ID="$2"; shift 2 ;;
    *)         shift ;;
  esac
done

echo "═══════════════════════════════════════════"
echo "  🔄 REMOTE SOLVER UPDATE"
echo "  📡 Server: $WS_URL"
echo "  🌿 Branch: $BRANCH"
if [ -n "$NODE_ID" ]; then
  echo "  🎯 Solver: $NODE_ID"
else
  echo "  🎯 Target: ALL solvers"
fi
echo "═══════════════════════════════════════════"
echo ""

# Build JSON body
BODY="{\"branch\":\"$BRANCH\""
if [ -n "$NODE_ID" ]; then
  BODY="$BODY,\"nodeId\":\"$NODE_ID\""
fi
BODY="$BODY}"

RESPONSE=$(curl -s -X POST "$WS_URL/internal/update-nodes" \
  -H "Content-Type: application/json" \
  -H "x-internal-secret: $SECRET" \
  -d "$BODY")

echo "📨 Resposta: $RESPONSE"

# Parse nodesUpdated
UPDATED=$(echo "$RESPONSE" | grep -o '"nodesUpdated":[0-9]*' | grep -o '[0-9]*')

if [ "$UPDATED" = "0" ] || [ -z "$UPDATED" ]; then
  echo ""
  echo "⚠️  Nenhum solver conectado recebeu o update."
  echo "    Verifique se os solvers estão online: pm2 logs nfe-solver"
else
  echo ""
  echo "✅ Update enviado para $UPDATED solver(s)!"
  echo "   Eles vão: git pull → npm install → pm2 restart"
  echo ""
  echo "📋 Acompanhe os logs:"
  echo "   pm2 logs nfe-solver"
fi
