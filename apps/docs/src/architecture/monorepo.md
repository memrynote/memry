# Monorepo Layout

Memry is a pnpm + Turborepo monorepo.

## Apps

| Path               | Purpose                                             |
| ------------------ | --------------------------------------------------- |
| `apps/desktop`     | Electron + React + Vite. Main / renderer / preload. |
| `apps/sync-server` | Cloudflare Workers + Hono. D1 + R2.                 |
| `apps/docs`        | This documentation site (VitePress).                |

## Packages

| Path                 | Purpose                                               |
| -------------------- | ----------------------------------------------------- |
| `packages/contracts` | Shared IPC and API contract definitions (Zod).        |
| `packages/db-schema` | Drizzle ORM schemas for the data and index databases. |
| `packages/shared`    | Minimal shared utilities.                             |

## Tooling

- **Package manager**: pnpm 10.30+
- **Task runner**: Turborepo
- **Node**: pinned via `.nvmrc`

## Cross-Cutting Scripts

```bash
pnpm dev          # desktop dev
pnpm test         # vitest across packages
pnpm lint         # ESLint flat config
pnpm typecheck    # TypeScript across packages
pnpm ipc:check    # validate IPC contract types
```
