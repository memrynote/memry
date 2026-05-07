# memrynote.com

Marketing site for **Memry** — a local-first personal knowledge management app that combines notes, tasks, daily journal, and inbox into one distraction-free experience.

Built with React 19, TypeScript, Tailwind CSS 4, and Framer Motion. Deployed on Vercel.

## Tech Stack

| Layer     | Tool                                      |
| --------- | ----------------------------------------- |
| Framework | React 19 + React Router 7                 |
| Language  | TypeScript 5.9                            |
| Build     | Vite 7                                    |
| Styling   | Tailwind CSS 4                            |
| Animation | Framer Motion 12                          |
| Icons     | Lucide React                              |
| UI        | Radix UI primitives                       |
| API       | Vercel Serverless Functions               |
| Email     | Resend                                    |
| Fonts     | Satoshi, Instrument Serif, JetBrains Mono |

## Getting Started

```bash
pnpm install
cp apps/landing/.env.example apps/landing/.env.local
```

Fill in your environment variables:

| Variable            | Required | Description                               |
| ------------------- | -------- | ----------------------------------------- |
| `RESEND_API_KEY`    | Yes      | API key from [Resend](https://resend.com) |
| `RESEND_SEGMENT_ID` | No       | Segment ID to group waitlist contacts     |

```bash
pnpm dev:landing         # dev server on :5173
pnpm build:landing       # type-check + production build
pnpm --filter @memry/landing preview
```

The dev server proxies `/api/waitlist` requests to the Vercel function locally — no separate backend needed.

## Project Structure

```
├── api/
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
- SPA is served as static output from `vite build`
- Domain redirects configured in `vercel.json` (www + .ai variants → memrynote.com)

## Design Tokens

| Token        | Value            | Usage                         |
| ------------ | ---------------- | ----------------------------- |
| Background   | `#fffcf7`        | Warm paper base               |
| Accent       | `#c75b39`        | Terracotta — CTAs, highlights |
| Success      | `#5b7f6a`        | Sage — confirmation states    |
| Heading font | Instrument Serif | Display typography            |
| Body font    | Satoshi          | Interface text                |
| Mono font    | JetBrains Mono   | Data, labels, code            |

## License

Private. All rights reserved.
