# i18n Phase C Calendar Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the calendar feature UI to the `calendar.json` namespace, with English populated and Turkish/Arabic falling back to English.

**Architecture:** This is a feature-namespace migration on top of Phase A/B i18n plumbing. Calendar-specific copy moves to `packages/i18n/src/locales/en/calendar.json` and calendar components call `useT('calendar')`; shared Phase B verbs/states keep using `common` only when already present. Locale-specific date/month/weekday labels should use `Intl.DateTimeFormat(i18n.language, ...)`, not translation JSON.

**Tech Stack:** TypeScript, React 19, `react-i18next`, `@memry/i18n`, Vitest, React Testing Library, Electron renderer.

**Spec:** `docs/superpowers/specs/2026-04-29-i18n-multi-language-support-design.md`

**Depends on:** Phase A infrastructure and Phase B common namespace plans:
- `docs/superpowers/plans/2026-04-29-i18n-phase-a-infrastructure.md`
- `docs/superpowers/plans/2026-04-29-i18n-phase-b-common-namespace.md`

**Out of scope:**
- Phase D errors/menu strings. Leave `extractErrorMessage(..., 'Could not ...')`, logger strings, and native menu copy alone.
- Phase E i18n checker, ESLint rule, and RTL/Tailwind codemod.
- Settings-page calendar preferences and settings Google Calendar rows.
- TR/AR calendar translations. `tr/calendar.json` and `ar/calendar.json` stay exactly `{}`.
- User/provider content: event titles, calendar names, attendee names/emails, URLs, free-form notes.

---

## Files

**Inspect first, timeboxed to 20 minutes:**
- `packages/i18n/src/locales/en/common.json`
- `packages/i18n/src/locales/{en,tr,ar}/calendar.json`
- `packages/i18n/src/renderer/use-t.ts`
- `apps/desktop/src/renderer/src/components/calendar/calendar-toolbar.tsx`
- `apps/desktop/src/renderer/src/components/calendar/calendar-shell.tsx`
- `apps/desktop/src/renderer/src/components/calendar/calendar-event-popover.tsx`
- `apps/desktop/src/renderer/src/components/calendar/calendar-quick-create-dialog.tsx`
- `apps/desktop/src/renderer/src/components/calendar/delete-calendar-event-dialog.tsx`
- `apps/desktop/src/renderer/src/components/calendar/promote-external-dialog.tsx`
- `apps/desktop/src/renderer/src/components/calendar/calendar-event-metadata.tsx`
- `apps/desktop/src/renderer/src/components/calendar/calendar-page.test.tsx`
- Representative focused tests near touched components.

**Modify/create:**
- Modify: `packages/i18n/src/locales/en/calendar.json`
- Modify: `packages/i18n/src/locales/tr/calendar.json`
- Modify: `packages/i18n/src/locales/ar/calendar.json`
- Modify representative calendar components listed above; include adjacent calendar view files when they contain visible calendar labels (`All day`, `No events`, weekday headers, `more...`).
- Modify representative tests: `calendar-page.test.tsx`, `calendar-quick-create-dialog.test.tsx`, `calendar-picker.test.tsx`, `promote-external-dialog.test.tsx`, `calendar-event-metadata.test.tsx`.
- Optional create: `packages/i18n/src/shared/calendar-namespace.test.ts`.
- Optional create: `apps/desktop/src/renderer/src/components/calendar/calendar-test-i18n.tsx` for a local test wrapper.

**Do not modify:**
- `apps/desktop/src/renderer/src/pages/settings/calendar-section.tsx`
- `apps/desktop/src/renderer/src/components/settings/google-calendar-integration-row.tsx`
- `apps/desktop/src/renderer/src/components/settings/google-calendar-source-picker.tsx`
- Any non-calendar Phase C plan/namespace another worker owns.

## Task 1: Base Check

- [ ] **Step 1: Verify Phase A/B files exist**

Run:

