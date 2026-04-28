# Electron desktop app

**Status:** Active. New desktop work targets this Electron app.

## Development

```bash
pnpm --filter @memry/desktop dev
pnpm --filter @memry/desktop build
```

## Release Builds

Release packaging is handled through the desktop release workflow and
`apps/desktop/scripts/build-packaged-app.js`.
