---
tags:
  - aurora
project:
  - Aurora launch
stage: In review
deadline: '2026-01-23'
related:
  - 'memry://note/note_WR_pIBLwz_1P'
  - 'memry://event/calendar_2r_-2rx20XUu'
---
Owner: Maya. Engineering: Theo, Priya. Status: in review until the design review on ((date:eyJhbmNob3JJZCI6ImRtX2F1cm9yYS1wcmRfMSIsImRhdGVJU08iOiIyMDI2LTAxLTE2VDE0OjAwOjAwLjAwMFoiLCJoYXNUaW1lIjp0cnVlLCJkYXRlRm9ybWF0IjoicmVsYXRpdmUiLCJyZW1pbmQiOiJub25lIiwidGltZUZvcm1hdCI6InN5c3RlbSJ9)).

## Goals and metrics

| Goal                          | Metric                                 | Target at launch   |
| ----------------------------- | -------------------------------------- | ------------------ |
| People finish what they start | Articles read to the end               | 60% of opened      |
| Highlights feel safe          | Highlights exported per active reader  | 1 or more per week |
| The app stays calm            | Notifications sent per user per week   | 0 by default       |
| Night reading works           | Sessions after 21:00 using night theme | 70%                |

## Requirements

### Reading view

- Line length between 60 and 72 characters on every device
- Three type sizes, one serif, one sans; no custom fonts in 1.0
- Night theme with warm text, never pure white on black

### Highlights

- Long-press to highlight, tap to add a note
- Highlights work offline and sync later; see the offline queue in [[Decision log#Highlights sync]]
- Export all highlights as Markdown, one file per article

### Onboarding

At most three screens. The first one shows a real article, not a feature tour.

## Open work from this doc

- [ ] Write empty-state copy {task:task_uoNslG30EP6e}

- [ ] Measure reading speed in beta {task:task_dQLMjDn16dIX}

## Risks

> [!warning]
> Android font fallback still breaks small caps in the serif. If we cannot fix it, we ship sans-only on Android.

> [!info]
> Everything here is tracked in the Aurora launch project. Open it from the sidebar to see the board.
