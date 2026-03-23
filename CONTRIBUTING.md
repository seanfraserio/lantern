# Contributing to Lantern

Thank you for your interest in contributing to Lantern! This guide will help you get started.

## Development Setup

### Prerequisites

- Node.js 20+
- pnpm 9+
- Git

### Getting Started

```bash
git clone https://github.com/your-org/lantern.git
cd lantern
pnpm install
pnpm build
pnpm test
```

### Run the Demo

```bash
pnpm demo
```

This starts the ingest server, seeds it with sample traces, and opens the dashboard at `http://localhost:4100`.

### Monorepo Structure

| Package | Path | Description |
|---|---|---|
| `@openlantern-ai/sdk` | `packages/sdk` | Core tracing SDK — tracer, spans, collectors, exporters |
| `@openlantern-ai/ingest` | `packages/ingest` | Fastify HTTP server for trace ingestion and storage |
| `@openlantern-ai/evaluator` | `packages/evaluator` | Quality scoring framework with built-in scorers |
| `@openlantern-ai/dashboard` | `packages/dashboard` | React web UI components |
| `@openlantern-ai/enterprise` | `packages/enterprise` | Enterprise features (BUSL-1.1 licensed) |

## Making Changes

### Before You Start

1. Check existing [issues](https://github.com/your-org/lantern/issues) to avoid duplicate work.
2. For significant changes, open an issue first to discuss the approach.
3. Fork the repository and create a feature branch from `main`.

### Where to Put Things

- **New auto-instrumentation collectors** go in `packages/sdk/src/collectors/<provider>.ts` and are re-exported from `packages/sdk/src/index.ts`.
- **New evaluation scorers** go in `packages/evaluator/src/scorers/<name>.ts` and are re-exported from `packages/evaluator/src/index.ts`.
- **New exporters** go in `packages/sdk/src/exporters/<name>.ts`.
- **Dashboard components** go in `packages/dashboard/src/components/`.
- **Shared types** belong in `packages/sdk/src/types.ts`.
- **Tests** are co-located as `*.test.ts` next to the file they test.

### Adding a Custom Scorer

1. Create `packages/evaluator/src/scorers/<name>.ts`
2. Implement the `Scorer` interface from `@openlantern-ai/sdk`
3. Export it from `packages/evaluator/src/index.ts`
4. Add a test file `packages/evaluator/src/scorers/<name>.test.ts`

```typescript
import type { Scorer, EvalScore, Trace } from "@openlantern-ai/sdk";

export class MyScorer implements Scorer {
  name = "my-scorer";

  async score(trace: Trace): Promise<EvalScore> {
    // Your scoring logic
    return { scorer: this.name, score: 0.95, label: "good" };
  }
}
```

### Adding an Auto-Instrumentation Collector

1. Create `packages/sdk/src/collectors/<provider>.ts`
2. Export a `wrap<Provider>Client()` function that intercepts API calls
3. Create spans automatically for each intercepted call
4. Export from `packages/sdk/src/index.ts`

### Code Style

- TypeScript strict mode — no `any` shortcuts.
- ESLint and Prettier are configured. Run `pnpm lint` to check.
- Keep functions small and focused. Prefer clarity over cleverness.

### Before Submitting

Run the full check suite:

```bash
pnpm build && pnpm test && pnpm typecheck
```

All three must pass before submitting a PR.

### Commit Messages

Use clear, descriptive commit messages:

- `feat: add openai auto-instrumentation collector`
- `fix: handle missing token counts in span`
- `docs: add custom scorer example`
- `test: add latency scorer edge cases`

### Pull Requests

1. Keep PRs focused — one feature or fix per PR.
2. Include a clear description of what changed and why.
3. Add tests for new functionality.
4. Update documentation if the public API changes.
5. Ensure CI passes before requesting review.

## OSS vs Enterprise Boundary

The open-source core (MIT) covers the full trace capture pipeline: SDK instrumentation, ingest server, storage, dashboard, and evaluation. Enterprise features (BUSL-1.1) add compliance, security, and team management capabilities.

**Enterprise features** (`packages/enterprise/`) are licensed under BUSL-1.1. If you're unsure whether a contribution belongs in OSS or enterprise, open an issue to discuss.

Contributions to enterprise features are welcome but will be licensed under BUSL-1.1.

## Reporting Issues

- Use GitHub Issues for bug reports and feature requests.
- Include reproduction steps, expected behavior, and actual behavior.
- For security vulnerabilities, please email security@lantern-ai.dev instead of opening a public issue.

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you agree to uphold this standard.

## License

By contributing to Lantern, you agree that your contributions will be licensed under the MIT License (for core packages) or BUSL-1.1 (for enterprise packages), matching the license of the package you're contributing to.
