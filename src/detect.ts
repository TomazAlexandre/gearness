import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { Stack } from "./config.js";
import { exists, readFile } from "./util.js";

export interface Detection {
  name: string;
  stack: Stack;
  commands: Record<string, string>;
  notes: string[];
}

export function makeTargets(cwd: string): Set<string> {
  const mk = readFile(path.join(cwd, "Makefile"));
  const targets = new Set<string>();
  if (!mk) return targets;
  for (const m of mk.matchAll(/^([A-Za-z0-9_.-]+)\s*:(?!=)/gm)) targets.add(m[1]);
  return targets;
}

export function justRecipes(cwd: string): Set<string> {
  const jf = ["justfile", "Justfile", ".justfile"].map((f) => readFile(path.join(cwd, f))).find((t) => t !== null);
  const out = new Set<string>();
  if (!jf) return out;
  for (const m of jf.matchAll(/^@?([A-Za-z0-9_-]+)(?:[ \t][^:\n=]*)?:(?!=)/gm)) out.add(m[1]);
  return out;
}

export function taskfileTasks(cwd: string): Set<string> {
  const tf = ["Taskfile.yml", "Taskfile.yaml", "taskfile.yml"].map((f) => readFile(path.join(cwd, f))).find((t) => t !== null);
  try {
    const data = tf ? (YAML.parse(tf) as { tasks?: Record<string, unknown> }) : null;
    return new Set(Object.keys(data?.tasks ?? {}));
  } catch {
    return new Set();
  }
}

/** Workspace globs declared by the package manager / build tool, if this is a monorepo. */
export function detectWorkspaces(cwd: string): string[] {
  const globs: string[] = [];
  const pkg = readFile(path.join(cwd, "package.json"));
  if (pkg)
    try {
      const w = JSON.parse(pkg).workspaces;
      globs.push(...(Array.isArray(w) ? w : Array.isArray(w?.packages) ? w.packages : []));
    } catch {
      /* ignore */
    }
  const pnpm = readFile(path.join(cwd, "pnpm-workspace.yaml"));
  if (pnpm)
    try {
      globs.push(...((YAML.parse(pnpm) as { packages?: string[] })?.packages ?? []));
    } catch {
      /* ignore */
    }
  const cargo = readFile(path.join(cwd, "Cargo.toml"));
  const members = cargo?.match(/\[workspace\][\s\S]*?members\s*=\s*\[([^\]]*)\]/);
  if (members) globs.push(...[...members[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));
  const gowork = readFile(path.join(cwd, "go.work"));
  if (gowork) {
    const block = gowork.match(/use\s*\(([^)]*)\)/);
    const lines = block ? block[1].split("\n") : [...gowork.matchAll(/^use\s+(\S+)/gm)].map((m) => m[1]);
    globs.push(...lines.map((l) => l.trim()).filter((l) => l && l !== "." && !l.startsWith("//")));
  }
  return [...new Set(globs.filter((g) => !g.startsWith("!")).map((g) => g.replace(/^\.\//, "")))];
}

export function detect(cwd: string): Detection {
  const has = (f: string) => exists(path.join(cwd, f));
  const notes: string[] = [];
  let name = path.basename(path.resolve(cwd));
  const commands: Record<string, string> = {};
  let stack: Stack = "generic";

  const pkgText = readFile(path.join(cwd, "package.json"));
  if (pkgText) {
    stack = "node";
    let pkg: { name?: string; scripts?: Record<string, string> } = {};
    try {
      pkg = JSON.parse(pkgText);
    } catch {
      notes.push("package.json is not valid JSON; scripts were not detected");
    }
    if (pkg.name) name = pkg.name;
    const pm = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lockb") || has("bun.lock") ? "bun" : "npm";
    commands.install = pm === "npm" ? (has("package-lock.json") ? "npm ci" : "npm install") : `${pm} install`;
    const scripts = pkg.scripts ?? {};
    for (const s of ["build", "typecheck", "lint", "test"]) {
      if (scripts[s]) commands[s] = `${pm} run ${s}`;
    }
    if (!scripts.test) notes.push("no `test` script in package.json - agents will have no way to verify behavior");
    if (!scripts.lint) notes.push("no `lint` script in package.json - consider adding one; linters are the cheapest guardrail");
  } else if (has("pyproject.toml") || has("requirements.txt") || has("setup.py")) {
    stack = "python";
    const py = readFile(path.join(cwd, "pyproject.toml")) ?? "";
    const n = py.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
    if (n) name = n[1];
    const uv = has("uv.lock");
    const run = uv ? "uv run " : "";
    commands.install = uv ? "uv sync" : has("requirements.txt") ? "pip install -r requirements.txt" : "pip install -e .";
    if (/ruff/.test(py) || has("ruff.toml")) commands.lint = `${run}ruff check .`;
    if (/mypy/.test(py)) commands.typecheck = `${run}mypy .`;
    commands.test = `${run}pytest`;
  } else if (has("go.mod")) {
    stack = "go";
    const mod = readFile(path.join(cwd, "go.mod")) ?? "";
    const n = mod.match(/^module\s+(\S+)/m);
    if (n) name = n[1].split("/").pop() ?? name;
    commands.build = "go build ./...";
    commands.lint = "go vet ./...";
    commands.test = "go test ./...";
  } else if (has("Cargo.toml")) {
    stack = "rust";
    const cargo = readFile(path.join(cwd, "Cargo.toml")) ?? "";
    const n = cargo.match(/^\s*name\s*=\s*"([^"]+)"/m);
    if (n) name = n[1];
    commands.build = "cargo build";
    commands.lint = "cargo clippy -- -D warnings";
    commands.test = "cargo test";
  } else if (fs.readdirSync(cwd).some((f) => f.endsWith(".sln") || f.endsWith(".csproj"))) {
    stack = "dotnet";
    commands.build = "dotnet build";
    commands.lint = "dotnet format --verify-no-changes";
    commands.test = "dotnet test";
  } else if (has("pom.xml")) {
    stack = "java";
    const mvn = has("mvnw") ? "./mvnw" : "mvn";
    commands.build = `${mvn} -q -DskipTests package`;
    commands.test = `${mvn} -q test`;
  } else if (has("build.gradle") || has("build.gradle.kts")) {
    stack = "java";
    const gradle = has("gradlew") ? "./gradlew" : "gradle";
    commands.build = `${gradle} assemble`;
    commands.test = `${gradle} test`;
  }

  // Task runners are explicit, human-curated interfaces: prefer their targets.
  const runners: [string, Set<string>][] = [
    ["task", taskfileTasks(cwd)],
    ["just", justRecipes(cwd)],
    ["make", makeTargets(cwd)],
  ];
  for (const t of ["build", "lint", "typecheck", "test"]) {
    const hit = runners.find(([, set]) => set.has(t));
    if (hit) commands[t] = `${hit[0]} ${t}`;
  }

  if (stack === "generic" && Object.keys(commands).length === 0)
    notes.push("stack not detected - fill `commands` in harness.yaml by hand");

  return { name, stack, commands, notes };
}
