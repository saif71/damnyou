import type { FrameworkTarget } from "./types.js";

export interface ArtifactDefinition {
  target: FrameworkTarget;
  packageNames: string[];
  paths: string[];
  description: string;
}

export const artifactCatalog: ArtifactDefinition[] = [
  { target: "next", packageNames: ["next"], paths: [".next"], description: "Next.js build output and cache" },
  { target: "astro", packageNames: ["astro"], paths: [".astro", "dist"], description: "Astro generated files and default build output" },
  { target: "vite", packageNames: ["vite"], paths: ["node_modules/.vite", "dist"], description: "Vite dependency cache and default build output" },
  { target: "nuxt", packageNames: ["nuxt"], paths: [".nuxt", ".output", "dist"], description: "Nuxt generated files and output" },
  { target: "remix", packageNames: ["@remix-run/dev", "remix"], paths: ["build"], description: "Remix build output" },
  { target: "sveltekit", packageNames: ["@sveltejs/kit"], paths: [".svelte-kit", "build"], description: "SvelteKit generated files and adapter output" },
  { target: "storybook", packageNames: ["storybook", "@storybook/react", "@storybook/nextjs"], paths: ["storybook-static"], description: "Storybook static build output" },
  { target: "vitest", packageNames: ["vitest"], paths: ["node_modules/.vite", "coverage"], description: "Vitest/Vite cache and coverage output" },
  { target: "jest", packageNames: ["jest"], paths: ["coverage"], description: "Jest coverage output" },
  { target: "eslint", packageNames: ["eslint"], paths: [".eslintcache"], description: "ESLint file cache" },
  { target: "typescript", packageNames: ["typescript"], paths: [], description: "TypeScript incremental build info" }
];

export const targetAliases: Record<string, FrameworkTarget> = {
  nextjs: "next",
  svelte: "sveltekit",
  ts: "typescript"
};
