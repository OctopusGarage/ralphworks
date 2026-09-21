# Release guide

RalphWorks uses GitHub Releases for its CLI archive. It does not publish to npm. The Git tag, `package.json` version, release title, notes file, and archive name must describe the same version.

## Version and title

- Use a three-part version without a leading zero in any part: `X.Y.Z`. The Git tag is `vX.Y.Z`; the release title is `RalphWorks vX.Y.Z`.
- Follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). For future releases below `1.0.0`, use a minor increment for new user-visible capabilities or incompatible changes and a patch increment for compatible fixes. Document any required upgrade action in the notes.
- Never move a published version tag. Correct release text or assets in place when needed; publish code changes under a new version.

## Notes

Write `docs/releases/vX.Y.Z.md` in the release PR by copying [the template](../.github/RELEASE_TEMPLATE.md). The file is the source for the GitHub Release body. Keep it short and factual:

1. Open with the user-visible outcome, then list material highlights.
2. Include upgrade notes only when users must act or behavior changes incompatibly.
3. Give the exact archive install command and link to the previous tag comparison. For the first release, link to its tag instead.
4. State the verification run for the tagged commit. Do not claim a test or deployment that was not run.

Avoid commit-message dumps, empty headings, placeholders, and claims based only on passing tests. The archive is the installable artifact; GitHub's automatic source archives are source snapshots.

## Publish

1. Bump `package.json`, add the matching notes file, and update installation links and default workflow refs in the same PR. Run `pnpm verify:local` and merge after CI passes.
2. Create and push an annotated `vX.Y.Z` tag on that merged commit.
3. The [Release workflow](../.github/workflows/release.yml) verifies the package, requires the matching notes file, and publishes `ralphworks-X.Y.Z.tgz` with the standard title. A workflow rerun updates the same release and replaces its archive.
4. Confirm the release title, notes, archive version, and download URL on GitHub.

The [v0.1.1 notes](releases/v0.1.1.md) describe the current baseline release.
