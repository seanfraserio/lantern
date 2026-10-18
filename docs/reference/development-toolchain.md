# Development toolchain

Use Node.js **20.19 or newer in the Node 20 line**, **22.13 or newer in the Node 22 line**, or a supported Node 24+ release for repository development. Vite 7 requires Node 20.19+/22.12+ and ESLint 10 requires Node 20.19+/22.13+. This development requirement does not change published packages' production `engines.node` declarations (`>=20.0.0`).

The test runner and V8 coverage plugin use matching Vitest 4.1.x versions (minimum 4.1.11). Vite stays on the compatible 7.x line; tsup stays on 8.x because tsup 9 requires Node 22.18+/24.11+. ESLint uses `eslint.config.mjs` (flat configuration), with the existing unused-variable error and explicit-any warning policy retained.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm typecheck
pnpm lint
pnpm test:dependency-contracts
pnpm pack:check
pnpm audit --prod --json
pnpm audit --json
```

Native `better-sqlite3` bindings must match the active Node ABI. After switching Node major versions, rebuild the native module with lifecycle scripts enabled and verify an actual in-memory database query. A successful install or a no-op rebuild alone does not establish native compatibility.

## Remaining security exceptions

- **Production, moderate:** Google Pub/Sub 5 uses OpenTelemetry Core 1.30.1, affected by GHSA-8988-4f7v-96qf. The published fix is Core 2.8+. Keep transport/header size limits, and validate untrusted messaging baggage before propagation. Do not override Pub/Sub's OpenTelemetry dependency across majors; a Pub/Sub 6 migration is separate work and would drop Node 20 support.
- **Development only, low:** esbuild 0.27.7 is affected by a Windows development-server path traversal advisory; the fix is 0.28.1+. tsup 8.5.1 requires `^0.27.0` (and its bundle-require peer graph also resolves that version). There is no patched release within that range. Do not expose affected esbuild development servers on Windows. Do not globally force a semver-incompatible esbuild minor or upgrade to Node-22-only tsup 9 merely to suppress the audit.

Both audit commands intentionally return a nonzero exit while these exceptions remain. Passing build/test/pack gates is not a claim of a vulnerability-free graph.
