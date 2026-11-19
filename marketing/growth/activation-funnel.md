# Activation insight and first-run funnel

Issue #3462. Today the activation number exists only in the growth-review skill's `collect.js`.
PostHog cannot split it by platform or release, and nothing shows how far a new install gets in
its first days. This file specifies two SQL insights for the PostHog dashboard "Growth · Weekly
Overview" (2143655). Agents stay read-only on PostHog, so Kaan saves them by pasting the files in
`queries/` into new SQL insights.

The repo is public, so this file holds no counts. The results of the 2026-11-17 run are in the
gitignored `.user-insights/growth/analyses/2026-11-17-activation-funnel.md`.

## Event definitions

Every query filters `environment = 'production'`, which the sync server sets on each event
(`apps/sync-server/src/services/posthog-transform.ts`).

| Term           | Meaning                                                                                                                                                                                                                                                                                                                      |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Install        | A PostHog person. A signed-in install merges into its account's person, so an existing account's second device is not new. Installs with telemetry off send nothing.                                                                                                                                                         |
| `app_started`  | Sent once per launch when the telemetry runtime starts (`apps/desktop/src/main/telemetry/runtime.ts`).                                                                                                                                                                                                                       |
| Engaged event  | Any of the 17 events in action 369611 "Desktop · Engaged use". `app_active_heartbeat` fires only while a window has focus. Since release 2026.928.1, finishing onboarding writes `general.onboardingCompleted` through the settings handler, which sends `setting_changed`, so finishing onboarding alone counts as engaged. |
| `note_updated` | Sent by autosave, at most once per note every 5 minutes (`apps/docs/src/architecture/observability.md`). Three events mean three separate editing windows, or edits in three notes.                                                                                                                                          |
| Activation     | At least 3 `note_updated` within 7 days of the install's first engaged event.                                                                                                                                                                                                                                                |
| `platform`     | `darwin`, `win32`, `linux` or `ios`, set on every event. Filter desktop on `platform`, not on `$lib`: desktop events carry `$lib = 'memry-desktop'` only from September 2026.                                                                                                                                                |
| `app_version`  | The release that sent the event. Releases look like `2026.1030.1`. Unpackaged dev and test runs report another shape, such as Electron's own version.                                                                                                                                                                        |
| `locale`       | A person property only, so it holds the install's latest locale.                                                                                                                                                                                                                                                             |

## Insights

Both are SQL (HogQL) insights. Most installs never sign in, and person-based insights such as
Lifecycle drop anonymous persons. HogQL also lets each step use the install's own 7-day window.

### Growth · Aktivasyon (haftalık kohort)

- Query: `queries/activation-weekly.sql`. Columns: `cohort_week`, `new_installs`, `activated`.
- Display: table, newest week last. A bar chart of `new_installs` with `activated` as a second
  series also works.
- Description: "Her tamamlanmış kohort haftası için yeni masaüstü kurulumları ve ilk 7 günde en
  az 3 note_updated yapanlar (aktivasyon). growth-review'daki sorguyla aynıdır; biri değişirse
  diğeri de değişir. Sadece production ve masaüstü."
- Agreement with the growth page: the file is `collect.js`'s `activation` query, desktop platform
  filter included. On 2026-11-17 both returned identical rows for every complete cohort. Change
  both together.

### Growth · İlk çalıştırma hunisi (platform) and (sürüm)

- Queries: `queries/first-run-funnel-platform.sql` (one row per cohort week and platform) and
  `queries/first-run-funnel-version.sql` (one row per first release and platform).
- Steps, each counted inside the previous one:
  1. `started`: the install's first `app_started`. It sets the cohort week, the platform and the
     release.
  2. `engaged`: the first engaged event, within 7 days of that start.
  3. `edited`: at least 1 `note_updated` within 7 days of the first engaged event.
  4. `activated`: at least 3 `note_updated` in the same window.
- The issue names three steps. `edited` is the "first note edit" from the issue's Why section.
  The 2026-11-17 run showed why it matters: `engaged` passes almost every install that launches,
  because heartbeats and the onboarding `setting_changed` count. The installs drop out between
  `engaged` and `edited`.
- Builds without a release version are left out. A cohort appears once every member had 21 days:
  up to 7 days to the first engaged event, then 7 days to edit, then the rest of the week.
- Display: table. For the platform query, a line chart of `activated` and `edited` per platform
  also works.
- Description (platform): "Yeni masaüstü kurulumlarının ilk günleri: ilk açılış, ilk aktif
  kullanım (369611), ilk not düzenlemesi, aktivasyon. İlk açılışın haftasına ve platformuna göre.
  Sürümü olmayan geliştirici ve test derlemeleri hariç. Bir kohort, üyelerinin hepsi 21 günü
  doldurunca görünür."
- Description (sürüm): the same text, ending with "İlk açılıştaki sürüme ve platforma göre."

## Dashboard

Add the three insights below the existing tiles of "Growth · Weekly Overview" (2143655), each at
full width. The dashboard does not copy the growth page's bucket model, Quick Ratio or forecast.
That follows the issue's recommendation and is still Kaan's call.

## Platform filter

iOS TestFlight installs reach PostHog from the week of 2026-11-01 and count as new engaged
installs from the week of 2026-11-08, where they outnumber new desktop installs. iOS installs
rarely send `note_updated`, so without a filter the growth page would show activation falling for
a reason unrelated to desktop.

Since 2026-11-17 the skills filter `properties.platform IN ('darwin', 'win32', 'linux')`:
`.agents/skills/growth-review/collect.js` in its activation and retention queries, and
`.agents/skills/inspect-users/collect.js` in its anonymous-install query.

Action 369611 still has no platform filter. Its own description says it backs the dashboard's
weekly numbers, and growth-review reads its weekly engaged installs from the same source, so
those include iOS from the week of 2026-11-08. Kaan's part:

1. Add a `platform` filter (`darwin`, `win32`, `linux`) to each of the 17 steps of action 369611.
2. Save `queries/activation-weekly.sql` as the insight above.

## Caveats

- Test runs pollute production. On 2026-10-23 and 2026-10-24, a few dozen installs of the older
  release 2026.928.1 arrived in hourly batches, each launched about 30 times in a day, and none
  wrote notes. They sit in the 2026-10-18 cohort of both insights, because they are packaged
  builds. Packaged builds have no switch to turn telemetry off from the environment
  (`computeInitialEnabled` in `runtime.ts` reads only `MEMRY_TELEMETRY_ENABLED=true`), so VM and
  automation runs of release builds report as real users. `activation-drop.md` has the details.
- Weekly cells per platform hold a few to a few dozen installs. Read a change over three or more
  weeks.
- An install that merges into an existing account person keeps that person's first events, so a
  second device of a known account never appears as new.
