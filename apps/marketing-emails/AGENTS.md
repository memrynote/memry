# Marketing Emails Rules

Transactional and campaign email templates (`@memry/marketing-emails`), React Email. Root `AGENTS.md` applies; this file adds email rules.

## Layout

- `emails/` — campaign templates, numbered by send order. The number is send history; do not renumber a sent campaign.
- `src/` — shared campaign content (`campaign-content.ts`), tracking links (`tracking-links.ts`), and reusable email components.
- `posts/` — long-form source.
- `scripts/check-campaign-copy.mjs` — copy gate.
- `PLAYBOOK.md` — how campaigns are planned and sent. Read it before writing a new one.

## Commands

```bash
pnpm --filter @memry/marketing-emails dev        # preview in browser
pnpm --filter @memry/marketing-emails test:copy  # copy gate
pnpm --filter @memry/marketing-emails typecheck
pnpm --filter @memry/marketing-emails build
```

`test:copy` and `typecheck` must pass before an email is done. Preview every template in `dev` before calling it finished: a template that compiles can still render broken.

## Sent Is Permanent

An email cannot be recalled, edited, or unsent.

- Never modify a template that has already been sent. Create the next one.
- Verify every claim against what the product ships today. A wrong feature claim reaches thousands of inboxes at once.
- Verify every link, including tracking links in `tracking-links.ts`. A dead CTA is the whole campaign wasted.
- Never send or trigger a send unless the user explicitly asks.

## Copy

- Brand voice is landing's, not the docs': warm, direct, plain. Still calm, private, crafted; never hype, never urgency theater.
- No emojis unless an existing sent template in the same series already uses them.
- Second person, short sentences, one clear CTA per email.
- Unsubscribe and sender identity stay intact in every template. That is a legal requirement, not a design choice.

## HTML Email

- Email clients are not browsers. Tables and inline styles; no flexbox, grid, or modern CSS you have not confirmed renders in Outlook.
- Every image needs alt text and a design that still reads with images blocked.
- Dark mode inverts unpredictably. Do not rely on a background color carrying meaning.
