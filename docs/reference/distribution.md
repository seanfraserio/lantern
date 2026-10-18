# Distribution checks

Run these commands from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
node --test scripts/artifact-contract.test.mjs
node scripts/pack-artifacts.mjs
```

The artifact check uses `pnpm pack` for the SDK, ingest service, proxy, evaluator,
and integration packages. It verifies their declared JavaScript, declaration,
and executable entry points against the actual tarball contents. Runtime
`workspace:`, `file:`, and `link:` dependencies are rejected. Build-only workspace
helpers are bundled into ingest/proxy artifacts; they do not require publishing
the private `@freelancer/shared-utils` package.

The check then installs the four core tarballs in a temporary consumer project.
It typechecks real imports and runs both CommonJS and ESM imports without
starting a server, opening a database, or calling an AI provider. Consumer install
scripts are disabled. This does not validate native SQLite initialization; that
is covered separately by ingest tests with the native dependency installed.

Package versions are included at build time from each package manifest, so
bundled exporters and both module formats use the same package version without
runtime source-relative manifest lookups.

Temporary consumer files are removed on success or failure. Set `TMPDIR` when a
particular temporary workspace is required. No package is published by this check.
The private ingest package is packed for deployment validation only; its private
status is unchanged.
