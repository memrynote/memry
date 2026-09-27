# memrynote: App Store screenshots (iPhone)

Six screenshots drawn as one 7920x2868 panorama, then cut into six 1320x2868 frames (iPhone 6.9"). One orange thread runs through all six, so the set reads as a single strip when someone swipes through it. It starts as the full stop of the hero headline and ends in the lock on the last frame, the same idea as the 30s explainer.

## Script

| #   | Label                  | Headline                                | Subline                                                           | Screen                                                     |
| --- | ---------------------- | --------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------- |
| 1   | memrynote lockup       | Your thoughts, _beautifully_ organized. | Notes, tasks, journal and inbox. One calm, private place.         | Note "Lisbon, finally." + voice memo and task cards        |
| 2   | 01 · CAPTURE           | _Catch_ it before it's gone.            | Links, photos, voice memos. Sort them when you're ready.          | Inbox + on-device voice recording, shared link card        |
| 3   | 02 · NOTES             | _Write_ it down.                        | A quiet editor where every idea links to the next.                | Note with properties, table, backlinks + Packing list card |
| 4   | 03 · TASKS             | _Break_ it down.                        | Type it the way you'd say it. The date sorts itself out.          | Today list + natural-language quick add                    |
| 5   | 04 · JOURNAL           | _Live_ it. Then relive it.              | One quiet page a day, and everything that happened on it.         | Journal day page + month card                              |
| 6   | 05 · PRIVATE BY DESIGN | Only _you_ can read it.                 | End-to-end encrypted. Works offline. Syncs to your other devices. | Dark note turning into ciphertext: "What the server sees"  |

The story stays the same across all six frames, so people who look again find it still holds up: one Lisbon trip in May 2026. Mina, the ferry, tram 28, the tile shop, and the sunset at Senhora do Monte all show up on more than one screen.

Every screen shows something the iOS app does today: the Notes/Home/Tasks/Journal/More tabs, inbox capture with on-device transcription, note properties and backlinks, natural-language quick add, the journal day page with its warm header, and dark mode. The desktop-only Calendar and AI agent are left out on purpose.

## Rebuild

Needs Playwright's Chromium and `sharp` (both already in the repo root `node_modules`). Fonts and the logo come from `../explainer-30s/`.

```bash
node render.mjs          # out/01-hero.png ... out/06-private.png (1320x2868), out/6.5in/* (1284x2778)
node render.mjs --sheet  # also out/sheet.jpg, a contact sheet of the whole strip
open index.html          # live preview of the panorama
```

`icons.js` is generated from lucide-react 0.562.0 (ISC). The exported PNGs are opaque RGB, which is what App Store Connect expects.
