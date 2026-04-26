# Contributing to Memry

Thanks for your interest in contributing to Memry! This guide will help you get started.

## Code of Conduct

Be respectful and constructive. We're building something together.

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v24.x; use `.nvmrc`)
- [pnpm](https://pnpm.io/) (v10.30+)
- [Rust](https://www.rust-lang.org/tools/install) (1.95+ for the Tauri app)
- Git

### Setup

```bash
git clone https://github.com/memrynote/memry.git
cd memry
pnpm install
pnpm dev
```

### Project Structure

Memry is a pnpm monorepo:

| Package | Description |
| --- | --- |
| `apps/desktop` | Electron + React desktop app (frozen during the Tauri migration) |
| `apps/desktop-tauri` | Tauri + React migration desktop app |
| `apps/sync-server` | Cloudflare Workers sync server |
| `packages/contracts` | Shared TypeScript contracts |
| `packages/db-schema` | Drizzle ORM schema definitions |
| `packages/shared` | Shared utilities |

## Development Workflow

### 1. Pick an Issue

- Check [open issues](https://github.com/memrynote/memry/issues) for something that interests you
- Comment on the issue to let others know you're working on it
- For larger changes, open an issue first to discuss the approach

### 2. Branch

Create a feature branch from `main`:

```bash
git checkout -b feat/your-feature main
```

### 3. Code

- **TypeScript strict mode** — no `any`, no implicit types
- **Immutability** — create new objects, never mutate
- **Small files** — aim for 200–400 lines, 800 max
- **Error handling** — handle errors explicitly, never swallow them

### 4. Test

We follow test-driven development:

```bash
pnpm test              # run all tests
pnpm test:desktop      # desktop tests only
pnpm test:sync-server  # sync server tests only
pnpm test:e2e          # end-to-end tests
pnpm --filter @memry/desktop-tauri cargo:test
pnpm --filter @memry/desktop-tauri bindings:check
```

- Write tests first, then implementation
- Aim for 80%+ coverage
- Include unit, integration, and e2e tests where appropriate

### 5. Lint & Typecheck

```bash
pnpm lint
pnpm typecheck
```

Both must pass before submitting a PR.

### 6. Commit

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add graph view clustering
fix: prevent stale sync on reconnect
refactor: extract field-merge utility
docs: update contributing guide
test: add CRDT conflict resolution tests
chore: bump dependencies
perf: optimize vector clock comparison
ci: add typecheck to PR workflow
```

Keep commits atomic — one logical change per commit.

### 7. Pull Request

- Push your branch and open a PR against `main`
- Fill in the PR template
- Link related issues
- Ensure CI passes (tests, lint, typecheck)
- Request a review

## What We Look For in PRs

- **Does it solve the stated problem?**
- **Are there tests?** New features need tests. Bug fixes need regression tests.
- **Is the code clear?** Self-documenting names over comments.
- **Is it minimal?** Only changes necessary for the task.

## Reporting Bugs

Open a [GitHub issue](https://github.com/memrynote/memry/issues/new) with:

- Steps to reproduce
- Expected vs actual behavior
- OS, Electron version, app version
- Screenshots or logs if applicable

## Security Issues

**Do not open public issues for security vulnerabilities.** See [SECURITY.md](../SECURITY.md) for responsible disclosure instructions.

## License

By contributing, you agree that your contributions will be licensed under the [GNU General Public License v3.0](../LICENSE).
