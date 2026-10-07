# Landing guide

This directory owns the marketing site (`@memry/landing`), a Vite and React app on Vercel, plus its account, checkout, and download pages. A push to `main` that touches `apps/landing/` deploys it to production.

## Brand register

Landing is a separate design register from the product apps.

- `src/index.css` holds the visual system: terracotta `#ff671a`, paper, and ink.
- Landing typography, mascots, and CTA treatment stay out of desktop, iOS, and the extension, and product tokens stay out of landing.
- Mascot icons live in `public/mascots`. To add one in style, follow `scripts/mascots/README.md`.

## Content

- Marketing copy is a claim. State only features, prices, and guarantees the product ships today.
- Privacy and encryption claims match what desktop and the sync server actually do. When a claim drifts, fix the copy.
- Copy carries no emojis unless the page already uses one in that spot.

## Account and checkout

- `src/pages/account` and `src/lib/account` are a sync-server client. They register a web device with its own Ed25519 key and call the auth and account routes. Landing deploys on every push to `main`, while production sync-server deploys by hand, so these pages must work against the sync server running in production.
- Checkout runs through Paddle (`api/paddle-checkout.ts`, `src/lib/paddle-checkout.ts`). Prices and plan names are product claims too.
- Keys and tokens stay in the browser and out of logs.

## SEO and static assets

- `api/` holds Vercel serverless functions, and `vercel.json` owns routing, headers, and redirects. A URL change adds a redirect, so indexed paths keep working.
- Give a new public page a `PAGE_META` entry in `src/lib/seo.ts`. The build derives `sitemap.xml` from those entries, and `deploy-landing.yml` pings IndexNow with the live sitemap after each production deploy, so skip the manual `indexnow` script.
- Optimize images before committing them. `public/` ships as-is to every visitor.
- Public pages show visible focus states and give every meaningful image alt text.

## Commands

- `pnpm --filter @memry/landing typecheck`, `lint`, `test`, and `build` are the gates. The root `pnpm lint` and `pnpm typecheck` skip this app. `build` runs the typecheck, the Vite build, and prerendering (`scripts/prerender.ts`). Tests use `node:test`, not Vitest.
- Check copy changes in the built output with `pnpm --filter @memry/landing preview`.
- `.env.local` is gitignored and linked across worktrees by `pnpm env:link`.
