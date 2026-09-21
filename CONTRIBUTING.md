# Contributing

RalphWorks is a small TypeScript CLI. Keep changes focused on the loop, execution adapters, or the delivery workflow. The [architecture guide](docs/ARCHITECTURE.md) describes the current modules.

## Local setup

```bash
pnpm install --frozen-lockfile
pnpm verify:local
```

Use Node.js 24 and pnpm 10. `verify:local` runs formatting and lint checks, TypeScript, tests with coverage thresholds, unused-code checks, build, package validation, and a high-severity dependency audit. The pre-push hook runs the same gate after `pnpm install` installs Husky.

Keep user-facing commands and examples in [README.md](README.md) and [docs/USAGE.md](docs/USAGE.md) in sync. Add tests for behavior changes. Use a dedicated branch or worktree for changes, and use conventional commit subjects such as `fix:`, `feat:`, and `docs:`.

Before submitting a pull request, run `pnpm verify:local` and describe the behavior changed, verification performed, and any limits. GitHub CI repeats the gate on Ubuntu and macOS. `main` requires a pull request with passing `verify`, `scan`, and `infrastructure` checks; no approval is required for this single-maintainer repository.

The [Smoke workflow](.github/workflows/smoke.yml) runs the real host and Docker paths for every pull request and weekly with a dry-run agent. It is required alongside `verify` and `scan`. For model-backed changes, follow the [repeatable smoke checks](docs/USAGE.md#repeatable-smoke-checks) on a temporary repository and record which modes passed. The remote smoke script uses a temporary branch in a configured target repository and removes it after the run.

## Releases

After CI passes on `main`, bump `package.json` and create a matching `vX.Y.Z` tag. Push the commit and tag. The [Release workflow](.github/workflows/release.yml) reruns verification, checks the tag against the package version, and attaches a packed CLI artifact to the GitHub Release. npm publishing is not configured.
