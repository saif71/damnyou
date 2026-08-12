# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-08-12

### Added
- First public release of `damnyou`.
- Safe, previewed removal of regeneratable project artifacts for `npm`, `pnpm`, `yarn`, and `bun` (with lockfile-aware reinstall), plus `next`, `astro`, `vite`, `nuxt`, `remix`, `sveltekit`, `storybook`, `vitest`, `jest`, `eslint`, and `typescript`.
- Interactive task selection with a typed `yes` confirmation, plus `--dry-run`, `--yes`, `--json`, `--manager`, `--include`, `--exclude`, and `--rebuild` automation flags.
- Safety guarantees: no parent-folder or workspace traversal, no symlinked cleanup targets, root containment, and protected project metadata.

[Unreleased]: https://github.com/saif71/damnyou/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/saif71/damnyou/releases/tag/v0.1.0
