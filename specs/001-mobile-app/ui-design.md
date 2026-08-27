# Mobile UI Design Reference

**Figma:** [Memry Mobile — iOS](https://www.figma.com/design/12AJO1nkTbStIJi5vWDfAq) (file key `12AJO1nkTbStIJi5vWDfAq`)

Complete screen inventory for the iOS app: **108 artboards across 14 pages**, designed
2026-08-27. Every screen is bound to the shared variable collections and text styles, so a
token change propagates file-wide. This document is the implementation-facing summary; the
Figma file is the source of truth for pixels.

## Scope decisions

- **Day-one feature parity** with desktop, except: no Agent Chat / AI surfaces, canvas is
  **read-only** (too-large canvases skip rendering entirely), payments are **Apple IAP**.
- White theme only for now. Warm/Dark hex values live in `docs/DESIGN_TOKENS.md`; the Figma
  plan tier caps variable collections at one mode, so other themes are added later.
- Five tab-bar roots: **Home · Notes · Tasks · Journal · More**. Inbox, Calendar, Projects,
  Canvases, Tags, and Settings live under More until usage data argues otherwise.
- No sign-up on mobile: vault creation and the recovery phrase happen on desktop first
  (US1 decision). The "no vault yet" screen explains this instead of dead-ending.

## Page inventory

| Figma page             | Artboards | Contents                                                                                                                                                                                                           |
| ---------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 00 · Foundations       | 6 boards  | Colour tokens, type ramp (17 styles), spacing/radius, iOS safe-area spec, 36 icons, component library, motion & interaction spec                                                                                   |
| 01 · Shell & Global    | 8         | Tab bar states, More menu, search (entry/results/filters/no-results), quick capture, share extension                                                                                                               |
| 02 · Auth & Onboarding | 13        | Splash, welcome ×3, sign in (e-mail/code/no-vault), vault picker, phrase unlock, Face ID, first sync, sync error, notifications primer                                                                             |
| 03 · Home              | 5         | Populated, zero state, customise widgets, syncing, read-only+offline                                                                                                                                               |
| 04 · Notes             | 18        | List, folder browse, read, edit, slash menu, selection bar, wiki-link autocomplete, properties, actions, move-to, tags hub, tag detail, backlinks, attachments, image viewer, find-in-note, templates, empty vault |
| 05 · Tasks             | 7         | Grouped list, filter/sort, detail, quick add (NL parse), date picker, lock-screen notification, empty                                                                                                              |
| 06 · Journal           | 5         | Today, month view (streak stats), editing, past entry (read-only + Edit), empty day                                                                                                                                |
| 07 · Inbox             | 8         | Triage (swipe Note/Task/Snooze), item detail + filing, bulk select, snooze picker, archived (search lives only here), insights, zero, quick capture                                                                |
| 08 · Calendar          | 6         | Month, week/agenda, day timeline, new event, Google connect + source toggles, not connected                                                                                                                        |
| 09 · Projects          | 4         | List, hub, content tabs, create                                                                                                                                                                                    |
| 10 · Canvas            | 4         | List, read-only viewer, card preview sheet, too-large notice                                                                                                                                                       |
| 11 · Billing           | 5         | Paywall (yearly/monthly), StoreKit sheet, manage subscription, Believer one-time, success                                                                                                                          |
| 12 · Settings          | 15        | Root, account, vault & storage, sync & devices, appearance, editor, tasks, journal, inbox, tags & properties, calendar, notifications, security, language, about & diagnostics                                     |
| 13 · System States     | 4         | Offline in context, sync-state chip strip, loading/error set, kill-switch + version gate                                                                                                                           |

## Design system

**Colour** — the `Theme` collection mirrors `base.css` → `.white` exactly (see
`docs/DESIGN_TOKENS.md`): `canvas/*` (background `#ffffff`, surface `#f7f6f3`,
surface-active `#efedea`), `text/*` (`#37352f` / `#6b6966` / `#9b9a97`), `line/*`
(`#e3e2e0`), `ui/*` (primary `#37352f`, destructive `#e03e3e`), `tint/base` `#6366f1`
(user-configurable), `dot/*` accent dots, `pastel/*` card tints.

**Primitives** — 4pt grid (`space/2…48`), radius xs 4 → xxl 20 (+ full), sizes: tap-target
44, nav-bar 44, tab-bar 49, status-bar 47, home-indicator 34, row 56, screen 390×844.

**Typography** — Space Grotesk (display, −2% tracking) · Inter (UI, Semi Bold headings) ·
Crimson Pro (editor serif body 18/28) · JetBrains Mono (code 13/20). Tracking is
size-specific: tighten large text, body at 0, captions +1%.

**Icons** — 36 icons, 24px, 1.75 stroke, round caps — same visual language as the desktop
Lucide set. Implementation: `lucide-react-native` with `strokeWidth={1.75}`.

## Decisions locked during design review (apple-design audit)

Full spec lives on the Figma board **"Foundations / Motion & Interaction Spec"** (node
`49:56`). Highlights:

- **Contrast:** `text/tertiary` on white is 2.9:1 — fails WCAG AA at caption sizes
  (FR-044). Essential metadata uses `text/secondary` (5.1:1); tertiary is decorative-only
  or ≥18pt. Inactive tab labels use secondary. `ui/destructive` text at small sizes should
  darken to ≈`#d63333` (fills keep `#e03e3e`).
- **Chrome is translucent** at implementation time (blur 20, saturate 180%, white 72% via
  `expo-blur`); artboards show the flattened white fallback. No 1px divider under nav —
  scroll-edge blur fade instead.
- **Springs, not durations:** sheets 0.8/0.30s, push-pop 1.0/0.35s (no overshoot), swipe
  actions 1.0/0.25s, canvas release 0.8/0.40s with momentum projection. Press feedback on
  pointer-down. Commit-vs-cancel by release-velocity sign. Enter/exit share one path.
- **Reduced motion (FR-044):** sheets/pushes become 200ms cross-fades; no slide, overshoot,
  or parallax. Haptics fire on the same frame as the visual, only on toggle flip / task
  check / snooze commit.
- **FAB is a deliberate non-iOS pattern** (kept for capture affordance); the iOS-native
  alternative (bottom-toolbar compose) is noted if App Review or usage pushes back.

## Implementation order

1. **Foundation pass** (horizontal): tokens → typography → icons → component library
   (Button, TextField, SearchField, SegmentedControl, BottomSheet, ListRow, SectionHeader,
   Chip, Banner, Toast, FAB, EmptyState, SkeletonRow, SyncProgress) → 5-root tab shell →
   dev gallery screen for side-by-side comparison with Figma.
2. **Vertical slices** per user story (spec order, Phase 4/US2 editor next), each slice
   binding UI directly to the local DB — sync already provides real data for notes/home;
   dummy data only behind seams where the domain layer doesn't exist yet.
