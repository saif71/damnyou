import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { artifactCatalog, targetAliases } from "./catalog.js";
import { assertNoSymlinkInPath, pathSize, resolveInsideRoot, SafetyError, toSafeRelativePath } from "./safety.js";
import { packageManagers, type CleanupPath, type CleanupPlan, type CleanupTask, type CliOptions, type CommandSpec, type FrameworkTarget, type PackageJson, type PackageManager, type Target } from "./types.js";

const managerLockfiles: Record<PackageManager, string[]> = {
  npm: ["package-lock.json", "npm-shrinkwrap.json"],
  pnpm: ["pnpm-lock.yaml"],
  yarn: ["yarn.lock"],
  bun: ["bun.lock", "bun.lockb"]
};

export function normalizeTarget(input: string): Target {
  const normalized = input.toLowerCase();
  const alias = targetAliases[normalized];
  const candidate = alias ?? normalized;
  if ((packageManagers as readonly string[]).includes(candidate) || artifactCatalog.some((item) => item.target === candidate)) {
    return candidate as Target;
  }
  throw new SafetyError(`Unknown target: ${input}. Run with --help to see supported targets.`);
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
    return JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as PackageJson;
  } catch {
    throw new SafetyError("package.json is not valid JSON.");
  }
}

function dependencyNames(manifest: PackageJson): Set<string> {
  return new Set(Object.keys({
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.peerDependencies,
    ...manifest.optionalDependencies
  }));
}

async function detectedManagers(root: string): Promise<PackageManager[]> {
  const found: PackageManager[] = [];
  for (const manager of packageManagers) {
    if ((await Promise.all(managerLockfiles[manager].map((file) => exists(path.join(root, file))))).some(Boolean)) {
      found.push(manager);
    }
  }
  return found;
}

async function managerInstall(root: string, manager: PackageManager): Promise<CommandSpec> {
  const hasLockfile = (await Promise.all(managerLockfiles[manager].map((file) => exists(path.join(root, file))))).some(Boolean);
  if (!hasLockfile) return { command: manager, args: ["install"], label: `${manager} install` };
  if (manager === "npm") return { command: "npm", args: ["ci"], label: "npm ci" };
  return { command: manager, args: ["install", "--frozen-lockfile"], label: `${manager} install --frozen-lockfile` };
}

async function createPath(root: string, relativePath: string, reason: string): Promise<CleanupPath | undefined> {
  const protectedPaths = new Set([
    "package.json",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lock",
    "bun.lockb"
  ]);
  const firstSegment = relativePath.split(path.sep)[0];
  if (firstSegment === ".git" || protectedPaths.has(relativePath)) {
    throw new SafetyError(`Refusing protected project metadata: ${relativePath}`);
  }
  const absolutePath = resolveInsideRoot(root, relativePath);
  if (!(await exists(absolutePath))) return undefined;
  await assertNoSymlinkInPath(root, absolutePath);
  const stat = await lstat(absolutePath);
  if (stat.isSymbolicLink()) throw new SafetyError(`Refusing symlinked cleanup target: ${relativePath}`);
  return {
    relativePath,
    absolutePath,
    type: stat.isDirectory() ? "directory" : "file",
    bytes: await pathSize(absolutePath),
    reason
  };
}

async function typescriptPaths(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".tsbuildinfo")).map((entry) => entry.name);
}

function taskId(target: string, relativePath: string): string {
  return `${target}:${relativePath.replaceAll(path.sep, "/")}`;
}

export async function buildPlan(root: string, options: CliOptions): Promise<CleanupPlan> {
  const packageJson = await readManifest(root);
  const requested = options.targets.map(normalizeTarget);
  const requestedSet = new Set(requested);
  const automatic = requested.length === 0;
  const dependencies = dependencyNames(packageJson);
  const managers = await detectedManagers(root);
  const warnings: string[] = [];
  const tasks: CleanupTask[] = [];
  const reservedPaths = new Set<string>();

  let selectedManager: PackageManager | undefined;
  if (options.manager) selectedManager = options.manager;
  else if (requested.find((target): target is PackageManager => (packageManagers as readonly string[]).includes(target))) {
    selectedManager = requested.find((target): target is PackageManager => (packageManagers as readonly string[]).includes(target));
  } else if (managers.length === 1) selectedManager = managers[0];

  if (automatic && managers.length > 1 && !selectedManager) {
    warnings.push(`Multiple package-manager lockfiles found (${managers.join(", ")}). Select one before repairing dependencies.`);
  }

  const requestedManager = requested.find((target): target is PackageManager => (packageManagers as readonly string[]).includes(target));
  const shouldRepairDependencies = automatic || Boolean(requestedManager);
  if (selectedManager && shouldRepairDependencies) {
    const install = await managerInstall(root, selectedManager);
    const nodeModules = await createPath(root, "node_modules", "Local installed dependencies");
    tasks.push({
      id: `dependencies:${selectedManager}`,
      label: `Repair dependencies with ${selectedManager}`,
      kind: "dependency",
      target: selectedManager,
      paths: nodeModules ? [nodeModules] : [],
      description: nodeModules ? "Delete node_modules, then reinstall dependencies." : "Install dependencies (node_modules is already absent).",
      install
    });
    if (nodeModules) reservedPaths.add(nodeModules.relativePath);
  } else if (requestedManager) {
    warnings.push("A package manager target was requested but could not be selected.");
  }

  for (const definition of artifactCatalog) {
    const explicitlyRequested = requestedSet.has(definition.target);
    const detected = definition.packageNames.some((name) => dependencies.has(name));
    if (!explicitlyRequested && (!automatic || !detected)) continue;

    const relativePaths = definition.target === "typescript" ? await typescriptPaths(root) : definition.paths;
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
        description: definition.description
      });
    }
    if (explicitlyRequested && found === 0) warnings.push(`No existing safe ${definition.target} artifacts were found.`);
  }

  for (const input of options.include) {
    const relativePath = toSafeRelativePath(input);
    const item = await createPath(root, relativePath, "Explicitly included by --include");
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
      description: "Explicitly included by --include."
    });
  }

  const excluded = new Set(options.exclude.map(toSafeRelativePath));
  const filteredTasks = tasks.filter((task) => !task.paths.some((item) => excluded.has(item.relativePath)));
  if (excluded.size > 0) warnings.push(`Excluded ${excluded.size} explicitly named path${excluded.size === 1 ? "" : "s"}.`);
  if (filteredTasks.length === 0) warnings.push("No existing cleanup targets were found.");

  return { root, packageJson, tasks: filteredTasks, warnings, managerChoices: managers, selectedManager };
}

export function buildRebuildCommand(manager: PackageManager, packageJson: PackageJson): CommandSpec {
  if (!packageJson.scripts?.build) throw new SafetyError("--rebuild requires a package.json build script.");
  return { command: manager, args: ["run", "build"], label: `${manager} run build` };
}
