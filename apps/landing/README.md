# memrynote.com

Marketing site for **memrynote** — a local-first personal knowledge management app that combines notes, tasks, daily journal, and inbox into one distraction-free experience.

Built with React 19, TypeScript, Tailwind CSS 4, and Framer Motion. Deployed on Vercel.

## Tech Stack

| Layer     | Tool                           |
| --------- | ------------------------------ |
| Framework | React 19 + React Router 7      |
| Language  | TypeScript 5.9                 |
| Build     | Vite 7                         |
| Styling   | Tailwind CSS 4                 |
| Animation | Framer Motion 12               |
| Icons     | Lucide React                   |
| UI        | Radix UI primitives            |
| API       | Vercel Serverless Functions    |
| Email     | Resend                         |
| Fonts     | Satoshi, Inter, JetBrains Mono |

## Getting Started

```bash
pnpm install
cp apps/landing/.env.example apps/landing/.env.local
```

Fill in your environment variables:

| Variable                | Required | Description                                          |
| ----------------------- | -------- | ---------------------------------------------------- |
| `RESEND_API_KEY`        | Yes      | API key from [Resend](https://resend.com)            |
| `RESEND_SEGMENT_ID`     | Yes      | Segment ID the newsletter signup files contacts into |
| `RESEND_WEBHOOK_SECRET` | Yes      | Signing secret for Resend event webhook delivery     |

The landing site ships no third-party analytics or session replay. Anonymous desktop product usage
metrics are collected separately by the desktop app and stored in Cloudflare Analytics Engine.

Paddle checkout uses a serverless function so the Paddle API key stays server-side. Checkout
requests must include an account-bound checkout token minted by the sync server so Paddle webhook
custom data can grant the Sync entitlement to the correct account.

| Variable                         | Required | Description                                                                        |
| -------------------------------- | -------- | ---------------------------------------------------------------------------------- |
| `PADDLE_ENVIRONMENT`             | Yes      | `sandbox` locally; `production` for live Paddle                                    |
| `PADDLE_SANDBOX_API_KEY`         | Yes      | Sandbox API key from Paddle developer tools                                        |
| `PADDLE_API_KEY`                 | No       | Live API key, required when environment is production                              |
| `PADDLE_CHECKOUT_TOKEN_SECRET`   | Yes      | Shared HMAC secret that verifies sync-server checkout tokens                       |
| `PADDLE_PRICE_PLUS_MONTHLY`      | Yes      | Paddle price ID for Sync Plus monthly                                              |
| `PADDLE_PRICE_PLUS_ANNUAL`       | Yes      | Paddle price ID for Sync Plus annual                                               |
| `PADDLE_PRICE_PRO_MONTHLY`       | Yes      | Paddle price ID for Sync Pro monthly                                               |
| `PADDLE_PRICE_PRO_ANNUAL`        | Yes      | Paddle price ID for Sync Pro annual                                                |
| `PADDLE_PRICE_BELIEVER_LIFETIME` | Yes      | Paddle price ID for Believer lifetime                                              |
| `VITE_PADDLE_CLIENT_TOKEN`       | Yes      | Client-side token for Paddle.js overlay checkout                                   |
| `PADDLE_CHECKOUT_URL`            | No       | Payment-link URL fallback. Required if Paddle Checkout has no Default Payment Link |

Use separate Vercel environment scopes:

| Vercel scope    | Paddle env   | Checkout URL                            | Token secret                                    |
| --------------- | ------------ | --------------------------------------- | ----------------------------------------------- |
| Preview/Staging | `sandbox`    | `https://staging.memrynote.com/pricing` | Same value as Cloudflare sync staging secret    |
| Production      | `production` | `https://memrynote.com/pricing`         | Same value as Cloudflare sync production secret |

Staging must use Paddle sandbox API keys, client token, price IDs, and webhook secret. Production
must use Paddle live API keys, client token, price IDs, and webhook secret. Never share
`PADDLE_CHECKOUT_TOKEN_SECRET` between staging and production.

```bash
pnpm dev:landing         # dev server on :5173
pnpm build:landing       # type-check + production build
pnpm --filter @memry/landing preview
```

The dev server proxies `/api/waitlist` and `/api/paddle-checkout` requests to Vercel
functions locally — no separate backend needed.

## Project Structure

```
├── api/
│   ├── paddle-checkout.ts      # Vercel serverless — Paddle transaction checkout
│   ├── resend-webhook.ts       # Vercel serverless — Resend event webhook
│   └── waitlist.ts             # Vercel serverless — Resend waitlist signup
├── src/
│   ├── components/
│   │   ├── layout/             # Header, Footer, Container
│   │   ├── sections/           # Homepage sections (Hero, Features, Pricing, etc.)
│   │   ├── shared/             # WaitlistForm, MockupFrame, SectionHeading
│   │   └── ui/                 # Radix-based primitives (Button, Card, Input, Accordion)
│   ├── lib/
│   │   ├── constants.ts        # All copy, data, and content
│   │   └── utils.ts            # cn() helper
│   ├── pages/                  # Home, Features, Pricing, UseCases, NotFound
│   ├── App.tsx                 # Router + layout shell
│   └── index.css               # Tailwind config, CSS vars, font-face declarations
└── vercel.json                 # Domain redirects
```

## Deployment

Deployed on **Vercel** from the existing `memrynote-landing` project.

Keep the same Vercel project, domains, and environment variables. For the monorepo checkout,
set the Vercel project Root Directory to `apps/landing` so Vercel reads this package's
`package.json`, `vite.config.ts`, `api/`, and `vercel.json`.

- `api/waitlist.ts` runs as a serverless function
- `api/resend-webhook.ts` verifies and acknowledges Resend delivery/open/click/unsubscribe events
- SPA is served as static output from `vite build`
- Domain redirects configured in `vercel.json` (www + .ai variants → memrynote.com)

## Design Tokens

| Token        | Value          | Usage                                            |
| ------------ | -------------- | ------------------------------------------------ |
| Background   | `#fffcf7`      | Warm paper base                                  |
| Accent       | `#FF671A`      | Generated brand orange — CTAs, highlights        |
| Hover accent | `#B33C00`      | Generated dark orange — pressed and hover states |
| Success      | `#5b7f6a`      | Sage — confirmation states                       |
| Heading font | Inter          | Display typography                               |
| Body font    | Satoshi        | Interface text                                   |
| Mono font    | JetBrains Mono | Data, labels, code                               |

## License

Private. All rights reserved.
