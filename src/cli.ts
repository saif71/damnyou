#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPlan, planCommands } from "./planner.js";
import { commandExists, deleteTasks, runCommand } from "./executor.js";
import { ensureProjectRoot, formatBytes, SafetyError } from "./safety.js";
import { chooseManager, chooseTasks, confirm, renderPlan } from "./ui.js";
import {
  packageManagers,
  type CliOptions,
  type CleanupPlan,
  type PackageManager,
} from "./types.js";

const pkgVersion = (
  JSON.parse(
    readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "..",
        "package.json",
      ),
      "utf8",
    ),
  ) as { version: string }
).version;

const help = `
damnyou — safely remove regeneratable JavaScript project artifacts

Usage:
  damnyou [targets...] [options]

Targets:
  npm pnpm yarn bun
  next (nextjs) astro vite nuxt remix sveltekit storybook vitest jest eslint typescript

  Dependencies are always repaired: node_modules is deleted and reinstalled,
  and the build script runs after the reinstall when one is defined.

Options:
  --include <path>   Add an exact project-relative file or directory (repeatable)
  --exclude <path>   Exclude an exact detected path (repeatable)
  --manager <name>   Choose npm, pnpm, yarn, or bun when lockfiles conflict
  --rebuild          Run the build script even without a reinstall
  --no-build         Skip the automatic build after a reinstall
  --dry-run          Show the plan without changing files
  --yes              Accept default selections and confirmation
  --json             Emit the plan/result as JSON to stdout
  --help             Show this help
  --version          Show the version
`;

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    targets: [],
    include: [],
    exclude: [],
    dryRun: false,
    yes: false,
    json: false,
    rebuild: false,
    noBuild: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (!arg.startsWith("-")) {
      options.targets.push(arg);
      continue;
    }
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--yes") options.yes = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--rebuild") options.rebuild = true;
    else if (arg === "--no-build") options.noBuild = true;
    else if (
      arg === "--include" ||
      arg === "--exclude" ||
      arg === "--manager"
    ) {
      const value = argv[++index];
      if (!value || value.startsWith("-"))
        throw new SafetyError(`${arg} requires a value.`);
      if (arg === "--include") options.include.push(value);
      else if (arg === "--exclude") options.exclude.push(value);
      else {
        if (!(packageManagers as readonly string[]).includes(value))
          throw new SafetyError(`Unsupported package manager: ${value}`);
        options.manager = value as PackageManager;
      }
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(help);
      process.exit(0);
    } else if (arg === "--version" || arg === "-v") {
      process.stdout.write(`${pkgVersion}\n`);
      process.exit(0);
    } else throw new SafetyError(`Unknown option: ${arg}`);
  }
  return options;
}

function commandText(command: { command: string; args: string[] }): string {
  return [command.command, ...command.args].join(" ");
}

