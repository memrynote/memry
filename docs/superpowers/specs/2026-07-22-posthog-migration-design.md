# PostHog Migration — Design

Date: 2026-07-22
Status: Approved design, pending implementation plan
Supersedes: `2026-06-10-desktop-posthog-analytics-design.md` (that design made PostHog a _mirror_; this one makes it the _only_ sink)

## Goal

Replace the current three-store observability stack with PostHog as the single sink, and
decommission the self-hosted Grafana + Loki entirely.

Current state (verified 2026-07-22):

| Surface                                                 | Store                                                       | Viewer                                           |
| ------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------ |
| Desktop product telemetry                               | Cloudflare Analytics Engine `memry_product_telemetry_{env}` | Grafana `/d/memry-product-telemetry` (29 panels) |
| Landing web analytics                                   | Cloudflare Analytics Engine `memry_landing_telemetry_{env}` | Grafana `/d/memry-landing` (11 panels)           |
| Desktop stacks, server error detail, diagnostic reports | Loki on VPS `178.105.205.174`                               | Grafana `/d/memry-logs` (4 panels)               |

Target state: all six flows land in PostHog project 412311. Grafana and Loki are deleted.

## Why this is not a greenfield build

Commit `05c7fd708 refactor(telemetry): remove PostHog, use Cloudflare Analytics Engine` removed a
working PostHog integration on 2026-07-04. Branch `telemetry-account-identity` (PR #512) still
exists locally. Substantial parts of this migration are the inverse of that commit plus adaptation
to products that did not exist then (Logs went GA 2026-01-29, Error Tracking, group analytics).

This matters because the chosen cutover strategy (§6) removes the usual verification net; reusing a
previously-shipped transform materially lowers the residual risk.

## 1. Decisions

| #   | Decision                                                                                                                            | Rationale                                                                                                                                       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Signed-in users are identified; anonymous installs fall back to install hash. No session replay on desktop; replay ON for landing.  | Person-level funnels/retention need real identity. Desktop replay would capture note content and contradicts the product's privacy positioning. |
| D2  | Logs, errors and diagnostic reports all go to PostHog. Loki and Grafana are fully decommissioned. 14-day log retention is accepted. | Single pane of glass. Retention drop from 30d to 14d accepted explicitly.                                                                       |
| D3  | The 50-event contract is **not** changed. The desktop→sync-server proxy reshapes events into PostHog-native form.                   | No desktop release needed for taxonomy. Field devices keep sending today's shape and still produce correct PostHog data.                        |
| D4  | **No historical backfill.** PostHog starts from cutover day.                                                                        | User decision. AE data remains queryable in Cloudflare for 90 days; a one-off cold CSV dump to R2 is optional (§7).                             |
| D5  | Big-bang cutover: one PR flips the writers and deletes AE + Loki.                                                                   | User decision, taken with the risk in view. See §6 for the mitigation that replaces the backfill comparison.                                    |
| D6  | Verification = golden fixture tests on the transform + a staging end-to-end run before production.                                  | Replaces the parity check that D4 removed.                                                                                                      |

### D1 has a prerequisite that D3 cannot satisfy

`TelemetryBatchSchema` carries `authState` (`anonymous | signed_in | signed_out`) but **no account
identifier**, and `/telemetry/*` is deliberately excluded from the auth middleware
(`apps/sync-server/src/index.ts:59`). The proxy can reshape a taxonomy; it cannot invent an identity
that never left the device.

PR #512 solved this by having the desktop send its bearer token to `/telemetry/batch` and the server
verify the JWT to resolve an account id. That mechanism is restored here. It requires **one desktop
release**, for identity only — every other part of this migration ships server-side.

Until an updated client is in the field, every install reports as anonymous. When an updated client
first reports an account, PostHog's `$identify` + `$anon_distinct_id` merges the install into the
account. This is PostHog's designed anonymous→identified transition, not a workaround.

Known limitation carried forward from PR #512: telemetry identity is **verified but not
revocation-checked**. The JWT is verified without a devices-table lookup, so a revoked device's
unexpired token (≤15 min) can still attribute telemetry. Accepted.

## 2. Target flows

### 2.1 Desktop product telemetry

`/telemetry/batch` (contract unchanged) → new `apps/sync-server/src/services/posthog.ts` →
`POST https://us.i.posthog.com/batch/`.

Transform (single pure function, the heart of this migration):

- Event names preserved as-is, except `page_viewed` → `$pageview`.
- Batch metadata (`platform`, `arch`, `locale`, `appVersion`, `buildChannel`, `syncState`,
  `timezoneOffsetMinutes`) → **person properties** via `$set`.
- Event fields (`surface`, `action`, `objectType`, `source`, `result`, `errorCode`, `dimensions`,
  `metrics`) → event properties.
- `occurredAt` → `timestamp`.
- `environment` property on every event (see §3).
- Vault → **group analytics** group.

### 2.2 Identity

- `distinct_id` = resolved account id when the batch carries a verified bearer, else `installHash`.
- `$identify` with `$anon_distinct_id = installHash` is emitted **once per session**, marked
  idempotent in KV.

  PR #512 fired `$identify` on every authenticated batch (~every 30s). That is idempotent in PostHog
  but burns identified-event volume; the once-per-session form was its deferred optimization and is
  adopted here from the start.

- `$identify` merges are **permanent and irreversible**. A wrong merge cannot be undone.

### 2.3 Logs

`/telemetry/logs` and `/diagnostics/report` → OTLP-JSON `POST /v1/logs`, `Authorization: Bearer
<project token>`.

- `service.name` = `desktop` | `server`; `deployment.environment` = env (resource attributes)
- `severityText` = level
- body = the already-redacted line
- `posthogDistinctId` attribute = the same distinct_id as §2.2, so logs appear on the person's
  profile Logs tab

`packages/contracts/src/redact.ts` is **unchanged**. The sink changes; the privacy model does not.
Desktop log lines still carry no message field.

No OpenTelemetry SDK is used. PostHog's log capture service accepts plain OTLP-JSON over HTTP with
the project token as a bearer, which is the same shape as today's `pushLokiEntries` — appropriate
for a Cloudflare Worker.

### 2.4 Errors

Events carrying `errorCode` or `error.stack` are additionally emitted as `$exception` events, giving
Error Tracking issue grouping linked to the person.

Payload (verified against PostHog's manual error tracking installation docs):

```json
{
  "api_key": "<project token>",
  "event": "$exception",
  "properties": {
    "distinct_id": "<§2.2 distinct_id>",
    "$exception_list": [
      {
        "type": "<errorCode>",
        "value": "<redacted stack, or errorCode when absent>",
        "mechanism": { "handled": true, "synthetic": false }
      }
    ],
    "$exception_fingerprint": "<errorCode>"
  }
}
```

Two consequences specific to Memry:

- `value` cannot carry an error message. The contract deliberately has no message field
  (`TelemetryErrorDetailSchema` ships `stack` / `componentStack` only, because a desktop error
  message can embed a note title or filename). The redacted stack goes in `value` instead.
- `$exception_fingerprint` is set explicitly to `errorCode`. Left unset, PostHog derives a hash from
  the exception pattern; setting it means issues group by our own error code, which reproduces the
  semantics of today's `errors by code` panel exactly.

The event name must be exactly `$exception` — a plain `exception` event lands in Events but never
reaches Error Tracking. Error Tracking is free up to 100k exceptions/month.

### 2.5 Landing

`posthog-js` runs directly in the browser (required for session replay, which cannot be
server-proxied).

- Session replay ON, `maskAllInputs: true`
- Autocapture ON; UTM/campaign capture is built in
- `environment` tag added — closing a known gap where landing prod, previews and local all blended
  into one undifferentiated stream

Deleted: `POST /telemetry/web`, the `LANDING_TELEMETRY` binding, the custom
`apps/landing/src/lib/analytics.ts` pipeline, and `LandingTelemetryBatchSchema` /
`LandingTelemetryEventSchema` in contracts.

**CSP — this has caused a 16-day outage before.** Landing ingests through the managed reverse-proxy
subdomain `https://e.memrynote.com` (`VITE_POSTHOG_HOST`). `apps/landing/vercel.json` `connect-src`
is currently `'self' https://sync.memrynote.com https://*.paddle.com`. It must regain
`https://e.memrynote.com` explicitly — `https://*.posthog.com` does **not** match it. Pageviews and
replay both ride `connect-src`, so they die together and silently.

`apps/landing/src/lib/csp.test.ts` already guards this pattern; add `https://e.memrynote.com` to its
`REQUIRED_CONNECT_SRC` so the guard fails loudly if it is ever dropped again.

### 2.6 Server business events

`captureBusinessEvent` writes to PostHog instead of Analytics Engine, tagged `surface='server'`.

## 3. Environment separation

Keep the existing model: **one project (412311), environments separated by an `environment` event
property** — not separate projects or tokens.

`sync-server` already derives this from `ENVIRONMENT` in `wrangler.toml`. Desktop events inherit the
_ingesting server's_ environment, not the desktop build channel; desktop's own identity remains
`build_channel`. Landing gains the tag for the first time.

Consequence to respect: **any insight that does not filter `environment` blends dev, staging and
production.** Every dashboard tile built in §5 must carry the filter.

## 4. Verification (replaces the backfill parity check)

1. **Golden fixture tests.** The transform is a pure function. One fixture per event name (50) plus
   identity, person-property, group and error cases: input batch → expected PostHog payload. Runs in
   CI.
2. **Staging end-to-end.** Staging sync-server points at PostHog with `environment=staging`. Drive a
   staging desktop build through the real flows and assert every one of the 50 event names actually
   lands with the expected shape, that `$identify` merges an install into an account exactly once,
   and that person properties and group membership resolve.
3. Production cutover only after both are green.

This is weaker than a side-by-side parity comparison against live production numbers. That is an
accepted consequence of D4 + D5.

## 5. Dashboard parity (44 panels)

| Source            | Target                                                                                                                                                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 29 product panels | Overview stats → trends insights. Onboarding funnel → native Funnel (more correct than the current barchart approximation). Top-events / feature-usage tables → SQL insights. Platform & version splits → breakdowns. |
| 11 landing panels | Most are native **Web Analytics** (visitors, pageviews, top pages, UTM). Only the demo funnel and CTA/target tables need custom insights.                                                                             |
| 4 log panels      | The two timeseries become event / Error Tracking insights — **not** log queries. The two log panels become the Logs tab.                                                                                              |

Building the error charts from events rather than from logs is deliberate: it removes any dependency
on log-query aggregation capability, and the data (`errorCode` as an event property) is already
there.

Project 412311 still contains two dashboards from the earlier attempt — `1694748` (Desktop Product
Analytics, 11 tiles) and `1694749` (Sync Server Business & Health, 7 tiles). Audit and adapt rather
than rebuild.

New capability gained beyond parity: retention, path analysis, cohorts, session replay, feature-flag
correlation, and events + logs + replay on a single person profile.

## 6. Cutover

Single PR:

1. Add `services/posthog.ts` and the transform, with golden tests.
2. Switch `/telemetry/batch`, `/telemetry/logs`, `/diagnostics/report`, and `captureBusinessEvent`.
3. Replace the landing pipeline with `posthog-js`; fix `connect-src` and the guard test.
4. Delete AE writers, `services/loki.ts`, the `PRODUCT_TELEMETRY` / `LANDING_TELEMETRY` bindings, and
   `LOKI_URL` / `LOKI_TOKEN`.

Deploy order is **server before desktop**, per the standing rule. The desktop release carrying the
identity bearer follows separately and is not on the critical path.

## 7. Decommissioning

- **VPS `178.105.205.174`**: remove the `grafana` and `loki` containers, `/opt/grafana`, the Caddy
  `/loki/api/v1/push` route and its token file. Postiz and Temporal on the same host are untouched.
- **Cloudflare**: AE datasets drain themselves in 90 days; the bindings are removed with the code.
- **Optional cold archive**: before Grafana is removed, dump the two AE datasets to R2 as CSV. This
  is not an import into PostHog and does not reopen D4 — it is a zero-cost hedge against needing a
  pre-cutover number later.

## 8. Privacy and compliance

- PostHog must be **re-added** to the privacy policy and the sub-processor list in `Privacy.tsx`; it
  was removed on 2026-07-04.
- Landing session replay introduces cookies. The current landing pipeline was cookie-free (anonymous
  uuid in `localStorage`). The consent posture must be settled before replay ships.
- Desktop keeps `disable_session_recording`.
- The redaction layer is unchanged, and desktop log lines still carry no message field.

## 9. Risks

1. Identity requires one desktop release; until it is in the field, identity is install-scoped.
2. `$identify` merges are irreversible.
3. Log retention drops 30d → 14d. Accepted. PostHog signalled longer options were coming in Jan 2026;
   re-check at implementation time.
4. Big-bang cutover with no production parity check. Mitigated only by §4.
5. Landing CSP is a known silent-failure mode with a 16-day precedent.
6. Insights that omit the `environment` filter blend dev noise into production numbers.

## 10. Out of scope

Consolidating Memry's own feature-flag system onto PostHog feature flags. It is a real opportunity
and a separate decision.
