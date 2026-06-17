# @memry/extension — Memry Web Clipper (Chromium MV3)

Captures the current page as a readable article and saves it to the Memry
desktop app via its localhost capture server. Built with [WXT](https://wxt.dev).

## Develop

```bash
pnpm --filter @memry/extension dev      # WXT dev server + auto-reload
pnpm --filter @memry/extension build    # production build → .output/chrome-mv3
pnpm --filter @memry/extension test     # unit tests (vitest)
pnpm --filter @memry/extension typecheck
pnpm --filter @memry/extension lint
```

## Load unpacked in Chrome

1. `pnpm --filter @memry/extension build`
2. Chrome → `chrome://extensions` → enable **Developer mode**.
3. **Load unpacked** → select `apps/extension/.output/chrome-mv3`.
4. Keep the load path stable so the extension ID (and pairing) survives reloads.

## Manual QA (the Phase-3 acceptance gate — human-required)

Run the desktop app first: `pnpm dev`.

1. **App-closed:** quit the desktop app, open the popup on any article → status
   "Memry isn't running", "Add to Memry" disabled.
2. **Pairing (in-app):** with Memry running (`pnpm dev`), open the popup on an
   article and click **Add to Memry**. The first time, Memry pops an
   **"Allow the Memry browser extension to save captures?"** dialog → click
   **Allow**. The capture then lands in the inbox. Subsequent captures are
   silent. No `memry://` needed for pairing.
   If Allow does nothing, check the desktop logs for `/pair/request`.
3. **Capture:** open the popup on a real article → properties + body fill in.
   Edit the title/tags → "Add to Memry" → "Added to inbox ✓". Confirm a new
   link item appears in the desktop inbox with the article body + properties.
4. **Failed extraction:** open the popup on a non-article page (e.g. a web app)
   → "Couldn't read this page — saving the link and title." Saving still works.
5. **Launch when closed:** quit Memry, open the popup on any page, click
   **Open Memry & save** → Chrome prompts to open Memry → the app starts,
   click Allow (first time), and the capture lands in the inbox. Button shows
   "Opening Memry…" while polling; times out after 20 s with an error if the
   app never came up.
   **macOS `pnpm dev`:** run `pnpm --filter @memry/desktop dev:protocol` once
   so the dev Electron registers `memry://`, or test this path against a
   packaged build.
6. **Origin header check (the known risk):** if `/capture` returns 401
   `origin-not-allowed`/`bad-token` despite a successful pair, Chrome is not
   attaching `Origin: chrome-extension://<id>` on the background fetch — verify
   in DevTools → background service worker → Network.
