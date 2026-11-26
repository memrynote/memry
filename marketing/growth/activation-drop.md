# Why the newest cohorts activate less

Issue #3457. This is a read-only analysis of PostHog project 412311, run on 2026-11-17. It covers
production desktop installs first seen in the cohort weeks 2026-08-09 to 2026-11-01. Activation
means at least 3 `note_updated` within 7 days of an install's first engaged event, as in
`activation-funnel.md`. Every split comes from `queries/activation-segments.sql`. The repo is
public, so the counts are in the gitignored
`.user-insights/growth/analyses/2026-11-17-activation-drop.md`.

The cohort weeks fall into three periods:

- A: 2026-08-09 to 2026-09-20, before the drop.
- B: 2026-09-27 to 2026-10-11, the cohorts the issue flagged.
- C: 2026-10-18 to 2026-11-01, the cohorts completed since.

## Answer

Two separate things lower the newest cohorts.

1. **Most of the 2026-10-18 cohort is test traffic.** That cohort has the lowest activation on
   the growth page and is also the largest. More than half of its installs came from machines,
   not people. One group is a set of installs of the older release 2026.928.1 that arrived on
   2026-10-23 and 2026-10-24 in hourly batches, with one locale per platform. Most of them
   launched about 30 times in a single day. The rest are unpackaged builds that report Electron's
   version instead of a release. None of these installs edited a note three times. Without them,
   the 2026-10-18 cohort falls inside the range of the other cohorts since late September.
2. **Windows and Linux installs on releases 2026.928.1 to 2026.1015.1 activate less.** macOS
   installs activated at the same rate before and after the drop. On Windows and Linux, installs
   whose first session ran 2026.928.1, 2026.1014.1 or 2026.1015.1 activated far less often than
   earlier installs on those platforms. A two-proportion test puts the gap well past chance. They
   finished onboarding and created a vault as often as before. Fewer of them edited a note at all,
   and fewer reached three edits. Installs that started on 2026.1024.1 or later are back near the
   earlier level on Windows and Linux, but there are still too few of them to be sure.

The two releases bracket the drop. 2026.928.1 split vault onboarding into create, open and sync
flows (#2441). 2026.1024.1 replaced the first run with a new wizard and a sandbox vault (#3439).
Nothing in the data shows which part of #2441 would hurt Windows and Linux and spare macOS.

The data cannot tell whether the release or a change in traffic caused the Windows and Linux drop.
Windows and Linux download clicks on the landing site peaked in the same weeks, and no install can
be tied to a landing visit (see "Channel").

## Segments

Each line compares period A with B and C, after the test traffic is removed.

- **Platform.** macOS stayed flat. Windows went from the highest rate in A to well below macOS in
  B, then partly recovered in C. Linux fell in B and again in C, on small numbers.
- **Release of the first session.** On Windows and Linux, the rate fell with 2026.928.1, fell
  further with 2026.1014.1 and 2026.1015.1, and came back with 2026.1024.1 and later. On macOS it
  held at the same level for every release family.
- **Locale.** English and other locales fell by similar amounts, and the share of non-English
  installs did not grow. Locale does not explain the drop.
- **Onboarding.** Nearly every install completes onboarding in every period, and activation among
  those that completed it fell like the total. Onboarding completion does not explain the drop.
- **Import.** Installs that import notes activate at a high rate in every period, and more of them
  imported in C. Import does not explain the drop.
- **Errors in the first week.** Activated installs see `app_error_seen` more often than the rest,
  because they use the app more. The share of non-activated installs with an error did not rise.
  Errors do not explain the drop.
- **Unclean exits in the first week** (`app_crashed`, action `unclean_shutdown`). Among installs
  that did not activate, unclean exits rose sharply from 2026.928.1 on, mostly on Windows and
  Linux. They stayed high on 2026.1024.1 and later, when activation recovered, so they do not
  track the drop. The rise deserves its own look.
- **Days with a launch.** Installs that launched on two or more days in their first week activate
  far more often in every period. Their share fell slightly in B, and their own activation rate
  fell too, so the drop is not only fewer returning installs.

## Channel

No cohort install could be tied to a landing visit. Desktop installs and landing visitors are
separate PostHog persons. Landing never identifies a visitor, and desktop never sends the
visitor's id, so not one of the cohort installs shares a person with a landing pageview.

Weekly totals are the only link. Landing visitors and download clicks grew from mid-September,
mostly in Direct and Organic Search. Windows download clicks peaked in the week of 2026-09-27,
and Linux clicks stayed at their highest from 2026-09-27 to 2026-10-11. macOS clicks peaked a
little later, in the week of 2026-10-11. More Windows and Linux visitors therefore arrived in the
same weeks as the drop. If they came from a new, less committed source,
that would produce the same pattern as a release problem. The "how did you hear about us"
question (#3459) and the UTM tags (#3460) are what would separate the two.

## Measurement problems found

1. **Test runs report as users.** Packaged builds send production telemetry, and
   `computeInitialEnabled` in `apps/desktop/src/main/telemetry/runtime.ts` offers no environment
   switch to turn it off (`MEMRY_TELEMETRY_ENABLED` can only turn it on). VM and automation runs of
   release builds therefore count as new installs. Unpackaged builds with a production build
   channel do the same.
2. **iOS joins the desktop cohorts from the week of 2026-11-08.** Neither the activation query nor
   action 369611 filters on platform. `activation-funnel.md` has the fix.
3. **Finishing onboarding counts as engaged since 2026.928.1.** Onboarding now writes
   `general.onboardingCompleted` through the settings handler, which sends `setting_changed`, an
   engaged event. For most installs on 2026.928.1, this is their first engaged event. A check that
   anchors each install on its first engaged event other than `setting_changed` shows the same
   pattern, with Windows and Linux down in period B and macOS flat, so this change does not
   explain the drop.
   It does count installs that only finished onboarding as engaged.

## Caveats

- Release and cohort week move together, because a new install downloads the latest release.
  The split by release is also a split by calendar weeks.
- The test traffic filter is a fingerprint picked by hand: release 2026.928.1 first seen on
  2026-10-23 or 2026-10-24, plus any version that is not a release. Other machine-made installs
  may remain.
- Linux cells hold few installs, and the post-2026.1024.1 group is small on every platform.
- Installs are PostHog persons. A signed-in second device of an existing account is never new,
  and installs with telemetry off are invisible.
- `locale` is a person property, so it holds each install's latest locale.
- An unclean exit also covers force quits and system restarts, not only crashes.

## For the onboarding experiment (#3458)

- Aim at the step from a created vault to the first note edit on Windows and Linux. That is where
  the drop happened, and onboarding completion itself is not the problem.
- Run a clean Windows first launch of the current release (the `vm-repro` skill) before the
  experiment, looking for anything that stops or delays the first edit. Turn telemetry off in
  the app's settings first, or that run becomes another test install in production.
- Measure the experiment against cohorts that started on 2026.1024.1 or later. That release
  shipped the new first-run wizard with a sandbox vault (#3439), and it is where Windows and Linux
  recovered.
