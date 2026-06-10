<wizard-report>
# PostHog post-wizard report

The wizard has completed a deep integration of PostHog analytics into the Memry sync server. The project already had a sophisticated custom fetch-based PostHog client (`services/posthog.ts`) — appropriate for Cloudflare Workers where `posthog-node` cannot run. The wizard extended this existing client rather than replacing it, adding a `captureBusinessEvent` helper and wiring it into four route handlers to capture the highest-value business events that were previously missing.

| Event                    | Description                                                                        | File                                      |
| ------------------------ | ---------------------------------------------------------------------------------- | ----------------------------------------- |
| `user_signed_up`         | New account created via OTP email or Google OAuth                                  | `apps/sync-server/src/routes/auth.ts`     |
| `user_logged_in`         | Existing user authenticated via OTP email or Google OAuth                          | `apps/sync-server/src/routes/auth.ts`     |
| `device_registered`      | Device registered to an account (includes platform and app_version)                | `apps/sync-server/src/routes/auth.ts`     |
| `subscription_activated` | Paddle `transaction.completed` or `subscription.created/updated/resumed` processed | `apps/sync-server/src/routes/webhooks.ts` |
| `subscription_canceled`  | Paddle `subscription.canceled` processed                                           | `apps/sync-server/src/routes/webhooks.ts` |
| `subscription_paused`    | Paddle `subscription.paused` processed                                             | `apps/sync-server/src/routes/webhooks.ts` |
| `vault_registered`       | New sync vault created by a paid user                                              | `apps/sync-server/src/routes/sync.ts`     |

**Environment variables:** `POSTHOG_API_KEY` and `POSTHOG_HOST` updated in `apps/sync-server/.dev.vars` for local development. For staging/production, set `POSTHOG_API_KEY` via `wrangler secret put POSTHOG_API_KEY --env <staging|production>`. `POSTHOG_HOST` is already set in `wrangler.toml` for all environments.

## Next steps

We've built some insights and a dashboard for you to keep an eye on user behavior, based on the events we just instrumented:

- [Analytics basics (wizard) — Dashboard](https://us.posthog.com/project/412311/dashboard/1693082)
- [New Signups](https://us.posthog.com/project/412311/insights/UP5CqWi0)
- [Signups vs Logins Trend](https://us.posthog.com/project/412311/insights/sIFpCmNW)
- [Device Registrations by Platform](https://us.posthog.com/project/412311/insights/FabnwxAl)
- [Subscription Health](https://us.posthog.com/project/412311/insights/EqJw3ILk)
- [Vault Registrations](https://us.posthog.com/project/412311/insights/xITX1csP)

### Agent skill

We've left an agent skill folder in your project. You can use this context for further agent development when using Claude Code. This will help ensure the model provides the most up-to-date approaches for integrating PostHog.

</wizard-report>
