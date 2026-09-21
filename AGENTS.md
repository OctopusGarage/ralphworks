# Agent instructions

- Keep maintained documentation and comments in English.
- Read `README.md` and `docs/ARCHITECTURE.md` before changing behavior.
- Keep the CLI, loop, adapters, and result readers as focused modules; avoid adding infrastructure for unused execution modes.
- Put temporary research and plans outside the repository. Do not commit generated `.ralph/` state.
- Run `pnpm verify:local` before pushing. Update tests and `docs/USAGE.md` when behavior or commands change.
