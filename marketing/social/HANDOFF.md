# Handoff: memrynote fall social series media

Continue Kaan's task: generate the media for every post in the fall social series, then report.
Talk to Kaan in Turkish, briefly. **Don't ask him questions; decide yourself.** Continue until all
media is done. Posting to X and Reddit, and automating it, is out of scope. Commit only if Kaan
asks.

## Where things are

- **Work checkout:** `/Users/h4yfans/workspace/personal/memry-social`.
  - Git worktree on branch `feat/social-q4-clips`, created from origin/main. Everything is uncommitted.
  - Leave `/Users/h4yfans/workspace/personal/memry` alone; other sessions use it.
- **Build being filmed:** `/Users/h4yfans/workspace/personal/memry-social-app`, detached at tag
  `v2026-10-15`, with the desktop build already made. Only features shipped in that build may be
  shown.
- **Before any `clip.mjs` or `probe.mjs` call:**
  `export MEMRY_SOCIAL_APP=/Users/h4yfans/workspace/personal/memry-social-app`
- **Read first, in full:**
  - `marketing/social/README.md`: how a clip is made, the quality standard, rules for parallel agents.
  - `marketing/social/2026-q4.md`: the timeline, the Clips table and all post copy. Only you, the
    orchestrator, edit this file.
- **Engine** (`marketing/social/engine/`):
  - `clip.mjs`: one clip, end to end.
  - `kit.mjs`: scene helpers. `probe.mjs`: explore the running app.
  - `captions.mjs` and `caption.html`: hook, step and end captions.
  - `terminal.html`: terminal replays.
  - `montage.mjs`: compilations.
  - `export-kit.mjs`: per-day posting folders.
  - `check-posts.mjs`: X copy limits.
  - Base vault: `marketing/social/vault/seed.mjs`. It is Maya, a freelance designer, rebuilt daily
    under `/tmp/memry-social/vaults/<date>/`.
- **Changes made to the tutorial engine, `marketing/tutorials/`:**
  - `record.mjs`: silent mode, and filming an external page.
  - `compose.py`: hook layout and burned-in captions.
  - `pw.mjs` and `app.mjs`: ports per slot; startApp waits for the window.
  - `rec.mjs`: the cursor follows pointermove.
  - `vault/seed.mjs`: `MEMRY_APP`.
  - Regression check: the tutorial compose picture stage passes. The sound stage fails only
    because the main checkout lacks `vo/hubcapture.mp3`, which predates this work.
- **Media output:** `marketing/social/clips/<slug>/out/<slug>.{mp4,gif,png}` plus `out/qa/`
  stills. The output folders are gitignored.

## Status at handoff (Oct 17)

The live status of each post day is in [`CHECKLIST.md`](CHECKLIST.md).

To approve a clip after its QA, run `node marketing/social/engine/approve.mjs <slug>...`. It does
three things:

- copies the clip's `.mp4` and `.png` into `media/`, which git tracks;
- rebuilds `CHECKLIST.md`;
- rebuilds `kit/`.

Commit `media/` and `CHECKLIST.md` together with the clip sources. Push to main only when Kaan
says so.

**Final:** 17 clips, QA'd and approved, with copy fixes applied. They are in `media/`.

- tags-fields, files-terminal, cli, pricing, roadmap, github
- pdf-search, tasks-inline, columns-callouts, themes, tour
- inbox-triage, journal-day, note-task-calendar, calendar-sources, timeline-view, day-panel

These cover every post from Oct 20 to Nov 1, plus Nov 19, 21, 22 and 27 and Dec 26 and 29.

**MP4 exists but is unverified.** Its agent stopped mid-iteration. For each one, look at
`out/qa/phone-upright.png` and check the clip against its post copy. Keep it or re-record it.

- **W3:** backlinks, graph-edit, canvas-live, canvas-sections, similar-notes (also used Dec 17),
  whiteboard-block
- **W4:** math-mermaid, covers, view-blocks, templates, code-blocks, lock-notes
- **W5:** import-sources, import-checklists, obsidian-vault, activity-log
- **W6:** repeat-tasks, start-dates
- **W7:** quick-capture, project-hub, kanban, tasks-by-source
- **W8:** search-redesign
- **W9:** agent-approve, e2e-explainer
- **W10:** property-heatmap
- **W11:** year-end-journal
- **F1:** iphone

**Partial:** scenes or narration exist. Finish these.

- wiki-links (W3), image-crop (W4), nested-subtasks (W7), new-year-project (W11), server-sees (W9
  diagram)
