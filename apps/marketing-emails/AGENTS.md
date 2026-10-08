# Marketing emails guide

This directory owns the campaign email templates (`@memry/marketing-emails`), built with React Email. Kaan sends them by hand from the Resend dashboard. Read `PLAYBOOK.md` before writing a new campaign.

## Layout

- `emails/` holds one file per campaign. In a numbered series, the number is send order and send history, so a sent campaign keeps its number.
- `src/` holds shared campaign content (`campaign-content.ts`, `waitlist-program-content.ts`), tracking links (`tracking-links.ts`), and the reusable email components.
- `posts/` holds long-form companion posts, such as Reddit drafts.
- `scripts/check-campaign-copy.mjs` is the copy gate behind `test:copy`.

## Commands

```bash
pnpm --filter @memry/marketing-emails dev        # preview in the browser
pnpm --filter @memry/marketing-emails test:copy  # copy gate
pnpm --filter @memry/marketing-emails typecheck
pnpm --filter @memry/marketing-emails build      # exports HTML to out/
```

An email is done when `test:copy` and `typecheck` pass and you have previewed it in `dev`. A template that compiles can still render broken.

## Sent is permanent

An email cannot be recalled, edited, or unsent.

- A sent template stays as it is. Write the next one instead.
- Check every claim against what the product ships today. A wrong feature claim reaches every inbox at once.
- Check every link, including the tracking links in `tracking-links.ts`. A dead CTA wastes the whole campaign.
- Send, schedule, or change a Resend audience only when Kaan asks.

## Copy

- Use landing's brand voice, not the docs' voice: warm, direct, and plain, and still calm, private, and crafted. Skip hype and urgency theater.
- No emojis unless an earlier sent template in the same series already uses them.
- Write in the second person, in short sentences, with one clear CTA per email.
- Every template keeps the unsubscribe link (`{{{RESEND_UNSUBSCRIBE_URL}}}`) and the sender identity. The law requires both.

## HTML email

- Email clients are not browsers. Use tables and inline styles. Flexbox, grid, and any CSS you have not confirmed in Outlook stay out.
- Every image has alt text, and the design still reads with images blocked.
- Dark mode inverts colors unpredictably, so a background color never carries meaning on its own.
