import { rm, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { assertNoSymlinkInPath } from "./safety.js";
import type { CleanupPath, CleanupTask, CommandSpec } from "./types.js";

export async function commandExists(command: string): Promise<boolean> {
  const paths = process.env.PATH?.split(path.delimiter) ?? [];
  for (const directory of paths) {
    if (!directory) continue;
    try {
      const info = await stat(path.join(directory, command));
      if (info.isFile()) return true;
    } catch {
      // Keep looking.
    }
  }
  return false;
}

export async function deleteTasks(
  root: string,
  tasks: CleanupTask[],
  onStart?: (item: CleanupPath) => void,
): Promise<string[]> {
  const deleted: string[] = [];
  const seen = new Set<string>();
  for (const task of tasks) {
    for (const item of task.paths) {
      if (seen.has(item.absolutePath)) continue;
      seen.add(item.absolutePath);
      onStart?.(item);
      try {
        await assertNoSymlinkInPath(root, item.absolutePath);
      } catch (error) {
        // A path that vanished after planning is already gone; skip it
        // instead of aborting the remaining deletions.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      // force ignores ENOENT so a path removed concurrently is not an error.
      await rm(item.absolutePath, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 150,
      });
      deleted.push(item.relativePath);
    }
  }
  return deleted;
}

export async function runCommand(
  spec: CommandSpec,
  cwd: string,
  json = false,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      cwd,
      stdio: json ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    if (json) {
      child.stdout?.pipe(process.stderr);
      child.stderr?.pipe(process.stderr);
    }
    child.once("error", (error) => reject(error));
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `${spec.label} failed${signal ? ` (${signal})` : ` with exit code ${code ?? "unknown"}`}.`,
          ),
        );
    });
  });
}
