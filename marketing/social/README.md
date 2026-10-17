# Social clips

Silent screen clips of the real app for the fall X and r/MemryNote series. The posts, dates and
the clip list are in [`2026-q4.md`](2026-q4.md). Every clip is shot in the released desktop app,
on a seeded demo vault, with a fake cursor, auto-zoom and burned-in captions.

## Setup

- This checkout (`memry-social`, branch `feat/social-q4-clips`) holds the clips and the engine.
- The app being filmed is the release build in `../memry-social-app` (tag `v2026-10-15`, built).
  Only what shipped in that build may appear on screen. Point the engine at it:
  `export MEMRY_SOCIAL_APP=/Users/h4yfans/workspace/personal/memry-social-app`
- Clips can record in parallel on **slots** 1 to 12. Each slot is its own app, ports and temp dir.
  Pass your slot to every `clip.mjs` and `probe.mjs` call. Takes queue on a lock, so only one
  slot records at a time.

## Make a clip

```bash
S=--slot 1
node marketing/social/engine/clip.mjs <slug> --open $S     # app on the clip's vault, left running
node marketing/social/engine/probe.mjs $S --labels          # visible controls: role, name, box
node marketing/social/engine/probe.mjs $S --shot /tmp/a.png --width 1000 '<js with page>'
node marketing/social/engine/clip.mjs <slug> $S             # record, captions, compose, export, qa
node marketing/social/engine/clip.mjs <slug> $S --from compose   # re-cut the last take
node marketing/social/engine/clip.mjs <slug> $S --seed      # rebuild the clip's vault (after editing vault.mjs)
node marketing/social/engine/clip.mjs <slug> --close $S     # stop the app
```

`clips/<slug>/` holds:

- `narration.json`: `{"silent": true, "scenes": [{ "id", "dur", "text", "style"? }]}`. `dur` is
  the scene's length in seconds. `text` is its caption. The first scene is the **hook**: its
  caption sits above the window from the first frame, and the window grows into place when the
  hook ends. Later captions are **steps** at the bottom. `*word*` sets a word in the accent color.
  The last scene is the end card:
  `{ "id": "end", "dur": 2.4, "style": "end", "text": "free on mac, windows and linux" }`.
- `scenes.mjs`: `setup(ctx)` runs off camera before the take. `scenes.<id>(ctx)` runs each scene
  on camera. `checks` is optional: `[[what, (query) => error | null]]`, run on the app's database
  after the take. The ctx:
  - `page`: Playwright page. `L(selector)`: a locator.
  - `rec.glide(x, y, ms?)`, `rec.click(locator, { dx, dy })`, `rec.type(text, { cps })` and
    `rec.key('Enter')` drive the fake cursor and keyboard like a person.
    `rec.center(locator)` gives a locator's center.
  - `zoom(x, y, z)`, `zoomOn(locator, z, { dx, dy })` and `unzoom()` are camera marks. The
    compositor eases to them in 0.8 s.
  - `at(seconds)` waits until that many seconds into the scene. `end()` waits out the scene and
    is called for you. `sleep(ms)`.
  - Coordinates are CSS px in the 1600×900 window.
- `vault.mjs` is optional. It holds data the clip needs on top of the base vault:
  `export default async function ({ cli, vault, day, at, TIMEZONE, write, assets })`.
  - `cli(...args)` runs the app's memrynote CLI on the clip's copy of the base vault. Its flags
    are in `../memry-social-app/apps/cli/src/run.ts`.
  - `write(relPath, content)` writes a file into the vault.
  - `day(offset)` gives `YYYY-MM-DD`, and `at(offset, 'HH:MM')` gives a local ISO time.
  - `assets` is `marketing/social/vault/assets/`, for binary inputs: images, PDFs, video.
- `engine/kit.mjs` has helpers: `open(page, title)`, `closeOtherTabs`, `expandSection`,
  `expandFolder`, `settle`, `scrollTo(ctx, locator, top)` and `clickThenType`.
  `clips/tags-fields/` is the worked example.

### The base vault: Maya, a freelance designer