- narration only: journal-random-line, home-dashboard, snooze-remind (W6); agent-backends,
  calm-toggles, export-clean (W9)

**Not started:**

- multi-tag, weekly-review (W7)
- shortcuts, tabs-split, vault-switcher, settings-search, video-attach, bookmarks (W8)
- year-review, apple-journal-import, book-tag, duck-canvas, journal-folders (W10)

**Compilations:** none built yet, run last.

- `montage-fall`, `montage-2026` (lists in their `montage.json`)
- `week-01` … `week-11`

Build each with `node marketing/social/engine/clip.mjs <slug>`. Every clip a compilation cuts from
must be approved first. `week-01` and `week-02` can be built and approved now, because all their
clips are final.

## How to continue

1. **Use subagents, at most 3 at a time.** Eleven at once hit the API rate limit (429) and all
   died.
   - Give each subagent one slot (1 to 12) and one week's worth of clips.
   - Tell it to read the README and the Clips table, and the week's section in `2026-q4.md` (find
     it with `grep -n "^## Week"`).
   - It verifies each feature in the v2026-10-15 source: en locale strings, the renderer, release
     notes.
   - It writes `vault.mjs` for clip data, records, and QAs the phone sheet. Two to four takes,
     then it stops.
   - It never fakes UI.
   - It reports per clip: duration, path, and any copy deviation with exact replacement text.
     Subagents write only inside their own `clips/<slug>/` folders and `vault/assets/<slug>-*`.
   - Their predecessors' transcripts hold their findings. Tail one only when a clip's state is
     unclear:
     `/Users/h4yfans/.pi/agent/pstack/01a14765-8232-7183-892f-656e6115fc2c/agents/`
     - W3: `…02-52-55-417Z_501c…`
     - W4: `…03-16-12-370Z_5fc8…`
     - W5+W11: `…03-34-03-360Z_ff6c…`
     - W6: `…03-16-12-353Z_bbac…`
     - W7: `…03-16-12-391Z_7a3d…`
     - W8: `…03-34-03-369Z_96ff…`
     - diagrams + iphone: `…03-34-03-441Z_f527…`
     - W9: `…03-38-29-191Z_4aa3…`
     - W10: `…03-38-29-179Z_0287…`
2. **Order:** by posting date. W3, W4, W5 and W6 first, then W7, W8, W9, W10, W11.
3. **Special clips:**
   - **Agent clips (W9):** may use the Claude Code CLI already installed and signed in
     (`/Users/h4yfans/.local/bin/claude`) against the demo vault.
   - **File-picker flows** (imports, PDF export): stub `dialog.showOpenDialog` or
     `dialog.showSaveDialog` through `agent-app.mjs eval`, using the slot's env: `TMPDIR` and
     `MEMRY_AGENT_INSPECT_PORT=9229+10*slot`.
   - **Network:** calendar-sources, inbox-triage and the live web clips need it.
4. **Copy changes.** Apply each one to `2026-q4.md`, then run
   `node marketing/social/engine/check-posts.mjs`. It must print `ok`. X copy is at most 280
   characters, has no `@` or `#` (X turns them into mentions), and has no links.
5. **Finish:**
   - Approve each clip after its QA.
   - Build the compilations, then approve them.
   - Run `node marketing/social/engine/export-kit.mjs`. It must print `all media present`.
   - Do a final pass over every `out/qa/phone-upright.png`.
   - Check every MP4 is `1920,1080,60/1, audio streams: 0`.
   - Report to Kaan in Turkish: counts, paths, anything missing.

## Engine facts that bite

- **Takes run one at a time,** on the lock `/tmp/memry-social/record.lock`. A lock left by a dead
  pid clears itself.
- **Each slot has its own app** under `/tmp/memry-social/slot-N`, on ports `9222+10*N` (CDP) and
  `9229+10*N` (inspector). Stop it with `clip.mjs <slug> --close --slot N`. Never use pkill or
  killall; Kaan's own memrynote may be running.
- **`narration.json`:**
  `{"silent": true, "scenes": [{id, dur, text, style?}]}`. The first scene is the hook, which
  sits above a smaller window. The last scene is
  `{"id":"end","dur":2.4,"style":"end","text":"free on mac, windows and linux"}`.
  `"page": "<html | https URL>"` films a page instead of the app.
- **`clip.mjs` flags:**
  - `--open` leaves the app running for probing.
  - `--seed` rebuilds the clip's vault after you edit `vault.mjs`.
  - `--from compose` re-cuts the last take.
- **The app shows the recording date** (Oct 17) in its UI. That is accepted.