```bash
test -f packages/i18n/src/renderer/use-t.ts
test -f packages/i18n/src/locales/en/common.json
node -e "const c=require('./packages/i18n/src/locales/en/common.json'); if (!c.button?.save || !c.button?.cancel || !c.button?.delete || !c.state?.saving) process.exit(1); console.log('OK')"
```

Expected: `OK`. If this fails, stop and rebase onto Phase B.

- [ ] **Step 2: Confirm calendar namespace stubs**

Run:

```bash
for f in packages/i18n/src/locales/{en,tr,ar}/calendar.json; do echo "$f"; cat "$f"; done
```

Expected before implementation: calendar files are either `{}` or only this branch's intended changes.

## Task 2: Populate `en/calendar.json`

- [ ] **Step 1: Add English calendar keys**

Populate `packages/i18n/src/locales/en/calendar.json` with grouped keys covering:
- `view`: `day`, `week`, `month`, `year`
- `toolbar`: create event, previous/next period, today
- `filter`: filter calendars, sources, Memry items, imported calendars, event types, Google calendars, refresh Google calendars
- `visualType`: event, imported event, task, reminder, snooze
- `state`: loading calendar, loading calendars, preparing
- `empty`: no imported calendars yet, no events
- `time`: all day, all-day lower-case, pick a date, new event, `{count}` more events ICU key
- `form`: create/edit calendar event, sr-only descriptions, placeholders, start/end, add details, Google calendar, target calendar, default calendar labels, primary suffix
- `deleteDialog`: title, local description, Google-bound description, context-menu delete label
- `promoteDialog`: aria/title/body, do not ask again, confirm label
- `onboardingDialog`: aria/title/body, default-calendar label, skip, use this calendar
- `metadata`: attendees, reminders, default reminders, visibility, optional, join meeting, response status labels

Use kebab-case translation keys, e.g. `toolbar.create-event`, `delete-dialog.title`, `metadata.response.needs-action`.

- [ ] **Step 2: Keep TR/AR as empty fallback files**

Set both files to exactly:

```json
{}
```

Files:
- `packages/i18n/src/locales/tr/calendar.json`
- `packages/i18n/src/locales/ar/calendar.json`

- [ ] **Step 3: Verify JSON and fallback**

Run:

```bash
node -e "for (const l of ['en','tr','ar']) JSON.parse(require('fs').readFileSync(`packages/i18n/src/locales/${l}/calendar.json`, 'utf8')); console.log('OK')"
pnpm --filter @memry/i18n typecheck
```

Expected: JSON prints `OK`; typecheck passes.

- [ ] **Step 4: Commit**

```bash
git add packages/i18n/src/locales/en/calendar.json packages/i18n/src/locales/tr/calendar.json packages/i18n/src/locales/ar/calendar.json
git commit -m "feat(i18n): add calendar namespace strings"
```

## Task 3: Toolbar, Filters, and Labels

- [ ] **Step 1: Migrate toolbar labels**

Modify `apps/desktop/src/renderer/src/components/calendar/calendar-toolbar.tsx`:
- Use `const { t, i18n } = useT('calendar')`.
- Keep `const { t: tCommon } = useT('common')` only for Phase B `common.action.search`.
- Replace view labels, create event aria, previous/next period aria, and Today with `calendar` keys.
- Replace `Intl.DateTimeFormat(undefined, ...)` with `Intl.DateTimeFormat(i18n.language, ...)`.

- [ ] **Step 2: Migrate filter/shell labels**

Modify `apps/desktop/src/renderer/src/components/calendar/calendar-shell.tsx`:
- Use `useT('calendar')`.
- Replace filter button aria, source headings, Memry/imported labels, event type heading, Google calendars heading, refresh aria, and loading state.
- Do not translate `source.title`.

Modify `apps/desktop/src/renderer/src/components/calendar/visual-type-meta.ts`:
- Remove hardcoded visible labels or replace with stable key mapping.
- Keep colors/order unchanged.

- [ ] **Step 3: Run focused test**

Run:

```bash
pnpm --filter @memry/desktop test:renderer -- calendar-page
pnpm --filter @memry/desktop typecheck:web
```

