# MemryNote Mascot Icons — Creation Guide

How to create a new hand-drawn mascot icon that matches the existing set, wire it into the
landing site, and ship its dark-theme variant. Written so a fresh session (human or agent)
can go from "make me a _thoughts_ icon" to a merged, theme-aware PNG without rediscovering
anything.

## What exists

- **Files:** `apps/landing/public/mascots/*.png` (light) + `apps/landing/public/mascots/dark/*.png`
  (dark, same filenames). `all.png` is the original 1024×1024 source sheet — never delete it.
- **Component:** `src/components/ui/mascot.tsx` renders both variants and swaps on the `.dark`
  class. It derives the dark path automatically (`/mascots/x.png` → `/mascots/dark/x.png`),
  so a new icon MUST exist in both folders.
- **Used in:** `EverythingRow.tsx` chips (32px), `UseCasesGallery.tsx` persona cards (64px),
  Header Features/Download dropdowns (32px, via `iconType: 'image'` items in `lib/constants.ts`).

## Style DNA

Match ALL of these or the icon will look like a stranger in the set:

| Property   | Value                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------ |
| Canvas     | ~96×96 px, transparent background (set ranges 75–135 px)                                         |
| Stroke     | ink `rgb(43,42,40)`, ~3.5–3.8 px wide at 96 px scale, wobbly, round caps                         |
| Accent     | exactly **one** terracotta element per icon — fill `rgb(247,148,80)` / sampled `rgb(251,152,84)` |
| Interiors  | transparent (paper shows through). Fine on light AND dark; do not fill with white                |
| Texture    | comes from drawing at 4× and downscaling with LANCZOS — never draw at 1×                         |
| Silhouette | must read at 32 px. One object + at most one small companion (sparkle, heart, dot)               |

Dark variant = same alpha, ink recolored to `#bcbab6` (the dark-theme `--color-ink`),
terracotta untouched. Generated, never hand-made — see step 4.

## Tooling setup (once per session)

Python + Pillow + numpy, no repo deps:

```bash
python3 -m venv /tmp/mascot-venv && /tmp/mascot-venv/bin/pip install -q pillow numpy
PY=/tmp/mascot-venv/bin/python
MASCOTS=apps/landing/public/mascots
```

## Creating a new mascot — three routes, in order of preference

### Route 1: it's already on the sheet

Open `public/mascots/all.png`. The sheet has 21 icons; several are **not used anywhere yet**
(search/filter/favorite/share/lock/more/settings/help/change-log/roadmap…). If the concept
matches one, it's already sliced — just wire it up. If the sheet ever grows, re-slice with
`slice_sheet.py <sheet.png> <outdir>` (row bands + column clustering; adjust the `ROWS`
bands if the layout changes).

### Route 2: collage from existing parts (best fidelity — prefer this)

Real pixels from the set always beat synthesis. `compose_from_parts.py` shows the full
pattern (it built `ai-agent.png` = feedback bubble − heart + adhd-brain sparkles):

1. Load donor PNGs, take `alpha > 100` as mask, split into 8-connected components
   (helper in the script). Sort by size; identify parts by size/bbox/orange-fraction.
2. Extract a part with a per-pixel mask + 2 px dilation (keeps anti-aliased fringe) —
   never a bare bbox crop, parts overlap.
3. Erase donor elements the same way (set alpha 0 under dilated mask).
4. Scale parts with LANCZOS (≤ ~1.6× upscale before strokes go soft), recolor a part to
   terracotta by overwriting RGB and keeping alpha.
5. Compose on a transparent canvas sized like the set.

**Parts inventory** (donor → extractable components):

| Donor                            | Parts                                                                |
| -------------------------------- | -------------------------------------------------------------------- |
| `feedback.png`                   | speech bubble (outline), orange heart (outlined, ~34 px)             |
| `adhd-brain.png`                 | brain cloud, black plus-sparkle, small 4-point star, orange squiggle |
| `favorite.png`                   | star outline, small orange filled star                               |
| `maker.png`                      | person at laptop, tiny orange heart on lid                           |
| `search.png` / `researchers.png` | magnifier (small / large)                                            |
| `notes.png`                      | open book + orange underline bar                                     |
| `change-log.png`                 | document page + small clock                                          |
| `more.png`                       | ink dots + one orange dot                                            |

Concept riffs: _thoughts_ → feedback bubble + small bubbles, or brain cloud alone;
_organize_ → inbox tray + checklist marks from tasks; _sync_ → share arrow mirrored;
_ideas_ → bubble + favorite's orange star.

### Route 3: synthesize with the wobble toolkit (when no parts fit)

`synth_wobble.py` built desktop/mobile/cli/web-clipper. It gives `stroke()` (wobbly
polyline, 4× supersampled), `fill_poly()` (terracotta fills), `rrect()` (rounded-rect
perimeter), and borrows the real heart from `feedback.png` for warmth. Copy an icon block
and describe the new shape in ~4–8 strokes.

Hard-won calibration — do not "improve" these numbers without a side-by-side check:

- `width=3.7`, `wobble amp=1.5`, `S=4`. The first attempt used 3.1/1.1 and read as a
  clean vector stranger next to the textured originals.
- Distinct `seed` per stroke, or parallel strokes wobble identically and look printed.
- Accent shapes (cursor, pivot dot, home bar) are plain terracotta fills without outline —
  matching the set's orange bars/squiggles.

## Mandatory finishing steps (every new icon)

1. **QA contact sheet:** paste the new icon between 2–3 real ones (e.g. `calendar.png`,
   `lock.png`) on cream `#faf1e6` AND dark `#3a3a3a` rows; also render a 4× NEAREST zoom.
   Check: stroke weight matches, one orange accent, nothing kisses an outline, reads at 32 px.
2. **Dark variant:** `$PY gen_dark.py $MASCOTS <qa-outdir>` — regenerates `dark/` for every
   icon, idempotent, skips the sheets. Never ship a light-only mascot: `Mascot` will 404 its
   dark path.
3. **Wire up:** chips/cards use `<Mascot src="/mascots/<name>.png" className="h-8 w-8" />`;
   dropdown items in `lib/constants.ts` use `{ icon: '/mascots/<name>.png', iconType: 'image' }`.
4. **Verify:** `pnpm --filter ./apps/landing typecheck`, then dev server + Playwright
   screenshot. Gotcha: sections animate with `whileInView` — a plain full-page screenshot
   captures them invisible; scroll the page in ~250 px steps first, then shoot the element.
   Check light AND dark (`document.documentElement.classList.add('dark')`).

## Naming

Kebab-case concept nouns, no prefixes: `notes.png`, `ai-agent.png`, `web-clipper.png`.
The filename is the public URL (`/mascots/<name>.png`) and the dark twin must match exactly.