`vault/seed.mjs` builds it each day. Dates are relative, so Today is always full.

- **Projects:** Website Redesign (statuses Backlog, Design, Review, Done), Lisbon Trip, Home, and
  the Inbox. 27 tasks: overdue, today and this week, repeating, with subtasks.
- **Notes,** in folders:
  - Studio North: the brief, the kickoff, Homepage Ideas, Design Principles, and Studio North
    itself (the client).
  - Lisbon: packing list, ideas, itinerary.
  - People: Jonas Weber, Lea Park, Sam Okafor.
  - Meetings: Weekly sync with Sam, Brand workshop with Lea. Both are tagged `meeting`.
  - Reading: Reading List, Notes on Shape Up.
  - Ideas: Ideas backlog.
- **Links:** notes link to each other with `[[...]]`.
- **Journal:** most days of the past two weeks.
- **Calendar:** events this week, and an all-day Lisbon trip in 9 days.
- **Inbox:** three captures.

## The standard

The clips have to make someone stop scrolling, so each one must hold up on a phone with the sound
off.

- **Truthful.**
  - Everything on screen really happens in the shipped app on demo data.
  - Never fake UI, never inject DOM to fake a result, and never show a feature that isn't in
    `v2026-10-15`.
  - Off-camera setup may click through the UI and close tabs. It may not paint results.
- **Hook first.**
  - The hook caption is at most 6 words and states the payoff (`Search reads your *PDFs*`).
  - The hook scene lasts 2.5 to 3.5 s. Keep the cursor moving toward the first action.
- **Steps.**
  - At most one caption per scene, at most 6 words each.
  - Use present tense and sentence case, with no closing period.
  - Use 3 to 5 steps per clip.
- **Length:** 15 to 30 s including the end card.
- **Readable on a phone.**
  - Zoom 1.5 to 2.0 on every moment that matters, before the action starts.
  - Unzoom before moving to another part of the screen.
  - Keep the action out of the caption band: the bottom 18% while a step caption shows.
- **Pace.**
  - Type at 9 to 14 cps.
  - Leave 300 to 600 ms after an action before the next one.
  - Hold each scene's result at least 1 s.
  - The viewer should always see what changed.
- **Clean frames.**
  - No error toasts, devtools or blank states, unless the blank state is the point.
  - Only one tab open unless the clip is about tabs.
  - Sidebar sections expanded where they help.

## QA

1. After every take, open `clips/<slug>/out/qa/phone-upright.png`, the whole clip at phone size.
2. Open single stills from `qa/` whenever something looks off.
3. A clip is done when:
   - the hook frame reads on its own;
   - every step's result is visible and legible;
   - no caption covers the action;
   - nothing is broken or fake;
   - `clip.mjs` printed `1920,1080,60/1, audio streams: 0`.

## Approve

Only the orchestrator approves. After looking at a clip's QA stills:

```bash
node marketing/social/engine/approve.mjs <slug>...   # copies <slug>.mp4/.png into media/, rebuilds the checklist
node marketing/social/engine/export-kit.mjs           # CHECKLIST.md + kit/<date>/ (also run by approve.mjs)
```

`media/` holds approved media only and is tracked in git. [`CHECKLIST.md`](CHECKLIST.md) marks
each post day **hazır** (ready) or **bekliyor** (waiting). `kit/<date>/` is the local posting
folder: the day's approved media, the GIF when the local render has one, and `post.md` with the
X post, its first reply and the Reddit post.

## Rules for parallel agents

- Write only inside your own `clips/<slug>/` folders.
- If you add a file to `vault/assets/`, name it `<slug>-...`.
- Don't edit the engine, `kit.mjs`, the seeds, this README or `2026-q4.md`. Copy a helper into
  your scenes instead, and report needed copy changes to the orchestrator.
- Never stop, kill or attach to another slot's app.
  - No `pkill`, no `killall`. Kaan's own memrynote may be running.
  - No `agent-app.mjs stop` without your slot's environment. Use `clip.mjs --close`.
- No git commits, stashes, resets or checkouts. No sign-ins, and no real accounts or data.
