# Landing Rules

Marketing site (`@memry/landing`). Vite + React, deployed on Vercel. Root `AGENTS.md` applies; this file adds landing rules.

## Brand Surface, Not Product

Landing is a separate design register from the product apps.

- Visual system lives in `src/index.css`: terracotta `#ff671a`, paper, ink.
- Do not copy landing typography, mascots, or CTA treatment into desktop, iOS, or extension.
- Do not copy product tokens into landing either. The two registers stay apart on purpose.
- Mascot icons: `public/mascots`. To add one in-style, follow `scripts/mascots/README.md`.

## Commands

```bash
pnpm dev:landing                      # from repo root
pnpm --filter @memry/landing typecheck
pnpm --filter @memry/landing lint
pnpm --filter @memry/landing test
pnpm --filter @memry/landing build
pnpm --filter @memry/landing preview   # verify the built output before shipping copy changes
```

## Content

- Marketing copy is a claim. Do not state a feature, price, or guarantee the product does not ship today.
- Privacy and encryption claims must match what `apps/sync-server` and `apps/desktop` actually do. If a claim drifts, fix the copy, not the reader's expectation.
- No emojis in copy unless the existing page already uses them in that spot.

## SEO and Static Assets

- `api/` holds Vercel serverless functions; `vercel.json` owns routing, headers, and redirects. Changing a URL means adding a redirect, never breaking an indexed path.
- After adding or renaming a public page, run `pnpm --filter @memry/landing indexnow`.
- Optimize images before committing them. `public/` ships as-is to every visitor.

## Style

- `.env.local` is gitignored and linked across worktrees by `scripts/link-env.mjs`. Run `pnpm env:link` if a tree predates it.
- Logical CSS properties for RTL safety, same rule as the product apps.
- Accessibility is not optional on a public page: WCAG AA contrast, real focus states, reduced-motion respected, alt text on every meaningful image.
