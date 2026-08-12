export const packageManagers = ["npm", "pnpm", "yarn", "bun"] as const;
export type PackageManager = (typeof packageManagers)[number];

export const frameworkTargets = [
  "next",
  "astro",
  "vite",
  "nuxt",
  "remix",
  "sveltekit",
  "storybook",
  "vitest",
  "jest",
  "eslint",
  "typescript"
] as const;
export type FrameworkTarget = (typeof frameworkTargets)[number];
export type Target = PackageManager | FrameworkTarget;

export interface CommandSpec {
  command: string;
  args: string[];
  label: string;
}

export interface CleanupPath {
  relativePath: string;
  absolutePath: string;
  type: "directory" | "file";
  bytes: number;
  reason: string;
}

export interface CleanupTask {
  id: string;
  label: string;
  kind: "dependency" | "artifact" | "custom";
  target: Target | "custom";
  paths: CleanupPath[];
  description: string;
  install?: CommandSpec;
}

export interface CleanupPlan {
  root: string;
  packageJson: PackageJson;
  tasks: CleanupTask[];
  warnings: string[];
  managerChoices: PackageManager[];
  selectedManager?: PackageManager;
}

export interface PackageJson {
  name?: string;
  packageManager?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

export interface CliOptions {
  targets: string[];
  include: string[];
  exclude: string[];
  dryRun: boolean;
  yes: boolean;
  json: boolean;
  rebuild: boolean;
  manager?: PackageManager;
}
