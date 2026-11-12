#!/usr/bin/env bash
# A 60-second tour of gearness on a throwaway layered app. Good for screen recordings.
#   npm run build && bash scripts/demo.sh
set -euo pipefail
G="node $(cd "$(dirname "$0")/.." && pwd)/dist/cli.js"
DIR=$(mktemp -d)
cd "$DIR"
step() { printf '\n\033[1;36m$ %s\033[0m\n' "$*"; sleep "${DEMO_PAUSE:-1}"; }

mkdir -p src/{ui,api,services,db,utils}
echo '{"name":"shop","scripts":{"test":"node -e 0","lint":"node -e 0"}}' > package.json
echo 'import { getUser } from "../services/users";' > src/ui/page.tsx
echo 'import { getUser } from "../services/users";' > src/api/routes.ts
echo 'import { query } from "../db/client"; import { fmt } from "../utils/fmt";' > src/services/users.ts
echo 'import { fmt } from "../utils/fmt";' > src/db/client.ts
echo 'export const fmt = (s: string) => s;' > src/utils/fmt.ts
git init -q && git add -A && git -c user.name=demo -c user.email=demo@example.com commit -qm init

step gearness init;                     $G init | tail -6
step gearness boundaries suggest --strict --write; $G boundaries suggest --strict --write | tail -3
step gearness install --only claude;    $G install --only claude --command "$G" | head -1

step "# an agent edits src/ui/page.tsx and imports the database directly…"
echo 'import { query } from "../db/client";' >> src/ui/page.tsx
for _ in 1 2; do echo "{\"cwd\":\"$DIR\",\"tool_input\":{\"file_path\":\"$DIR/src/ui/page.tsx\"}}" | $G check --hook claude || true; done

step gearness learn --apply;            $G learn --apply
step gearness graph;                    $G graph
step gearness context src/ui/page.tsx --agent claude; $G context src/ui/page.tsx --agent claude
step gearness doctor;                   $G doctor
echo -e "\nDemo repository: $DIR"
