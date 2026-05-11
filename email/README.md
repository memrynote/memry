# Memry — Pre-launch Marketing Emails

Eleven emails sent over eight weeks to the waitlist. Each email previews one part of Memry. The final two announce launch week.

Built with [React Email](https://react.email) and sent through [Resend](https://resend.com).

## Setup

```bash
cd email
pnpm install
cp .env.example .env
# Fill in RESEND_API_KEY, RESEND_AUDIENCE_ID, RESEND_FROM
```

## Local preview

```bash
pnpm dev
# opens http://localhost:3000 with hot-reload for every email
```

## Sending

The `scripts/send.ts` helper takes the email slug and ships it to the audience. Test on yourself first with `--to <email>`.

```bash
pnpm send 01-introduction --to you@example.com   # transactional test send
pnpm send 01-introduction --audience             # create broadcast (review + send in Resend dashboard)
pnpm send 01-introduction --audience --send-now  # create + send immediately (caution)
pnpm send 01-introduction --export               # render HTML to ./out/01-introduction.html
```

## Cadence (8 weeks)

| #   | Send date                  | Slug                   | Feature                              |
| --- | -------------------------- | ---------------------- | ------------------------------------ |
| 01  | Week 1 — Mon               | `01-introduction`      | What Memry is, why we built it       |
| 02  | Week 2 — Mon               | `02-notes`             | Block editor + end-to-end encryption |
| 03  | Week 3 — Mon               | `03-inbox`             | Quick capture                        |
| 04  | Week 4 — Mon               | `04-tasks`             | Tasks tied to notes and projects     |
| 05  | Week 5 — Mon               | `05-journal`           | Daily journal + cross-device sync    |
| 06  | Week 6 — Mon               | `06-projects-calendar` | Projects and calendar                |
| 07  | Week 7 — Mon               | `07-ai-agent`          | AI agent, bring your own model       |
| 08  | Week 7 — Thu               | `08-graph`             | Graph view                           |
| 09  | Week 8 — Mon               | `09-offline`           | Offline-first architecture           |
| 10  | Week 8 — Wed               | `10-launch-week`       | One week to go, full recap           |
| 11  | Week 8 — Day before launch | `11-launch-day`        | "Memry is live"                      |

## Voice

Prosumer/calm. Direct sentences. Active voice. No marketing varnish. "You" not "users". Reference: Capacities, Things, Notion, Bear.

Style guard:

- No em-dashes
- No adverbs ("really", "very", "simply")
- No throat-clearing ("Here's why...", "We're excited to...")
- No binary contrasts ("not X, it's Y")
- Specific over vague

## Images

Every email has hero and inline image placeholders pointing to `placehold.co`. Replace with real product screenshots before each send. Host on Memry's CDN or use Resend's asset hosting.

Placeholder format: `https://placehold.co/1200x680/fafaf9/27272a?text=Hero%3A+Feature+Name`

## Components

- `components/Layout.tsx` — page shell, head, body wrapper, padding
- `components/Eyebrow.tsx` — orange label ("FEATURE PREVIEW · 02 / 11")
- `components/HeroImage.tsx` — top-of-email image with optional caption
- `components/InlineImage.tsx` — body screenshot with caption
- `components/Signoff.tsx` — "Launching [date]. — Kaan"
- `components/Footer.tsx` — brand mark, unsubscribe, social
