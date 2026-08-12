import { access, rm } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { assertNoSymlinkInPath } from "./safety.js";
import type { CleanupTask, CommandSpec } from "./types.js";

export async function commandExists(command: string): Promise<boolean> {
  const paths = process.env.PATH?.split(path.delimiter) ?? [];
  for (const directory of paths) {
    try {
      await access(path.join(directory, command), constants.X_OK);
      return true;
    } catch {
      // Keep looking.
    }
  }
  return false;
}

export async function deleteTasks(root: string, tasks: CleanupTask[]): Promise<string[]> {
  const deleted: string[] = [];
  const seen = new Set<string>();
  for (const task of tasks) {
    for (const item of task.paths) {
      if (seen.has(item.absolutePath)) continue;
      seen.add(item.absolutePath);
      await assertNoSymlinkInPath(root, item.absolutePath);
      await rm(item.absolutePath, { recursive: true, force: false, maxRetries: 3, retryDelay: 150 });
      deleted.push(item.relativePath);
    }
  }
  return deleted;
}

export async function runCommand(spec: CommandSpec, cwd: string, json = false): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(spec.command, spec.args, { cwd, stdio: json ? ["ignore", "pipe", "pipe"] : "inherit" });
    if (json) {
      child.stdout?.pipe(process.stderr);
      child.stderr?.pipe(process.stderr);
    }
    child.once("error", (error) => reject(error));
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${spec.label} failed${signal ? ` (${signal})` : ` with exit code ${code ?? "unknown"}`}.`));
    });
  });
}
