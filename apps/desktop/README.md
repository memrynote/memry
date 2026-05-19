# Electron desktop app

**Status:** Active. New desktop work targets this Electron app.

## Development

```bash
pnpm --filter @memry/desktop dev
pnpm --filter @memry/desktop dev:staging
pnpm --filter @memry/desktop build
```

Runtime sync targets are selected by `MEMRY_ENV`:

| Environment | Command                                    | Runtime file       | Sync server                          |
| ----------- | ------------------------------------------ | ------------------ | ------------------------------------ |
| development | `pnpm --filter @memry/desktop dev`         | `.env.development` | `http://localhost:8787`              |
| staging     | `pnpm --filter @memry/desktop dev:staging` | `.env.staging`     | `https://sync-staging.memrynote.com` |
| production  | `pnpm --filter @memry/desktop build`       | `.env.production`  | `https://sync.memrynote.com`         |

Keep desktop runtime env files limited to shippable app config such as `SYNC_SERVER_URL`.
Do not put Paddle API keys, JWT private keys, Resend keys, or other server secrets in desktop env
files.

## Packaged Builds

Local packaging uses `apps/desktop/scripts/build-packaged-app.js`.

Packaged builds always use `MEMRY_ENV=production` and copy `.env.production` into the app as
`Resources/.env`. The packaging script rejects missing, localhost, and staging sync URLs.

Public desktop installers for macOS, Windows, and Linux are coming at the end of June.
