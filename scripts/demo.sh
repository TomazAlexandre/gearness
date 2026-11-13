#!/usr/bin/env bash
# A ~45-second tour of gearness on a throwaway layered app, made for screen recordings / the README GIF.
#   npm run demo                         (interactive pace)
#   DEMO_PAUSE=0 DEMO_TYPE=0 npm run demo (instant, for CI or a quick look)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GEARNESS=(env FORCE_COLOR=1 node "$ROOT/dist/cli.js")
PAUSE="${DEMO_PAUSE:-1.2}"
TYPE="${DEMO_TYPE:-0.035}"
DIR=$(mktemp -d)
cd "$DIR"

bold=$'\033[1m'; cyan=$'\033[36m'; gray=$'\033[90m'; reset=$'\033[0m'
type_cmd() { # prints "$ <command>" as if typed
  printf '%s$ %s' "$cyan" "$reset"
  local s="$1"
  for ((i = 0; i < ${#s}; i++)); do printf '%s' "${s:i:1}"; sleep "$TYPE"; done
  printf '\n'
}
say() { printf '\n%s# %s%s\n' "$gray" "$1" "$reset"; sleep "$PAUSE"; }
run() { type_cmd "npx gearness $*"; "${GEARNESS[@]}" "$@"; sleep "$PAUSE"; }

# A small app with clean layers: ui/api → services → db → utils
mkdir -p src/{ui,api,services,db,utils}
echo '{"name":"shop","scripts":{"test":"node -e 0","lint":"node -e 0"}}' > package.json
echo 'import { getUser } from "../services/users";' > src/ui/page.tsx
echo 'import { getUser } from "../services/users";' > src/api/routes.ts
echo 'import { query } from "../db/client"; import { fmt } from "../utils/fmt";' > src/services/users.ts
echo 'import { fmt } from "../utils/fmt";' > src/db/client.ts
echo 'export const fmt = (s: string) => s;' > src/utils/fmt.ts
git init -q && git add -A && git -c user.name=demo -c user.email=demo@example.com commit -qm init

clear 2>/dev/null || true
printf '%sgearness%s %s- harness engineering as code%s\n' "$bold" "$reset" "$gray" "$reset"
sleep "$PAUSE"

say "1. Scaffold the harness: AGENTS.md, docs, CI gate, agent adapters"
type_cmd "npx gearness init"
"${GEARNESS[@]}" init | grep -E "Detected|AGENTS.md|harness.yaml|CLAUDE.md|copilot" | head -5
sleep "$PAUSE"

say "2. Infer the architecture from real imports and lock it in"
type_cmd "npx gearness boundaries suggest --strict --write"
"${GEARNESS[@]}" boundaries suggest --strict --write | grep -E "inferred|respects|added" | sed 's/^ *//' | sed 's/^/  /'
sleep "$PAUSE"

say "3. Put the harness in the agent loop"
type_cmd "npx gearness install --only claude"
"${GEARNESS[@]}" install --only claude --command "npx gearness" | head -1
sleep "$PAUSE"

say "4. Claude Code edits src/ui/page.tsx and imports the database directly..."
echo 'import { query } from "../db/client";' >> src/ui/page.tsx
payload="{\"cwd\":\"$DIR\",\"tool_input\":{\"file_path\":\"$DIR/src/ui/page.tsx\"}}"
echo "$payload" | "${GEARNESS[@]}" check --hook claude 2>&1 | head -3 || true
echo "$payload" | "${GEARNESS[@]}" check --hook claude >/dev/null 2>&1 || true # the agent tries again
sed -i.bak '$d' src/ui/page.tsx && rm -f src/ui/page.tsx.bak                      # ...then fixes it
printf '%s  → the agent sees this seconds after the edit and fixes it%s\n' "$gray" "$reset"
sleep "$PAUSE"; sleep "$PAUSE"

say "5. Mistakes agents repeat become rules they read up front"
run learn --apply

say "6. Score the harness"
type_cmd "npx gearness doctor"
"${GEARNESS[@]}" doctor | sed -n '2,10p'
sleep "$PAUSE"; sleep "$PAUSE"
rm -rf "$DIR"
