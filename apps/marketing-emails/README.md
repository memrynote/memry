# MemryNote Marketing Emails

React Email templates for the MemryNote waitlist launch campaign.

## Commands

```bash
pnpm dev:emails
pnpm --filter @memry/marketing-emails test:copy
pnpm typecheck:emails
pnpm build:emails
```

## Sequence

| #   | template                         | subject                                                                   |
| --- | -------------------------------- | ------------------------------------------------------------------------- |
| 1   | `01-waitlist-launch-plain`       | `MemryNote ships end of June`                                             |
| 2   | `02-waitlist-scattered-workflow` | `Your notes, tasks, calendar, and journal should not live in four places` |
| 3   | `03-waitlist-product-preview`    | `what MemryNote actually looks like`                                      |
| 4   | `04-waitlist-workflow`           | `How tasks, journal, and calendar connect in MemryNote`                   |
| 5   | `05-waitlist-local-first-ai`     | `Local-first, private by default, AI when useful`                         |
| 6   | `06-waitlist-launch-week`        | `MemryNote launches next week`                                            |
| 7   | `07-waitlist-launch-day`         | `MemryNote is live`                                                       |
| 8   | `08-waitlist-getting-started`    | `First 10 minutes in MemryNote`                                           |
| 9   | `09-waitlist-use-cases`          | `Four ways to use MemryNote`                                              |
| 10  | `10-waitlist-feedback`           | `What should I fix next?`                                                 |
| 11  | `11-waitlist-last-call`          | `Your MemryNote waitlist code expires tonight`                            |

The first email is intentionally plain-text style. Use that voice for the whole campaign:
short founder note, simple bullets, direct reply CTA.

The first email does not reveal a discount code. It says waitlist members will receive the
launch-day perk later.

Media placeholders: replace `heroImageUrl` or `screenshotUrl` with absolute hosted screenshot URLs
before sending emails that include screenshots.

## Tracking

Campaign links are built in `src/tracking-links.ts`. Each email uses:

- `utm_source=waitlist`
- `utm_medium=email`
- `utm_campaign=waitlist_XX`
- `utm_content=<link role>`

Do not paste raw `memrynote.com` CTA links into templates; use `trackedMemryUrl` so Resend click
webhooks can be attributed in PostHog without storing recipient email addresses.
