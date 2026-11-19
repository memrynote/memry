---
tags:
  - aurora
  - decision
project:
  - Aurora launch
---
One entry per decision: what we chose, what we gave up, and when to revisit. Newest first.

## Highlights sync

**Decision:** highlights are stored as plain Markdown files and synced with a CRDT, not as rows on our server.

**Why:** it is the only option where an export is the data itself, not a copy. Theo prototyped both in a week.

**Gave up:** server-side search across highlights.

**Revisit:** if more than 10% of beta readers ask for cross-device search.

## No streaks

**Decision:** no reading streaks, no daily goals.

**Why:** five of nine interviewees described streaks as guilt. See [[Aurora product brief]].

**Gave up:** the easiest retention lever we have.

## Two typefaces only

**Decision:** one serif, one sans, three sizes.

**Why:** every extra choice made the reading view worse in testing. Details in [[Typography spec (signed off)]].

## Archive

The marketing site decisions from last spring live in [[Website v1 postmortem]].
