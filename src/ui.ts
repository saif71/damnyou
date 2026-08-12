import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { formatBytes } from "./safety.js";
import type { CleanupPlan, CleanupTask, PackageManager } from "./types.js";

export function renderPlan(plan: CleanupPlan, selected: Set<string>, commands: string[] = []): string {
  const lines = [
    "\n⚠ damnyou permanently deletes only the selected project-local paths.",
    `Project: ${plan.root}`,
    ""
  ];
  for (const [index, task] of plan.tasks.entries()) {
    const marker = selected.has(task.id) ? "x" : " ";
    const paths = task.paths.length === 0 ? "(nothing to delete)" : task.paths.map((item) => `${item.relativePath} (${formatBytes(item.bytes)})`).join(", ");
    lines.push(`[${marker}] ${index + 1}. ${task.label}`);
    lines.push(`    ${paths}`);
    lines.push(`    ${task.description}`);
  }
  if (plan.warnings.length) {
    lines.push("", "Warnings:");
    lines.push(...plan.warnings.map((warning) => `  - ${warning}`));
  }
  if (commands.length) {
    lines.push("", "Commands after cleanup:", ...commands.map((command) => `  - ${command}`));
  }
  return lines.join("\n");
}

export async function chooseManager(choices: PackageManager[]): Promise<PackageManager | undefined> {
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(`Multiple lockfiles found. Select package manager [${choices.join("/")}], or press Enter to cancel: `);
    const selected = choices.find((choice) => choice === answer.trim().toLowerCase());
    return selected;
  } finally {
    rl.close();
  }
}

export async function chooseTasks(plan: CleanupPlan): Promise<Set<string> | undefined> {
  const selected = new Set(plan.tasks.map((task) => task.id));
  const rl = createInterface({ input, output });
  try {
    while (true) {
      output.write(`${renderPlan(plan, selected)}\n`);
      const answer = (await rl.question("Toggle item numbers (e.g. 1,3), [a]ll, [n]one, Enter to continue, [q]uit: ")).trim().toLowerCase();
      if (!answer) return selected;
      if (answer === "q") return undefined;
      if (answer === "a") {
        for (const task of plan.tasks) selected.add(task.id);
        continue;
      }
      if (answer === "n") {
        selected.clear();
        continue;
      }
      const indices = answer.split(",").map((part) => Number(part.trim()));
      if (indices.some((index) => !Number.isInteger(index) || index < 1 || index > plan.tasks.length)) {
        output.write("Enter valid comma-separated task numbers, a, n, q, or Enter.\n");
        continue;
      }
      for (const index of indices) {
        const task = plan.tasks[index - 1] as CleanupTask;
        if (selected.has(task.id)) selected.delete(task.id);
        else selected.add(task.id);
      }
    }
  } finally {
    rl.close();
  }
}

export async function confirm(): Promise<boolean> {
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question("Type yes to permanently clean the selected paths: ");
    return answer.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}
