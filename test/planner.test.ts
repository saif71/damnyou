import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildPlan, normalizeTarget } from "../src/planner.js";
import { deleteTasks } from "../src/executor.js";
import { SafetyError } from "../src/safety.js";
import type { CliOptions } from "../src/types.js";

const emptyOptions = (): CliOptions => ({ targets: [], include: [], exclude: [], dryRun: true, yes: false, json: false, rebuild: false });

async function runCli(args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const cliPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../src/cli.js");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function fixture(manifest: Record<string, unknown> = {}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "damnyou-test-"));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture", ...manifest }));
  return root;
}

test("normalizes documented aliases", () => {
  assert.equal(normalizeTarget("nextjs"), "next");
  assert.equal(normalizeTarget("ts"), "typescript");
  assert.equal(normalizeTarget("pnpm"), "pnpm");
  assert.throws(() => normalizeTarget("webpack"), SafetyError);
});

test("plans npm ci and node_modules repair when package-lock exists", async () => {
  const root = await fixture();
  try {
    await mkdir(path.join(root, "node_modules"));
    await writeFile(path.join(root, "package-lock.json"), "{}");
    const plan = await buildPlan(root, { ...emptyOptions(), targets: ["npm"] });
    assert.equal(plan.selectedManager, "npm");
    assert.equal(plan.tasks.length, 1);
    assert.deepEqual(plan.tasks[0]?.install, { command: "npm", args: ["ci"], label: "npm ci" });
    assert.equal(plan.tasks[0]?.paths[0]?.relativePath, "node_modules");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("requires a choice for multiple lockfiles during automatic discovery", async () => {
  const root = await fixture();
  try {
    await writeFile(path.join(root, "package-lock.json"), "{}");
    await writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const plan = await buildPlan(root, emptyOptions());
    assert.equal(plan.selectedManager, undefined);
    assert.deepEqual(plan.managerChoices, ["npm", "pnpm"]);
    assert.match(plan.warnings.join("\n"), /Multiple package-manager lockfiles/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("discovers only safe known Next.js output", async () => {
  const root = await fixture({ devDependencies: { next: "latest" } });
  try {
    await mkdir(path.join(root, ".next"));
    await mkdir(path.join(root, "build"));
    const plan = await buildPlan(root, emptyOptions());
    assert.deepEqual(plan.tasks.map((task) => task.paths[0]?.relativePath).filter(Boolean), [".next"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an explicit framework target does not imply dependency repair", async () => {
  const root = await fixture({ devDependencies: { next: "latest" } });
  try {
    await mkdir(path.join(root, ".next"));
    await mkdir(path.join(root, "node_modules"));
    await writeFile(path.join(root, "package-lock.json"), "{}");
    const plan = await buildPlan(root, { ...emptyOptions(), targets: ["next"] });
    assert.deepEqual(plan.tasks.map((task) => task.id), ["next:.next"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("includes exact paths and rejects outside-root input", async () => {
  const root = await fixture();
  try {
    await mkdir(path.join(root, "generated"));
    const plan = await buildPlan(root, { ...emptyOptions(), include: ["generated"] });
    assert.equal(plan.tasks[0]?.paths[0]?.relativePath, "generated");
    await assert.rejects(buildPlan(root, { ...emptyOptions(), include: ["../outside"] }), SafetyError);
    await assert.rejects(buildPlan(root, { ...emptyOptions(), include: ["package.json"] }), SafetyError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses symlinked cleanup targets", async () => {
  const root = await fixture({ dependencies: { next: "latest" } });
  const outside = await mkdtemp(path.join(tmpdir(), "damnyou-outside-"));
  try {
    await symlink(outside, path.join(root, ".next"));
    await assert.rejects(buildPlan(root, emptyOptions()), SafetyError);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("deletes selected project-local paths", async () => {
  const root = await fixture();
  try {
    await mkdir(path.join(root, "generated"));
    await writeFile(path.join(root, "generated", "result.txt"), "generated");
    const plan = await buildPlan(root, { ...emptyOptions(), include: ["generated"] });
    const deleted = await deleteTasks(root, plan.tasks);
    assert.deepEqual(deleted, ["generated"]);
    await assert.rejects(mkdir(path.join(root, "generated", "nested")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("allows internal package-manager symlinks inside node_modules", async () => {
  const root = await fixture();
  const outside = await mkdtemp(path.join(tmpdir(), "damnyou-linked-bin-"));
  try {
    await mkdir(path.join(root, "node_modules", ".bin"), { recursive: true });
    await symlink(outside, path.join(root, "node_modules", ".bin", "tool"));
    const plan = await buildPlan(root, { ...emptyOptions(), targets: ["npm"] });
    assert.equal(plan.tasks[0]?.paths[0]?.relativePath, "node_modules");
    await deleteTasks(root, plan.tasks);
    await assert.rejects(access(path.join(root, "node_modules")));
    await access(outside);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("the non-interactive CLI honors --yes and emits JSON", async () => {
  const root = await fixture();
  try {
    await mkdir(path.join(root, "generated"));
    const result = await runCli(["--yes", "--json", "--include", "generated"], root);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).outcome, "completed");
    await assert.rejects(access(path.join(root, "generated")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
