# Goal: the iOS Journal tab at desktop parity, from the Paper design

## Context

- Branch `feat/ios-journal-parity` in worktree `.worktrees/ios-journal-parity`, opened from `main` (tasks parity is merged there, #2375).
- The iOS Journal tab is a `ComingSoonTab` today (`apps/ios/Memry/Features/Notes/VaultTabsView.swift:48`). Journal records and their CRDT bodies already sync and project in the Rust core (`project_journal`, body pull). The core has `domain/journal.rs` (`open_day`, `entry_for`, `document_id_for`), but none of it is exported over UniFFI, and the write, read and reminder surfaces are note-only.
- A journal day is a note with a date instead of a title, icon, cover, folder and aliases. The day page reuses the iOS note page (spec 003). The journal-only parts are new: date header, day paging, Month, Year, journal reminders, Settings › Journal, the Day section and the stats footer.
- The design is in Paper: file **"Task iOS"**, id `01M39KJ8S9S5QYX38B2HP3Q1BF`, page **"Journal iOS"** (`p-2-0`). Read it with the Paper MCP (`paper_get_basic_info`, `paper_get_tree_summary`, `paper_get_jsx`, `paper_get_computed_styles`, `paper_get_screenshot`).
- Your job: implement `specs/005-ios-journal-parity/tasks.md` end to end. That file is the plan and the only state.

## Read first (once)

1. Root `AGENTS.md`, `apps/ios/AGENTS.md`, `apps/desktop/AGENTS.md`, `DESIGN.md`, `PRODUCT.md`.
2. `tasks.md` §0.3.1 (this run's own simulator, `memry-B`) and §0.4 (sign-in). Then `specs/004-ios-tasks-parity/tasks.md` §0.6 (commands) and §6 (decisions that still hold). `specs/005-ios-tasks-redesign/tasks.md` §0.3–§0.4 (how Paper values map to `Tokens`) and §6.
3. `specs/003-ios-note-parity/tasks.md` and `plan.md`: how the note page, block editing, metadata, backlinks, reminders and templates were built.
4. Paper artboard **"00 · Journal feature audit"** in full: every desktop journal feature, its iOS status (Reuse / New / Core / Desktop / Out), and the rules that must match desktop. Treat it as the parity checklist.
5. Paper artboard **"01 · Journal flow"**: open a day, move between days, write, remote edit, reminders, templates, and the Day page anatomy.
6. Every screen artboard J01–J13. Read `get_tree_summary` and `get_jsx` and the layer names ("Date title", "Ghost row", "Day section", "Stats footer", "Morning fog").
7. Desktop, in full before touching the matching area: `apps/desktop/src/renderer/src/pages/journal.tsx`, `components/journal/*`, `hooks/use-journal*.ts`, `lib/journal-utils.ts`, `lib/journal-template-resolution.ts`, `pages/settings/journal-section.tsx`, `apps/desktop/src/main/{ipc/journal-handlers.ts,vault/journal.ts,journal/*,sync/item-handlers/journal-handler.ts,database/queries/notes/journal-queries.ts}`.
8. Core: `crates/memry-core/src/domain/{journal.rs,body_write.rs,notes/*,templates.rs,reminders/*,settings.rs}`, `api/{vault.rs,notes.rs,notes_write.rs,search.rs}`.

## Screens (Paper artboard → what it defines)

| Artboard                    | Node    | What it defines                                                                                                                                                                                            |
| --------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 00 · Journal feature audit  | `30F-0` | Parity checklist, build order, rules that must match desktop                                                                                                                                               |
| 01 · Journal flow           | `38U-0` | Seven lanes: open, navigate, write, remote edit, reminders, templates, page anatomy                                                                                                                        |
| J01 · Today, empty          | `55Z-0` | Weekday line + TODAY badge, serif date title with title-menu chevron, morning fog, ‹ › and bell + … glass groups, "+ Tag / + Property" ghost row, today placeholder, Day section (due today, overdue pill) |
| J02 · Today, written        | `5JM-0` | Tags, properties, body with a heading, a wiki link and a task block; filled bell when a reminder is set                                                                                                    |
| J03 · Scrolled to the end   | `605-0` | Inline nav title "Thu, Sep 24", tasks from this day, backlinks (a journal backlink included), outgoing links, Day section, stats footer                                                                    |
| J04 · Title menu            | `64V-0` | Month, Year, Go to date…                                                                                                                                                                                   |
| J05 · Month                 | `6Y6-0` | Days newest first: activity dot, day, weekday, preview, Today badge, Future / No entry states; subtitle with count and streak                                                                              |
| J06 · Year                  | `72A-0` | 3-column month grid with count and activity dots, current month highlighted, totals (days with entries, characters)                                                                                        |
| J07 · Bell menu             | `680-0` | Journal presets with resolved dates (1 week, 1 month, 3 months, 1 year at 09:00), Pick date & time…                                                                                                        |
| J08 · Reminder sheet        | `851-0` | Scheduled reminder for this day, Change reminder (date, time, note), one-reminder rule copy                                                                                                                |
| J09 · More menu             | `6B5-0` | Find in page, Export…, Journal settings                                                                                                                                                                    |
| J10 · Past day, no entry    | `6EA-0` | "Today" capsule off today, past placeholder, relative weekday line, tasks due that day                                                                                                                     |
| J11 · Settings › Journal    | `8BI-0` | Default template, template per weekday ("2 of 7 set"), stats footer toggle                                                                                                                                 |
| J12 · Template for Saturday | `8F7-0` | Use default (resolved name) or a template, absolute-weekday rule copy                                                                                                                                      |
| J13 · Reminder notification | `8JI-0` | Lock-screen notification: "Journal reminder" / "Revisit Thursday, September 24", no entry text                                                                                                             |

Paper draws the journal serif with Newsreader as a stand-in for New York; ship `Tokens.Typography` serif roles, not Newsreader.

## Rules (non-negotiable)

- **One simulator.** iOS runs only on `memry-B` (UDID `87D1093B-2676-4B04-9FCF-3479FF10859D`), addressed by UDID, with `-derivedDataPath /tmp/memry-dd-B`. Never boot, shut down, erase or delete another simulator. `simctl shutdown all` and `simctl erase all` are forbidden (`tasks.md` §0.3.1).

- **Desktop is the reference.** A behavior question the design does not answer takes desktop's behavior, logged in `tasks.md` §6. Paper decides layout and placement only.
- **Backward compatibility.** Journal payloads the phone writes must be readable by every shipped desktop, and nothing the phone writes may cost a desktop user body text. `tasks.md` D5 and gate G0 (JP029) are the contract.
- **Shared logic in the core.** Rules both platforms must agree on (preview, counts, activity level, streak, month and year stats, template resolution and substitution) live in Rust behind vectors generated from desktop TypeScript. Swift holds UI and view state.
- **Reuse the note page.** The day page composes the existing note components. Extract shared parts where needed (JP033). Never fork them.
- **Native iOS 26.** System navigation, toolbar glass groups, `toolbarTitleMenu` (or the list-header title menu from spec 005-redesign §6 RD01/RD02), `Menu`, `.presentationDetents`, `.swipeActions`, a paging `TabView` or `scrollTargetBehavior` for days. Values from Paper map to `Tokens`. No new hex in views, no `Font.system(size:)`.
- **Accessibility and RTL** as spec 004 TP057 and spec 005-redesign RD90: VoiceOver, AX5, 44pt targets, Reduce Motion and Reduce Transparency, leading/trailing only, WCAG AA in light and dark.
- **iOS rules** from `apps/ios/AGENTS.md`: no `!` / `try!`, `ErrorMapping`, `Log.swift`, feature Swift files ≤ 400 lines, Rust files ≤ 600 lines, notification bodies never carry entry text, writes call `requestVaultSync`.

## Done when

- Every task in `tasks.md` through JP095 is ticked with evidence, and §8 Final report is written.
- Every row of artboard 00 marked Reuse, New or Core has been exercised on the simulator at its new place (JP093 table).
- Cross-device round trips pass against desktop `dev:staging` (JP082), including gate G0.
- Rust, vectors, desktop and all three iOS test plans are green (JP083, JP084).
