# MemryNote Waitlist Launch Campaign Playbook

Operator manual for the 11-email waitlist program around the end-of-June launch.
Manual send via Resend dashboard.

Launch date: **Tuesday June 30, 2026**.

## Commands

```bash
pnpm --filter @memry/marketing-emails test:copy
pnpm build:emails
```

Open the rendered HTML from `apps/marketing-emails/out/`, send a Resend test to yourself,
then schedule the broadcast.

## Pre-flight

| check                              | how                                                                  | blocks send     |
| ---------------------------------- | -------------------------------------------------------------------- | --------------- |
| Domain verified                    | Resend -> Domains -> `memrynote.com` has DKIM, SPF, DMARC green      | yes             |
| Waitlist audience ready            | Resend -> Audiences -> "MemryNote Waitlist" has the current contacts | yes             |
| Unsubscribe works                  | Send a Resend test and click `{{{RESEND_UNSUBSCRIBE_URL}}}`          | yes             |
| Resend webhook active              | Resend -> Webhooks sends email events to `/api/resend-webhook`       | yes             |
| PostHog env configured             | Landing production has `VITE_POSTHOG_*` and server `POSTHOG_*` vars  | yes             |
| Sender identity set                | `Kaan <kaan@memrynote.com>` with reply-to `kaan@memrynote.com`       | yes             |
| Physical address ready             | Add postal address to footer before the first production send        | yes             |
| Discount ready                     | `WAITLIST25`, 25% off annual MemryNote Sync                          | before email #7 |
| Download and checkout smoke tested | `memrynote.com/download` and `memrynote.com/sync` both work          | before email #7 |

## Schedule

| #   | template file                    | send date  | ET / Istanbul    | job                               |
| --- | -------------------------------- | ---------- | ---------------- | --------------------------------- |
| 1   | `01-waitlist-launch-plain`       | Wed May 20 | 11:00am / 6:00pm | Plain founder note                |
| 2   | `02-waitlist-scattered-workflow` | Wed May 27 | 11:00am / 6:00pm | Problem framing                   |
| 3   | `03-waitlist-product-preview`    | Wed Jun 3  | 11:00am / 6:00pm | Editor and product preview        |
| 4   | `04-waitlist-workflow`           | Wed Jun 10 | 11:00am / 6:00pm | Tasks, journal, calendar workflow |
| 5   | `05-waitlist-local-first-ai`     | Wed Jun 17 | 11:00am / 6:00pm | Privacy, offline, AI agent trust  |
| 6   | `06-waitlist-launch-week`        | Wed Jun 24 | 11:00am / 6:00pm | Waitlist perk and launch-day plan |
| 7   | `07-waitlist-launch-day`         | Tue Jun 30 | 10:30am / 5:30pm | Download link and waitlist code   |
| 8   | `08-waitlist-getting-started`    | Thu Jul 2  | 11:00am / 6:00pm | First 10 minutes after install    |
| 9   | `09-waitlist-use-cases`          | Tue Jul 7  | 11:00am / 6:00pm | Concrete use cases                |
| 10  | `10-waitlist-feedback`           | Tue Jul 14 | 11:00am / 6:00pm | Feedback and bug collection       |
| 11  | `11-waitlist-last-call`          | Tue Jul 21 | 2:30pm / 9:30pm  | Final discount reminder           |

Istanbul is UTC+3. US Eastern is EDT during this window, so Istanbul = ET + 7h.

## Email Notes

### #1 Plain Founder Note

- Subject: `MemryNote ships end of June`
- Asset: none.
- Goal: founder note, simple plan, ask for replies.

### #2 Scattered Workflow

- Subject: `Your notes, tasks, calendar, and journal should not live in four places`
- Asset: none.
- Goal: make the product problem obvious in the same plain-text tone as #1.

### #3 Product Preview

- Subject: `what MemryNote actually looks like`
- Asset: real editor screenshot, 560x360 hosted PNG or JPG under 200KB.
- Goal: show the app surface and ask which area people want to see next.

### #4 Workflow

- Subject: `How tasks, journal, and calendar connect in MemryNote`
- Asset: none.
- Goal: explain the daily operating loop in the same plain-text tone as #1.

### #5 Local-first + AI

- Subject: `Local-first, private by default, AI when useful`
- Asset: none.
- Goal: build trust before asking people to download, with the same direct founder voice.

### #6 Launch Week

- Subject: `MemryNote launches next week`
- Asset: none required.
- Goal: tell waitlist members what they will receive on launch day.

### #7 Launch Day

- Subject: `MemryNote is live`
- Asset: launched app hero screenshot.
- Morning-of smoke test:
  - `memrynote.com/download` works on Mac and Windows.
  - `memrynote.com/sync` checkout loads.
  - `WAITLIST25` applies 25% off annual Sync.
- Send only after smoke test is green.

### #8 Getting Started

- Subject: `First 10 minutes in MemryNote`
- Asset: none required.
- Goal: reduce activation friction after download.

### #9 Use Cases

- Subject: `Four ways to use MemryNote`
- Asset: none required.
- Goal: help different waitlist groups map the product to real work.

### #10 Feedback

- Subject: `What should I fix next?`
- Asset: none required.
- Goal: collect bugs, objections, and sharper product language.

### #11 Last Call

- Subject: `Your MemryNote waitlist code expires tonight`
- Asset: none required.
- Goal: close the waitlist annual discount.

## Behavior Branches

Keep the primary 11 emails as the canonical sequence. Add branches only when they reduce noise.

| segment                             | action                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------- |
| Opened but did not click            | Resend a shorter subject variant after 48 hours, once per key email             |
| Clicked but did not download or buy | Send a short objection email with one CTA                                       |
| Downloaded or paid                  | Stop sales emails and send onboarding only                                      |
| No opens after three emails         | Reduce frequency and skip discount pressure until launch day                    |
| Replied                             | Answer manually; do not put them into automated nudges until the thread is done |

## Public Companion Posts

Post after the email, not at the same time. Email gets first touch.

| email  | post timing                                        | asset                                     |
| ------ | -------------------------------------------------- | ----------------------------------------- |
| #1-#6  | 90 minutes after the email                         | match the email asset if useful           |
| #7     | 90 minutes after launch email                      | launch thread with hero image or 30s demo |
| #8-#10 | same day, only if there is a useful product lesson | optional                                  |
| #11    | 30 minutes after the email                         | plain-text final reminder                 |

## Metrics

Track only decisions you can act on:

- reply themes from #1-#6
- PostHog `marketing_email_*` delivery/open/click events by `utm_campaign`
- click-through on #7 download and Sync buttons via `utm_content`
- waitlist and checkout events: `waitlist_signup_success`, `checkout_initiated`
- conversion on `WAITLIST25`
- onboarding questions after #8
- bug and objection themes from #10

Do not over-read open rate. Apple Mail privacy and old waitlist behavior make it noisy.