Expected: calendar page tests and web typecheck pass.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/src/components/calendar/calendar-toolbar.tsx apps/desktop/src/renderer/src/components/calendar/calendar-shell.tsx apps/desktop/src/renderer/src/components/calendar/visual-type-meta.ts apps/desktop/src/renderer/src/components/calendar/calendar-page.test.tsx
git commit -m "feat(i18n): migrate calendar toolbar and filters"
```

## Task 4: Create/Edit Event UI

- [ ] **Step 1: Migrate quick create dialog**

Modify `apps/desktop/src/renderer/src/components/calendar/calendar-quick-create-dialog.tsx`:
- Use `useT('calendar')` for calendar-specific title, description, placeholders, add details.
- Use `useT('common')` for Cancel, Save, Saving.
- Replace hand-written month arrays with `Intl.DateTimeFormat(i18n.language, ...)`.
- Leave create-error fallback string for Phase D.

- [ ] **Step 2: Migrate full event popover**

Modify `apps/desktop/src/renderer/src/components/calendar/calendar-event-popover.tsx`:
- Use `calendar` keys for create/edit aria/title, description, placeholders, all-day, start/end, Google calendar labels, target calendar defaults.
- Use `common` only for Cancel, Create, Save, Saving.
- Replace manual short-month labels with `Intl.DateTimeFormat(i18n.language, ...)`.
- Leave save/update error fallback strings for Phase D.

- [ ] **Step 3: Migrate calendar picker**

Modify `apps/desktop/src/renderer/src/components/calendar/calendar-picker.tsx`:
- Use `calendar` keys for Target calendar, Use default calendar, Loading calendars, and primary suffix.
- Preserve custom `defaultOptionLabel` prop behavior.

- [ ] **Step 4: Update representative tests**

Wrap affected component tests with an i18n provider. If useful, create local helper `apps/desktop/src/renderer/src/components/calendar/calendar-test-i18n.tsx`.

Update:
- `calendar-quick-create-dialog.test.tsx`
- `calendar-picker.test.tsx`
- `calendar-page.test.tsx`

Expected assertions still use English because English is the populated source locale.

- [ ] **Step 5: Run focused tests**

```bash
pnpm --filter @memry/desktop test:renderer -- calendar-quick-create-dialog calendar-picker calendar-page
pnpm --filter @memry/desktop typecheck:web
```

Expected: tests and typecheck pass.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/components/calendar/calendar-quick-create-dialog.tsx apps/desktop/src/renderer/src/components/calendar/calendar-event-popover.tsx apps/desktop/src/renderer/src/components/calendar/calendar-picker.tsx apps/desktop/src/renderer/src/components/calendar/*test*.tsx
git commit -m "feat(i18n): migrate calendar event editor"
```

## Task 5: Dialogs, Metadata, Chips, and View States

- [ ] **Step 1: Migrate confirmation dialogs**

Modify:
- `apps/desktop/src/renderer/src/components/calendar/delete-calendar-event-dialog.tsx`
- `apps/desktop/src/renderer/src/components/calendar/promote-external-dialog.tsx`
- `apps/desktop/src/renderer/src/components/calendar/google-calendar-onboarding-dialog.tsx`

Use `calendar` for dialog titles/body/checkbox labels and `common` for shared buttons/states already supplied by Phase B. Leave error fallback strings for Phase D.

- [ ] **Step 2: Migrate metadata and chip labels**

Modify:
- `apps/desktop/src/renderer/src/components/calendar/calendar-event-metadata.tsx`
- `apps/desktop/src/renderer/src/components/calendar/calendar-item-chip.tsx`

Use `calendar` for attendees/reminders/visibility labels, response badges, Optional, Join meeting, All day, and context-menu Delete event. Do not translate attendee names, emails, URLs, or Google-provided reminder method strings.

- [ ] **Step 3: Migrate representative view labels**

