import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  mkdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildPlan, normalizeTarget, planCommands } from "../src/planner.js";
import { commandExists, deleteTasks } from "../src/executor.js";
import { SafetyError } from "../src/safety.js";
import type { CliOptions } from "../src/types.js";

const emptyOptions = (): CliOptions => ({
  targets: [],
  include: [],
  exclude: [],
  dryRun: true,
  yes: false,
  json: false,
  rebuild: false,
  noBuild: false,
});

async function runCli(
  args: string[],
  cwd: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const cliPath = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "../src/cli.js",
  );
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function fixture(
  manifest: Record<string, unknown> = {},
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "damnyou-test-"));
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "fixture", ...manifest }),
  );
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
    assert.deepEqual(plan.tasks[0]?.install, {
      command: "npm",
      args: ["ci"],
      label: "npm ci",
    });
    assert.equal(plan.tasks[0]?.paths[0]?.relativePath, "node_modules");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("requires a choice for multiple lockfiles during automatic discovery", async () => {
  const root = await fixture();
  try {
    await writeFile(path.join(root, "package-lock.json"), "{}");
    await writeFile(
      path.join(root, "pnpm-lock.yaml"),
      "lockfileVersion: '9.0'\n",
    );
    const plan = await buildPlan(root, emptyOptions());
    assert.equal(plan.selectedManager, undefined);
    assert.deepEqual(plan.managerChoices, ["npm", "pnpm"]);
    assert.match(
      plan.warnings.join("\n"),
      /Multiple package-manager lockfiles/,
    );
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
    assert.deepEqual(
      plan.tasks.map((task) => task.paths[0]?.relativePath).filter(Boolean),
      [".next"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an explicit framework target also repairs dependencies", async () => {
  const root = await fixture({ devDependencies: { next: "latest" } });
  try {
    await mkdir(path.join(root, ".next"));
    await mkdir(path.join(root, "node_modules"));
    await writeFile(path.join(root, "package-lock.json"), "{}");
    const plan = await buildPlan(root, {
      ...emptyOptions(),
      targets: ["next"],
    });
    assert.deepEqual(
      plan.tasks.map((task) => task.id),
      ["dependencies:npm", "next:.next"],
    );
    const selected = new Set(plan.tasks.map((task) => task.id));
    const labels = planCommands(plan, selected, {
      ...emptyOptions(),
      targets: ["next"],
    }).map((step) => step.spec.label);
    assert.deepEqual(labels, ["npm ci"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("includes exact paths and rejects outside-root input", async () => {
  const root = await fixture();
  try {
    await mkdir(path.join(root, "generated"));
    const plan = await buildPlan(root, {
      ...emptyOptions(),
      include: ["generated"],
    });
    const custom = plan.tasks.find((task) => task.kind === "custom");
    assert.equal(custom?.paths[0]?.relativePath, "generated");
    await assert.rejects(
      buildPlan(root, { ...emptyOptions(), include: ["../outside"] }),
      SafetyError,
    );
    await assert.rejects(
      buildPlan(root, { ...emptyOptions(), include: ["package.json"] }),
      SafetyError,
    );
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
    const deleted: string[] = [];
    const plan = await buildPlan(root, {
      ...emptyOptions(),
      include: ["generated"],
    });
    await deleteTasks(root, plan.tasks, (item) =>
      deleted.push(item.relativePath),
    );
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

test("the non-interactive CLI honors --yes, repairs deps, and emits JSON", async () => {
  const root = await fixture();
  try {
    await mkdir(path.join(root, "generated"));
    const result = await runCli(
      ["--yes", "--json", "--include", "generated"],
      root,
    );
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.outcome, "completed");
    assert.deepEqual(report.commands, ["npm install"]);
    await assert.rejects(access(path.join(root, "generated")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects conflicting package manager targets", async () => {
  const root = await fixture();
  try {
    await assert.rejects(
      buildPlan(root, { ...emptyOptions(), targets: ["npm", "bun"] }),
      /Conflicting package manager targets/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uses the packageManager field despite multiple lockfiles", async () => {
  const root = await fixture({ packageManager: "bun@1.1.0" });
  try {
    await writeFile(path.join(root, "package-lock.json"), "{}");
    await writeFile(path.join(root, "bun.lockb"), "");
    const plan = await buildPlan(root, emptyOptions());
    assert.equal(plan.selectedManager, "bun");
    assert.match(
      plan.warnings.join("\n"),
      /using bun from the packageManager field/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("defaults to npm when no lockfile exists", async () => {
  const root = await fixture();
  try {
    const plan = await buildPlan(root, emptyOptions());
    assert.equal(plan.selectedManager, "npm");
    assert.deepEqual(plan.tasks[0]?.install, {
      command: "npm",
      args: ["install"],
      label: "npm install",
    });
    assert.match(plan.warnings.join("\n"), /defaulting to npm/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plans an install fallback for frozen installs", async () => {
  const root = await fixture();
  try {
    await writeFile(path.join(root, "package-lock.json"), "{}");
    const plan = await buildPlan(root, { ...emptyOptions(), targets: ["npm"] });
    assert.deepEqual(plan.tasks[0]?.installFallback, {
      command: "npm",
      args: ["install"],
      label: "npm install",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runs the build script automatically after a reinstall", async () => {
  const root = await fixture({ scripts: { build: "tsc" } });
  try {
    await writeFile(path.join(root, "package-lock.json"), "{}");
    const plan = await buildPlan(root, { ...emptyOptions(), targets: ["npm"] });
    const selected = new Set(plan.tasks.map((task) => task.id));
    const labels = planCommands(plan, selected, {
      ...emptyOptions(),
      targets: ["npm"],
    }).map((step) => step.spec.label);
    assert.deepEqual(labels, ["npm ci", "npm run build"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("--no-build skips the automatic build and --rebuild forces it without a reinstall", async () => {
  const root = await fixture({ scripts: { build: "tsc" } });
  try {
    await writeFile(path.join(root, "package-lock.json"), "{}");
    const plan = await buildPlan(root, { ...emptyOptions(), targets: ["npm"] });
    const selected = new Set(plan.tasks.map((task) => task.id));
    const skipped = planCommands(plan, selected, {
      ...emptyOptions(),
      targets: ["npm"],
      noBuild: true,
    }).map((step) => step.spec.label);
    assert.deepEqual(skipped, ["npm ci"]);
    const forced = planCommands(plan, new Set(), {
      ...emptyOptions(),
      rebuild: true,
    }).map((step) => step.spec.label);
    assert.deepEqual(forced, ["npm run build"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("--rebuild without a build script fails", async () => {
  const root = await fixture();
  try {
    const plan = await buildPlan(root, emptyOptions());
    assert.throws(
      () =>
        planCommands(plan, new Set(plan.tasks.map((task) => task.id)), {
          ...emptyOptions(),
          rebuild: true,
        }),
      /requires a package.json build script/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("--exclude warns only when it matched a planned path", async () => {
  const root = await fixture();
  try {
    await mkdir(path.join(root, "generated"));
    const matched = await buildPlan(root, {
      ...emptyOptions(),
      include: ["generated"],
      exclude: ["generated"],
    });
    assert.equal(
      matched.tasks.filter((task) => task.kind === "custom").length,
      0,
    );
    assert.match(
      matched.warnings.join("\n"),
      /Excluded 1 explicitly named path/,
    );
    const unmatched = await buildPlan(root, {
      ...emptyOptions(),
      include: ["generated"],
      exclude: ["missing"],
    });
    assert.doesNotMatch(unmatched.warnings.join("\n"), /Excluded/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deleteTasks tolerates paths that vanished after planning", async () => {
  const root = await fixture();
  try {
    await mkdir(path.join(root, "generated"));
    const plan = await buildPlan(root, {
      ...emptyOptions(),
      include: ["generated"],
    });
    await rm(path.join(root, "generated"), { recursive: true, force: true });
    const deleted = await deleteTasks(root, plan.tasks);
    assert.deepEqual(deleted, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("commandExists ignores directories on PATH", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "damnyou-path-"));
  try {
    await mkdir(path.join(directory, "faketool"));
    const previous = process.env.PATH;
    process.env.PATH = `${directory}${path.delimiter}${previous ?? ""}`;
    try {
      assert.equal(await commandExists("faketool"), false);
      assert.equal(await commandExists("node"), true);
    } finally {
      process.env.PATH = previous;
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
