---
description: How to set up a local memrynote development environment and contribute changes.
---

# Contributing

Thanks for helping build memrynote. Keep changes small, focused, and easy to review.

## Setup

```bash
git clone https://github.com/memrynote/memry.git
cd memry
nvm use
pnpm install
pnpm dev
```

## Pick Work

- Check [open issues](https://github.com/memrynote/memry/issues)
- Comment before starting larger work
- Open an issue first when behavior or product direction is unclear

## Branch & Commit

Create a branch from `main`:

```bash
git checkout -b feat/your-feature main
```

Commit with Conventional Commits (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `test:`, `ci:`, `perf:`).

## Code Style

- TypeScript strict mode
- Small, direct changes
- Tests for new behavior and regressions
- Renderer ↔ main goes through `packages/contracts`
- User-facing renderer errors via `extractErrorMessage(err, fallback)` from `@/lib/ipc-error`
- Logging via `createLogger('Scope')` from electron-log — never `console.*`

## Pre-PR Checks

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm ipc:check     # if you touched the renderer/main boundary
```

## Deeper Reading

- [Repo Workflow](/contribute/workflow)
- [Testing](/contribute/testing)
- [Common Gotchas](/contribute/gotchas)

## Security Issues

Do not open public issues for vulnerabilities. Follow the [security policy](https://github.com/memrynote/memry/blob/main/SECURITY.md) and report privately.
