# UTM tags

Every link to `memrynote.com` that we publish carries `utm_source`, `utm_medium` and
`utm_campaign`. Without them, a visit from the app, a post or an email lands in PostHog's
"Direct" channel, and the growth page cannot tell which source worked.

## Scheme

- `utm_source` names where the link lives: the app, the platform, or the list.
- `utm_medium` names the kind of link. PostHog derives the channel from it.
- `utm_campaign` names the placement or the campaign.
- `utm_content` is optional. Emails use it for the link's slot in the email.

Values are lowercase. Keep a campaign value once it has shipped, so PostHog history stays in one
row.

| Where the link lives                              | `utm_source`             | `utm_medium` | `utm_campaign`                                   | PostHog channel                                |
| ------------------------------------------------- | ------------------------ | ------------ | ------------------------------------------------ | ---------------------------------------------- |
| Desktop app                                       | `app`                    | `desktop`    | `setup_wizard`, `update_failed`, `checkout`      | Unknown                                        |
| iOS app                                           | `app`                    | `ios`        | `settings`, `plans`, `checkout`                  | Unknown                                        |
| Campaign emails (`apps/marketing-emails`)         | `waitlist`               | `email`      | the id in `src/tracking-links.ts`                | Email                                          |
| YouTube descriptions (`marketing/tutorials`)      | `youtube`                | `video`      | the topic slug                                   | Organic Video                                  |
| X posts and first replies (`marketing/social`)    | `x`                      | `social`     | the calendar, such as `social-q4`                | Organic Social                                 |
| Reddit and Discord posts                          | `reddit`, `discord`      | `social`     | the calendar or the email campaign it companions | Organic Social                                 |
| GitHub README and the repo's website field        | `github`                 | `referral`   | `readme`, `repo`                                 | Referral                                       |
| Docs site (`apps/docs`)                           | `docs`                   | `referral`   | the page, such as `install`                      | Referral                                       |
| Profiles (X bio, Reddit sidebar, YouTube channel) | `x`, `reddit`, `youtube` | `social`     | `profile`                                        | Organic Social, or Organic Video for `youtube` |

Example: `https://memrynote.com/pricing?utm_source=app&utm_medium=desktop&utm_campaign=setup_wizard`.

## Where the links are built

- Desktop: `MEMRY_PRICING_URL` in `apps/desktop/src/renderer/src/pages/settings/setup-wizard.tsx`,
  `DOWNLOAD_URL` in `apps/desktop/src/renderer/src/components/updater/update-install-failed-dialog.tsx`,
  and `buildCheckoutPageUrl` in `apps/desktop/src/main/billing/paddle-billing.ts`.
- iOS: `PlansLinks` in `apps/ios/Memry/Features/Billing/PlansView.swift` and the privacy and terms
  links in `apps/ios/Memry/Features/Settings/AppearanceScreen.swift`.
- Campaign emails: `trackedMemryUrl` in `apps/marketing-emails/src/tracking-links.ts`.
- YouTube: `buildMetadata` in `marketing/tutorials/engine/youtube.mjs` tags the download link.
- X: the default first reply in `marketing/social/engine/export-kit.mjs` and `2026-q4.md`, and each
  `↳ first reply:` line. The local Postiz scheduler (`schedule-x.mjs`, outside this repo) keeps its
  own copy of the default reply.

## Left untagged

- Links to `docs.memrynote.com` and GitHub. Neither runs PostHog, so a tag records nothing.
- Links inside the landing site. A tag on an internal link replaces the visitor's real source on
  the events that follow.
- Sent emails and published posts. They cannot change.
- The Homebrew cask `homepage`, which Homebrew expects to be the plain site URL.
- Transactional email from the sync server. It links to no `memrynote.com` page.

## How PostHog reads the tags

posthog-js saves `utm_*` from the landing URL on every event (`save_campaign_params` defaults to
on), and `trackLandingPageView` in `apps/landing/src/lib/analytics.ts` adds them to `$pageview`.
The session channel (`session.$channel_type`, which the growth page reads) comes from the entry
event. The `/download/desktop` redirect in `apps/landing/vercel.json` keeps the query string.

PostHog's default channel rules map `email` to Email, `social` to Organic Social, `video` to
Organic Video and `referral` to Referral. On 2026-11-17, the last 120 days held 166 visitors from
`waitlist`/`email` in Email, 42 from `reddit`/`social` in Organic Social and 4 from
`youtube`/`video` in Organic Video.

No default rule matches `desktop` or `ios`, so app visits land in Unknown, which held no landing
visitors in the 28 days before 2026-11-17. A custom channel type in PostHog (Project settings >
Web analytics), `utm_source` equals `app` mapped to a channel named App, would label them.