Modify relevant labels in:
- `apps/desktop/src/renderer/src/components/calendar/calendar-day-view.tsx`
- `apps/desktop/src/renderer/src/components/calendar/calendar-week-view.tsx`
- `apps/desktop/src/renderer/src/components/calendar/calendar-month-view.tsx`
- `apps/desktop/src/renderer/src/components/calendar/calendar-year-view.tsx`
- `apps/desktop/src/renderer/src/components/calendar/calendar-mini-month.tsx`
- `apps/desktop/src/renderer/src/components/calendar/marquee-selection-overlay.tsx`

Cover All day/all-day, New Event overlay, No events, previous/next month aria, and `{count} more...`. Use `Intl.DateTimeFormat(i18n.language, { weekday/month: ... })` for weekday/month headers. Do not change first-day-of-week behavior.

- [ ] **Step 4: Update representative tests**

Update:
- `calendar-page.test.tsx`
- `promote-external-dialog.test.tsx`
- `google-calendar-onboarding-dialog.test.tsx`
- `calendar-event-metadata.test.tsx`

Expected English assertions still pass through i18n.

- [ ] **Step 5: Run focused tests**

```bash
pnpm --filter @memry/desktop test:renderer -- calendar-page promote-external-dialog google-calendar-onboarding-dialog calendar-event-metadata
pnpm --filter @memry/desktop typecheck:web
```

Expected: tests and typecheck pass.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/components/calendar
git commit -m "feat(i18n): migrate calendar dialogs and view states"
```

## Task 6: Bounded Final Sweep

- [ ] **Step 1: Run a bounded string scan**

Run this once, then inspect only actionable matches in calendar production files:

```bash
rg -n --glob '!*.test.tsx' --glob '!calendar-test-i18n.tsx' '"(Day|Week|Month|Year|Today|Create event|Create calendar event|Edit calendar event|New Event|Add location|Add details|All day|No events|No imported calendars yet|Loading calendar|Loading calendars|Delete event|Delete event\\?|Filter calendars|Memry items|Imported calendars|Event types|Google calendars|Join meeting|Default reminders|Visibility|Optional|Edit in Memry|Don'\''t ask again|Use this calendar|Target calendar|Previous month|Next month)"|placeholder="(New Event|Add location|Add notes or URL)"|aria-label="(Create event|Create calendar event|Edit calendar event|Filter calendars|Target calendar|Previous month|Next month)"' apps/desktop/src/renderer/src/components/calendar apps/desktop/src/renderer/src/pages/calendar.tsx
```

Expected: no remaining user-facing calendar UI literals. Allowed leftovers: logger strings, Phase D error fallbacks, test data excluded above, and provider/user content.

- [ ] **Step 2: Verify TR/AR remain fallback stubs**

```bash
node -e "const fs=require('fs'); for (const l of ['tr','ar']) { const p=`packages/i18n/src/locales/${l}/calendar.json`; if (fs.readFileSync(p,'utf8').trim() !== '{}') process.exit(1) } console.log('OK')"
```

Expected: `OK`.

- [ ] **Step 3: Run final verification**

```bash
pnpm --filter @memry/i18n typecheck
pnpm --filter @memry/desktop test:renderer -- calendar-page calendar-quick-create-dialog calendar-picker promote-external-dialog google-calendar-onboarding-dialog calendar-event-metadata
pnpm --filter @memry/desktop typecheck:web
```

Expected: all pass.

- [ ] **Step 4: Run repo gate if time allows**

```bash
pnpm lint && pnpm typecheck && pnpm test
```

Expected: pass, except documented pre-existing base failures only. Do not classify new calendar/i18n failures as pre-existing.

- [ ] **Step 5: Final commit**

```bash
git status --short
git add packages/i18n/src/locales/en/calendar.json packages/i18n/src/locales/tr/calendar.json packages/i18n/src/locales/ar/calendar.json packages/i18n/src/shared/calendar-namespace.test.ts apps/desktop/src/renderer/src/components/calendar
git commit -m "feat(i18n): migrate calendar feature namespace"
```

Expected: one final commit only if earlier task commits were not used. Prefer the atomic commits above during implementation.
