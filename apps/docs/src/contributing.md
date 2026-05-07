# Contributing

Thanks for helping build Memry. Keep changes small, focused, and easy to review.

## Start

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
- Open an issue first when the behavior or product direction is unclear

## Branches

Create a branch from `main` with a name that describes the work.

```bash
git checkout -b feat/your-feature main
```

## Code Style

- TypeScript strict mode
- Small, direct changes
- Tests for new behavior and regressions
- Renderer and main process boundaries through shared contracts
- User-facing renderer errors through the existing IPC error helpers

## Checks

Run the checks that match your change before opening a pull request.

```bash
pnpm lint
pnpm typecheck
pnpm test
```

Run the IPC contract check after editing renderer/main boundary types.

```bash
pnpm ipc:check
```

## Security Issues

Do not open public issues for vulnerabilities. Follow the
[security policy](https://github.com/memrynote/memry/blob/main/SECURITY.md) and report
privately.
