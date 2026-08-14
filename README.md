# damnyou

## Safely rebuild your project dependencies with one command when you are angry.

<figure>
  <img src="https://raw.githubusercontent.com/saif71/damnyou/main/image.png">
  <figcaption>Season 2, Episode 7 ("The Hack") | Netflix comedy series "Space Force"</figcaption>
</figure>

It safely previews, deletes, and optionally regenerates known JavaScript project artifacts from the current folder.

It previews only regeneratable project artifacts, lets you opt in or out of every task, asks for a final confirmation, then removes the selected paths, reinstalls dependencies, and runs the build script when one is defined.

<br />

## Running with `npm` or `bun`

```sh
npx damnyou
```

or

```sh
bunx @saif71/damnyou
```

## Usage

Run the command from the folder that contains the project's `package.json`.

```sh
damnyou <framework> --<option>
```

---

> Prefix `npx` or `bunx` to run the command when it is not globally installed. Example: `npx damnyou npm next`

| Command                              | What it does                                                                                                                       |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `damnyou`                            | Detects applicable safe cleanup tasks and lets you choose what to run. Prompts for a package manager when lockfiles conflict.      |
| `damnyou npm`                        | Repairs dependencies with npm specifically. Replace `npm` with `pnpm`, `yarn`, or `bun` to force that manager.                     |
| `damnyou next`                       | Cleans Next.js artifacts and repairs dependencies. Replace `next` with any supported framework or tool; `nextjs` is also accepted. |
| `damnyou npm next`                   | Same as `damnyou next`, naming the manager explicitly (optional).                                                                  |
| `damnyou next --rebuild`             | Runs the build script even when no reinstall happens.                                                                              |
| `damnyou npm --no-build`             | Reinstalls dependencies but skips the automatic build.                                                                             |
| `damnyou --include generated-client` | Adds an exact project-relative file or directory to the cleanup plan. Repeat `--include` for more paths.                           |
| `damnyou astro --exclude dist`       | Excludes an exact detected path. Repeat `--exclude` for more paths.                                                                |
| `damnyou --manager pnpm`             | Selects a manager explicitly, useful when several lockfiles exist or when using `--rebuild`.                                       |
| `damnyou --dry-run`                  | Shows the cleanup plan and commands without changing files.                                                                        |
| `damnyou npm --yes`                  | Accepts the default selections and confirmation; required for non-interactive cleanup.                                             |
| `damnyou --json`                     | Emits a structured plan/result to stdout; combine with `--yes` to execute.                                                         |
| `damnyou --help`                     | Shows the built-in command reference.                                                                                              |
| `damnyou --version`                  | Prints the installed version.                                                                                                      |

## Platform support

`damnyou` runs on macOS and Linux. Windows is not supported yet.

## Supported frameworks and tools

- Frameworks: Next.js, Astro, Vite, Nuxt, Remix, SvelteKit, and Storybook.
- Tooling: Vitest, Jest, ESLint, and TypeScript.
- Package managers: npm, pnpm, Yarn, and Bun.

## What it cleans & rebuild

Run it only from the project folder—the folder containing `package.json`.

- `npm`, `pnpm`, `yarn`, and `bun`: local `node_modules`, followed by a lockfile-aware reinstall.
- `next`/`nextjs`: `.next`
- `astro`: `.astro`, default `dist`
- `vite`: `node_modules/.vite`, default `dist`
- `nuxt`, `remix`, `sveltekit`, `storybook`, `vitest`, `jest`, `eslint`, and `typescript`: their known local generated outputs when present.

Every invocation repairs dependencies: `node_modules` is deleted and reinstalled, and the build script runs afterward when one is defined (`--no-build` skips it). Targets only scope which extra framework artifacts are cleaned; bare `damnyou` proposes every detected safe task. The package manager is detected in this order: an explicit `--manager` flag, a manager target such as `damnyou bun`, the `packageManager` field in `package.json`, a single detected lockfile, and finally npm when no lockfile exists. If several lockfiles are found and none of the above resolves the choice, it asks you which manager to use rather than guessing.

## Safety model

Before changing anything, the CLI shows the project root, each candidate path, its reason, its approximate size, and commands to run afterward. You can toggle individual tasks, select all, select none, or cancel. The final confirmation requires typing `yes`.

- It never searches parent folders or descends into workspaces.
- It rejects paths outside the project, the project root itself, and symlinked cleanup targets.
- It permanently deletes selected files; it does not use Trash.
- It does not send telemetry.
- It intentionally does **not** delete arbitrary root `build`, `dist`, or `cache` folders. Known framework defaults are the exception.

For a project-specific generated directory, opt in explicitly:

```sh
damnyou --include generated-client
damnyou astro --exclude dist
```

`--include` and `--exclude` accept exact project-relative paths and may be repeated.

## Reinstall and rebuild behavior

When its compatible lockfile exists, a dependency repair first tries a reproducible install:

| Target | With lockfile                    | Without lockfile |
| ------ | -------------------------------- | ---------------- |
| `npm`  | `npm ci`                         | `npm install`    |
| `pnpm` | `pnpm install --frozen-lockfile` | `pnpm install`   |
| `yarn` | `yarn install --frozen-lockfile` | `yarn install`   |
| `bun`  | `bun install --frozen-lockfile`  | `bun install`    |

Reproducible installs fail when `package.json` and the lockfile have drifted apart — one of the most common ways dependencies break. When that happens, damnyou automatically retries with a plain `install`, so you are never left with a deleted `node_modules` and nothing installed.

If `package.json` defines a `build` script, it runs automatically after a reinstall. Use `--no-build` to skip it, or `--rebuild` to force a build even when no reinstall happens. `--rebuild` requires a `build` script.

## Automation

```sh
# Preview only
damnyou --dry-run

# Non-interactive deletion with the default selected tasks
damnyou npm --yes

# Resolve lockfile ambiguity in CI
damnyou --manager pnpm --yes --json
```

In a non-interactive terminal, `damnyou` previews and exits unless `--yes` is supplied. `--json` writes a structured plan/result to stdout and routes package-manager output to stderr.

## Development

Requires Node.js 22 or newer.

```sh
npm install
npm run check
npm pack
```

## License

[MIT](LICENSE)
