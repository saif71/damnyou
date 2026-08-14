import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { artifactCatalog, targetAliases } from "./catalog.js";
import {
  assertNoSymlinkInPath,
  pathSize,
  resolveInsideRoot,
  SafetyError,
  toSafeRelativePath,
} from "./safety.js";
import {
  packageManagers,
  type CleanupPath,
  type CleanupPlan,
  type CleanupTask,
  type CliOptions,
  type CommandSpec,
  type FrameworkTarget,
  type PackageJson,
  type PackageManager,
  type Target,
} from "./types.js";

const managerLockfiles: Record<PackageManager, string[]> = {
  npm: ["package-lock.json", "npm-shrinkwrap.json"],
  pnpm: ["pnpm-lock.yaml"],
  yarn: ["yarn.lock"],
  bun: ["bun.lock", "bun.lockb"],
};

export function normalizeTarget(input: string): Target {
  const normalized = input.toLowerCase();
  const alias = targetAliases[normalized];
  const candidate = alias ?? normalized;
  if (
    (packageManagers as readonly string[]).includes(candidate) ||
    artifactCatalog.some((item) => item.target === candidate)
  ) {
    return candidate as Target;
  }
  throw new SafetyError(
    `Unknown target: ${input}. Run with --help to see supported targets.`,
  );
}

async function exists(absolutePath: string): Promise<boolean> {
  try {
    await lstat(absolutePath);
    return true;
  } catch {
    return false;
  }
}

async function readManifest(root: string): Promise<PackageJson> {
  try {
    return JSON.parse(
      await readFile(path.join(root, "package.json"), "utf8"),
    ) as PackageJson;
  } catch {
    throw new SafetyError("package.json is not valid JSON.");
  }
}

function dependencyNames(manifest: PackageJson): Set<string> {
  return new Set(
    Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.peerDependencies,
      ...manifest.optionalDependencies,
    }),
  );
}

async function detectedManagers(root: string): Promise<PackageManager[]> {
  const found: PackageManager[] = [];
  for (const manager of packageManagers) {
    if (
      (
        await Promise.all(
          managerLockfiles[manager].map((file) =>
            exists(path.join(root, file)),
          ),
        )
      ).some(Boolean)
    ) {
      found.push(manager);
    }
  }
  return found;
}

function parsePackageManagerField(
  value: string | undefined,
): PackageManager | undefined {
  if (!value) return undefined;
  const name = value.split("@")[0]?.toLowerCase();
  return (packageManagers as readonly string[]).includes(name ?? "")
    ? (name as PackageManager)
    : undefined;
}

async function managerInstall(
  root: string,
  manager: PackageManager,
): Promise<{ install: CommandSpec; fallback?: CommandSpec }> {
  const hasLockfile = (
    await Promise.all(
      managerLockfiles[manager].map((file) => exists(path.join(root, file))),
    )
  ).some(Boolean);
  if (!hasLockfile)
    return {
      install: {
        command: manager,
        args: ["install"],
        label: `${manager} install`,
      },
    };
  if (manager === "npm") {
    return {
      install: { command: "npm", args: ["ci"], label: "npm ci" },
      fallback: { command: "npm", args: ["install"], label: "npm install" },
    };
  }
  return {
    install: {
      command: manager,
      args: ["install", "--frozen-lockfile"],
      label: `${manager} install --frozen-lockfile`,
    },
    fallback: {
      command: manager,
      args: ["install"],
      label: `${manager} install`,
    },
  };
}

async function createPath(
  root: string,
  relativePath: string,
  reason: string,
): Promise<CleanupPath | undefined> {
  const protectedPaths = new Set([
    "package.json",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
  ]);
  const firstSegment = relativePath.split(path.sep)[0];
  if (firstSegment === ".git" || protectedPaths.has(relativePath)) {
    throw new SafetyError(
      `Refusing protected project metadata: ${relativePath}`,
    );
  }
  const absolutePath = resolveInsideRoot(root, relativePath);
  if (!(await exists(absolutePath))) return undefined;
  await assertNoSymlinkInPath(root, absolutePath);
  const stat = await lstat(absolutePath);
  if (stat.isSymbolicLink())
    throw new SafetyError(`Refusing symlinked cleanup target: ${relativePath}`);
  return {
    relativePath,
    absolutePath,
    type: stat.isDirectory() ? "directory" : "file",
    bytes: await pathSize(absolutePath),
    reason,
  };
}

async function typescriptPaths(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".tsbuildinfo"))
    .map((entry) => entry.name);
}

function taskId(target: string, relativePath: string): string {
  return `${target}:${relativePath.replaceAll(path.sep, "/")}`;
}