function serialize(
  plan: CleanupPlan,
  selected: Set<string>,
  commands: string[],
  outcome: string,
  deleted: string[] = [],
  runtimeWarnings: string[] = [],
  error?: string,
) {
  return {
    version: 1,
    outcome,
    root: plan.root,
    selectedTaskIds: [...selected],
    tasks: plan.tasks.map((task) => ({
      id: task.id,
      selected: selected.has(task.id),
      label: task.label,
      kind: task.kind,
      target: task.target,
      paths: task.paths.map((item) => ({
        path: item.relativePath,
        type: item.type,
        bytes: item.bytes,
        reason: item.reason,
      })),
      install: task.install ? commandText(task.install) : undefined,
    })),
    commands,
    deleted,
    warnings: [...plan.warnings, ...runtimeWarnings],
    ...(error ? { error } : {}),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const root = await ensureProjectRoot(process.cwd());
  let plan = await buildPlan(root, options);

  if (!plan.selectedManager && plan.managerChoices.length > 1) {
    if (!process.stdin.isTTY)
      throw new SafetyError(
        "Multiple lockfiles found; use --manager <npm|pnpm|yarn|bun> in non-interactive mode.",
      );
    const manager = await chooseManager(plan.managerChoices);
    if (!manager) {
      process.stdout.write("Cancelled. Nothing was changed.\n");
      return;
    }
    plan = await buildPlan(root, { ...options, manager });
  }

  const selected = new Set(plan.tasks.map((task) => task.id));
  const selectedTasks = () =>
    plan.tasks.filter((task) => selected.has(task.id));
  const stepsFor = () => planCommands(plan, selected, options);
  const commands = stepsFor().map((step) => commandText(step.spec));

  if (options.json) {
    if (options.dryRun || !options.yes) {
      process.stdout.write(
        `${JSON.stringify(serialize(plan, selected, commands, "preview"), null, 2)}\n`,
      );
      if (!options.dryRun && !options.yes) process.exitCode = 2;
      return;
    }
  } else if (options.dryRun) {
    process.stdout.write(
      `${renderPlan(plan, selected, commands)}\n\nDry run: no files were changed.\n`,
    );
    return;
  } else if ((!process.stdin.isTTY || !process.stdout.isTTY) && !options.yes) {
    process.stdout.write(
      `${renderPlan(plan, selected, commands)}\n\nNon-interactive mode requires --yes to perform cleanup.\n`,
    );
    process.exitCode = 2;
    return;
  } else if (!options.yes) {
    const renderSelection = () =>
      renderPlan(
        plan,
        selected,
        stepsFor().map((step) => commandText(step.spec)),
      );
    const chosen = await chooseTasks(plan, renderSelection);
    if (!chosen) {
      process.stdout.write("Cancelled. Nothing was changed.\n");
      return;
    }
    selected.clear();
    for (const id of chosen) selected.add(id);
    if (!(await confirm())) {
      process.stdout.write("Cancelled. Nothing was changed.\n");
      return;
    }
  }

  const steps = stepsFor();
  for (const step of steps) {
    if (!(await commandExists(step.spec.command)))
      throw new SafetyError(
        `Required command was not found on PATH: ${step.spec.command}`,
      );
  }

  const startedAt = Date.now();
  const deleted = await deleteTasks(
    root,
    selectedTasks(),
    options.json
      ? undefined
      : (item) =>
          process.stdout.write(
            `Removing ${item.relativePath} (${formatBytes(item.bytes)})...\n`,
          ),
  );
  if (!options.json) {
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    process.stdout.write(
      deleted.length > 0
        ? `\nRemoved ${deleted.length} path${deleted.length === 1 ? "" : "s"} in ${seconds}s.\n`
        : "\nNothing to remove.\n",
    );
  }
  const runtimeWarnings: string[] = [];
  try {
    for (const step of steps) {
      try {
        if (!options.json)
          process.stdout.write(`\nRunning: ${commandText(step.spec)}\n`);
        await runCommand(step.spec, root, options.json);
      } catch (error) {
        if (!step.fallback) throw error;
        const message = error instanceof Error ? error.message : String(error);
        runtimeWarnings.push(
          `${step.spec.label} failed (${message}); fell back to ${commandText(step.fallback)}.`,
        );
        if (!options.json)
          process.stdout.write(
            `\n⚠ ${step.spec.label} failed; falling back to ${commandText(step.fallback)}.\n`,
          );
        await runCommand(step.fallback, root, options.json);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.json)
      process.stdout.write(
        `${JSON.stringify(
          serialize(
            plan,
            selected,
            steps.map((step) => commandText(step.spec)),
            "failed",
            deleted,
            runtimeWarnings,
            message,
          ),
          null,
          2,
        )}\n`,
      );
    throw new SafetyError(`Cleanup completed, but ${message}`);
  }

  if (options.json)
    process.stdout.write(
      `${JSON.stringify(
        serialize(
          plan,
          selected,
          steps.map((step) => commandText(step.spec)),
          "completed",
          deleted,
          runtimeWarnings,
        ),
        null,
        2,
      )}\n`,
    );
  else {
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    process.stdout.write(
      steps.length > 0
        ? `\nDone in ${seconds}s.\n`
        : deleted.length > 0
          ? `\nDone. Removed ${deleted.length} path${deleted.length === 1 ? "" : "s"}.\n`
          : "\nDone. Nothing to do.\n",
    );
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (process.argv.includes("--json")) process.stderr.write(`${message}\n`);
  else process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
});
