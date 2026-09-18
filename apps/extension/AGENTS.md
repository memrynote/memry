# Extension Rules

Browser extension (`@memry/extension`), built with WXT. Chrome, Firefox, Edge. Root `AGENTS.md` applies; this file adds extension rules.

## Layout

- `src/entrypoints` — WXT entrypoints (background, content scripts, popup). File name determines the manifest entry; renaming one changes the shipped manifest.
- `src/components` — popup/UI.
- `src/lib` — shared logic.
- `wxt.config.ts` — manifest, permissions, browser targets.

## Commands

```bash
pnpm --filter @memry/extension dev          # also dev:firefox, dev:edge
pnpm --filter @memry/extension typecheck
pnpm --filter @memry/extension lint
pnpm --filter @memry/extension test
pnpm --filter @memry/extension build        # also build:firefox, build:edge
pnpm --filter @memry/extension zip
```

- Never run `submit`, `submit:firefox`, or `release` unless the user explicitly asks. Those push to store review.
- A change that touches `wxt.config.ts` or an entrypoint must be built for all three targets before it is done: Firefox MV2/MV3 differences surface only at build time.

## Permissions

- Every permission in `wxt.config.ts` is a store review risk and a user trust cost. Do not add one speculatively.
- If a feature needs a new permission, say so explicitly and name the narrowest permission that works (`activeTab` over `<all_urls>`, a specific host over a wildcard).
- Store reviewers reject permission growth without visible justification. Removing one later means another review cycle.

## Content Scripts

- Content scripts run in someone else's page. Never assume a global, a framework, or a CSS reset exists.
- Scope all injected styles. An unscoped selector breaks the host page and looks like the site's bug, not ours.
- Fail quietly on hostile pages. A thrown error in a content script is invisible to the user and useless to us.

## Data

- The extension talks to the user's vault through the same encrypted path as everything else. No plaintext leaves the client.
- Never log page content, URLs with query strings, or auth tokens.
- Stored extension state must tolerate data written by an older extension version. Users update browsers on their own schedule.

## Tests

Vitest via `vitest.config.ts`. If you create or modify a test, run it and iterate until it passes.