export async function buildPlan(
  root: string,
  options: CliOptions,
): Promise<CleanupPlan> {
  const packageJson = await readManifest(root);
  const requested = options.targets.map(normalizeTarget);
  const requestedSet = new Set(requested);
  const automatic = requested.length === 0;
  const dependencies = dependencyNames(packageJson);
  const managers = await detectedManagers(root);
  const warnings: string[] = [];
  const tasks: CleanupTask[] = [];
  const reservedPaths = new Set<string>();

  const requestedManagers = requested.filter(
    (target): target is PackageManager =>
      (packageManagers as readonly string[]).includes(target),
  );
  if (requestedManagers.length > 1) {
    throw new SafetyError(
      `Conflicting package manager targets: ${requestedManagers.join(", ")}. Choose exactly one.`,
    );
  }

  const fieldManager = parsePackageManagerField(packageJson.packageManager);
  if (!fieldManager && packageJson.packageManager) {
    warnings.push(
      `Ignoring unrecognized packageManager field: ${packageJson.packageManager}`,
    );
  }

  let selectedManager: PackageManager | undefined;
  if (options.manager) selectedManager = options.manager;
  else if (requestedManagers.length === 1)
    selectedManager = requestedManagers[0];
  else if (fieldManager) selectedManager = fieldManager;
  else if (managers.length === 1) selectedManager = managers[0];
  else if (managers.length === 0) {
    selectedManager = "npm";
    warnings.push("No lockfile found; defaulting to npm.");
  }

  if (
    fieldManager &&
    managers.length > 1 &&
    !options.manager &&
    requestedManagers.length === 0
  ) {
    warnings.push(
      `Multiple lockfiles found (${managers.join(", ")}); using ${fieldManager} from the packageManager field.`,
    );
  }
  if (managers.length > 1 && !selectedManager) {
    warnings.push(
      `Multiple package-manager lockfiles found (${managers.join(", ")}). Select one before repairing dependencies.`,
    );
  }

  // Dependency repair is the core promise: it runs for every invocation,
  // whether the manager was named explicitly, detected, or defaulted.
  if (selectedManager) {
    const { install, fallback } = await managerInstall(root, selectedManager);
    const nodeModules = await createPath(
      root,
      "node_modules",
      "Local installed dependencies",
    );
    tasks.push({
      id: `dependencies:${selectedManager}`,
      label: `Repair dependencies with ${selectedManager}`,
      kind: "dependency",
      target: selectedManager,
      paths: nodeModules ? [nodeModules] : [],
      description: nodeModules
        ? "Delete node_modules, then reinstall dependencies."
        : "Install dependencies (node_modules is already absent).",
      install,
      installFallback: fallback,
    });
    if (nodeModules) reservedPaths.add(nodeModules.relativePath);
  }

  for (const definition of artifactCatalog) {
    const explicitlyRequested = requestedSet.has(definition.target);
    const detected = definition.packageNames.some((name) =>
      dependencies.has(name),
    );
    if (!explicitlyRequested && (!automatic || !detected)) continue;

    const relativePaths =
      definition.target === "typescript"
        ? await typescriptPaths(root)
        : definition.paths;
    let found = 0;
    for (const relativePath of relativePaths) {
      const item = await createPath(root, relativePath, definition.description);
      if (!item || reservedPaths.has(item.relativePath)) continue;
      reservedPaths.add(item.relativePath);
      found += 1;
      tasks.push({
        id: taskId(definition.target, item.relativePath),
        label: `${definition.target}: ${item.relativePath}`,
        kind: "artifact",
        target: definition.target,
        paths: [item],
        description: definition.description,
      });
    }
    if (explicitlyRequested && found === 0)
      warnings.push(
        `No existing safe ${definition.target} artifacts were found.`,
      );
  }

  for (const input of options.include) {
    const relativePath = toSafeRelativePath(input);
    const item = await createPath(
      root,
      relativePath,
      "Explicitly included by --include",
    );
    if (!item) {
      warnings.push(`Included path does not exist: ${relativePath}`);
      continue;
    }
    if (reservedPaths.has(item.relativePath)) continue;
    reservedPaths.add(item.relativePath);
    tasks.push({
      id: taskId("custom", item.relativePath),
      label: `Custom: ${item.relativePath}`,
      kind: "custom",
      target: "custom",
      paths: [item],
      description: "Explicitly included by --include.",
    });
  }

  const excluded = new Set(options.exclude.map(toSafeRelativePath));
  const excludedPathCount = tasks
    .flatMap((task) => task.paths)
    .filter((item) => excluded.has(item.relativePath)).length;
  const filteredTasks = tasks.filter(
    (task) => !task.paths.some((item) => excluded.has(item.relativePath)),
  );
  if (excludedPathCount > 0)
    warnings.push(
      `Excluded ${excludedPathCount} explicitly named path${excludedPathCount === 1 ? "" : "s"}.`,
    );
  if (filteredTasks.length === 0)
    warnings.push("No existing cleanup targets were found.");

  return {
    root,
    packageJson,
    tasks: filteredTasks,
    warnings,
    managerChoices: managers,
    selectedManager,
  };
}

export interface CommandStep {
  spec: CommandSpec;
  fallback?: CommandSpec;
}

export function planCommands(
  plan: CleanupPlan,
  selected: Set<string>,
  options: CliOptions,
): CommandStep[] {
  const steps: CommandStep[] = [];
  for (const task of plan.tasks) {
    if (!selected.has(task.id) || !task.install) continue;
    steps.push({ spec: task.install, fallback: task.installFallback });
  }
  const hasBuildScript = Boolean(plan.packageJson.scripts?.build);
  if (options.rebuild && !hasBuildScript) {
    throw new SafetyError("--rebuild requires a package.json build script.");
  }
  const shouldBuild =
    hasBuildScript &&
    (options.rebuild || (steps.length > 0 && !options.noBuild));
  if (shouldBuild && plan.selectedManager) {
    steps.push({
      spec: {
        command: plan.selectedManager,
        args: ["run", "build"],
        label: `${plan.selectedManager} run build`,
      },
    });
  }
  return steps;
}
