# Contributing

Thanks for helping make `damnyou` safer and more useful.

- Keep cleanup candidates conservative: they must be clearly regeneratable and project-local.
- Preserve the no-parent-search, no-workspace-traversal, and no-symlink-deletion guarantees.
- Add tests for every new cleaner, including a negative safety case.
- Run `npm run check` before opening a pull request.

Please discuss broad new cleaner categories in an issue before implementing them.
