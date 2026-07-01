# Build from source

Run MemryNote locally, hack on it, or contribute.

## Prerequisites

- **Node 24** (see [`.nvmrc`](../.nvmrc))
- **pnpm 11** — the repo pins `pnpm@11.5.2` via `packageManager`; corepack picks the right version automatically
- **Git**

## Run the desktop app

```bash
git clone https://github.com/memrynote/memry.git
cd memry
pnpm install
pnpm dev
```

The Electron app launches with hot reload.

## Other surfaces

```bash
pnpm dev:landing      # landing site
pnpm dev:sync-server  # sync server (Cloudflare Workers)
pnpm docs:dev         # docs site
```

## Verify before you push

```bash
pnpm lint         # ESLint
pnpm typecheck    # TypeScript, all packages
pnpm test         # Vitest
pnpm test:e2e     # Playwright (Electron)
```

## Monorepo layout

| Package              | Description                    |
| -------------------- | ------------------------------ |
| `apps/desktop`       | Electron 39 + React 19 + Vite  |
| `apps/sync-server`   | Cloudflare Workers sync server |
| `apps/landing`       | Landing site                   |
| `apps/docs`          | VitePress docs                 |
| `packages/contracts` | IPC + API contracts (Zod)      |
| `packages/db-schema` | Drizzle ORM schema             |
| `packages/shared`    | Shared utilities               |

## Contributing

Workflow, commit conventions, and PR expectations live in [CONTRIBUTING.md](./CONTRIBUTING.md).
Deeper architecture notes are in [ARCHITECTURE.md](./ARCHITECTURE.md) and [CLAUDE.md](../CLAUDE.md).
