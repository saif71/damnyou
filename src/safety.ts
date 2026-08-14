import { access, lstat, readdir, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

export class SafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafetyError";
  }
}

export function toSafeRelativePath(input: string): string {
  if (!input || path.isAbsolute(input)) {
    throw new SafetyError(
      "Only non-empty, project-relative paths are allowed.",
    );
  }
  const normalized = path.normalize(input);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith(`..${path.sep}`)
  ) {
    throw new SafetyError(`Path must stay inside the project: ${input}`);
  }
  return normalized;
}

export function resolveInsideRoot(root: string, relativePath: string): string {
  const safeRelative = toSafeRelativePath(relativePath);
  const candidate = path.resolve(root, safeRelative);
  const relativeToRoot = path.relative(root, candidate);
  if (
    !relativeToRoot ||
    relativeToRoot === ".." ||
    relativeToRoot.startsWith(`..${path.sep}`)
  ) {
    throw new SafetyError(
      `Refusing to use a path outside the project: ${relativePath}`,
    );
  }
  return candidate;
}

export async function assertNoSymlinkInPath(
  root: string,
  absolutePath: string,
): Promise<void> {
  const rel = path.relative(root, absolutePath);
  let current = root;
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) {
      throw new SafetyError(`Refusing symlinked cleanup target: ${rel}`);
    }
  }
}

export async function ensureProjectRoot(cwd: string): Promise<string> {
  const root = await realpath(cwd);
  const manifest = path.join(root, "package.json");
  try {
    await access(manifest, constants.R_OK);
  } catch {
    throw new SafetyError(
      "damnyou must run in a folder that contains package.json.",
    );
  }
  return root;
}

// Sizes are informational; saturate at this cap so huge trees (e.g.
// node_modules in large monorepos) do not stall the plan preview.
export const SIZE_CAP_BYTES = 512 * 1024 * 1024;

export async function pathSize(
  absolutePath: string,
  remaining: number = SIZE_CAP_BYTES,
): Promise<number> {
  if (remaining <= 0) return 0;
  const stat = await lstat(absolutePath);
  // Package-manager trees routinely contain internal bin/workspace symlinks.
  // Do not traverse them while measuring a directory: they are removed as links
  // by fs.rm, never followed. The cleanup target and its ancestors are checked
  // separately by assertNoSymlinkInPath.
  if (stat.isSymbolicLink()) return 0;
  if (!stat.isDirectory()) return Math.min(stat.size, remaining);

  let total = Math.min(stat.size, remaining);
  // Recurse in parallel: stat calls run on the libuv thread pool, which is far
  // faster than the previous sequential walk on large dependency trees.
  const entries = await readdir(absolutePath, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) =>
      pathSize(path.join(absolutePath, entry.name), remaining - total),
    ),
  );
  for (const size of nested) total += size;
  return Math.min(total, remaining);
}

export function formatBytes(bytes: number): string {
  if (bytes >= SIZE_CAP_BYTES) return "512 MB+";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}
