# damnyou

`damnyou` safely previews, deletes, and optionally regenerates known JavaScript project artifacts from the current folder.

It previews only regeneratable project artifacts, lets you opt in or out of every task, asks for a final confirmation, then removes the selected paths and can reinstall dependencies.

```sh
npm install --global damnyou

damnyou npm
damnyou next
damnyou npm next --rebuild
```

## Usage

Run the command from the folder that contains the project's `package.json`.

| Command                              | What it does                                                                                                                        |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `damnyou`                            | Detects applicable safe cleanup tasks and lets you choose what to run. Prompts for a package manager when lockfiles conflict.       |
| `damnyou npm`                        | Removes local `node_modules`, then runs a lockfile-aware npm install. Replace `npm` with `pnpm`, `yarn`, or `bun` for that manager. |
| `damnyou next`                       | Cleans artifacts owned by Next.js. Replace `next` with any supported framework or tool. `nextjs` is also accepted.                  |
| `damnyou npm next`                   | Combines dependency repair with one or more framework/tool cleanup targets.                                                         |
| `damnyou next --rebuild`             | Cleans the selected targets, then runs the selected manager's `run build` script.                                                   |
| `damnyou --include generated-client` | Adds an exact project-relative file or directory to the cleanup plan. Repeat `--include` for more paths.                            |
| `damnyou astro --exclude dist`       | Excludes an exact detected path. Repeat `--exclude` for more paths.                                                                 |
| `damnyou --manager pnpm`             | Selects a manager explicitly, useful when several lockfiles exist or when using `--rebuild`.                                        |
| `damnyou --dry-run`                  | Shows the cleanup plan and commands without changing files.                                                                         |
| `damnyou npm --yes`                  | Accepts the default selections and confirmation; required for non-interactive cleanup.                                              |
| `damnyou --json`                     | Emits a structured plan/result to stdout; combine with `--yes` to execute.                                                          |
| `damnyou --help`                     | Shows the built-in command reference.                                                                                               |
| `damnyou --version`                  | Prints the installed version.                                                                                                       |

## Platform support

`damnyou` runs on macOS and Linux. Windows is not supported yet: package managers are installed there as `.cmd` shims, which the current command lookup and process spawning do not handle. It is tracked for a future release.

## Supported frameworks and tools

- Frameworks: Next.js (`next` or `nextjs`), Astro, Vite, Nuxt, Remix, SvelteKit, and Storybook.
- Tooling: Vitest, Jest, ESLint, and TypeScript.
- Package managers: npm, pnpm, Yarn, and Bun.

## What it cleans

Run it only from the project folder—the folder containing `package.json`.

- `npm`, `pnpm`, `yarn`, and `bun`: local `node_modules`, followed by a lockfile-aware reinstall.
- `next`/`nextjs`: `.next`
- `astro`: `.astro`, default `dist`
- `vite`: `node_modules/.vite`, default `dist`
- `nuxt`, `remix`, `sveltekit`, `storybook`, `vitest`, `jest`, `eslint`, and `typescript`: their known local generated outputs when present.

Bare `damnyou` automatically proposes every detected safe task. If it sees multiple package-manager lockfiles, it asks you which manager to use rather than guessing.

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

When its compatible lockfile exists, a dependency repair uses a reproducible install:

| Target | With lockfile                    | Without lockfile |
| ------ | -------------------------------- | ---------------- |
| `npm`  | `npm ci`                         | `npm install`    |
| `pnpm` | `pnpm install --frozen-lockfile` | `pnpm install`   |
| `yarn` | `yarn install --frozen-lockfile` | `yarn install`   |
| `bun`  | `bun install --frozen-lockfile`  | `bun install`    |

Cleaning does not build by default. Add `--rebuild` to run the selected package manager’s `run build` after cleanup; this requires a `build` script in `package.json`.

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

Requires Node.js 20 or newer.

```sh
npm install
npm run check
npm pack
```

## License

[MIT](LICENSE)
