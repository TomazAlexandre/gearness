# Releasing

Releases are automated with release-please and published to npm with provenance.

1. Merge pull requests into `main` using Conventional Commit titles (`feat:`, `fix:`, `docs:`…).
2. release-please opens (and keeps updating) a release PR with the version bump and CHANGELOG.
3. Merging that PR tags the release, publishes `gearness` to npm and moves the floating major tag (`v0`) used by
   `uses: TomazAlexandre/gearness@v0` and `npx gearness@0`.

Requirements: the repository secret `NPM_TOKEN` (an npm automation token) and, under **Settings → Actions → General**,
"Allow GitHub Actions to create and approve pull requests".

Before merging a release PR, run locally:

```bash
npm ci && npm run typecheck && npm test
node dist/cli.js lint && node dist/cli.js doctor --ci
npm pack --dry-run   # check the files that will be published
```
