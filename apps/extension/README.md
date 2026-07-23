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

## Load temporary add-on in Firefox

Same WXT source, MV3 build (`--mv3` keeps `browser.action`/`host_permissions`
matching the Chrome source). Stable id comes from `browser_specific_settings.gecko`.

1. `pnpm --filter @memry/extension build:firefox`
2. Firefox → `about:debugging#/runtime/this-firefox`.
3. **Load Temporary Add-on…** → select `apps/extension/.output/firefox-mv3/manifest.json`.
4. Requires Firefox ≥ 140 (`strict_min_version`, the floor for AMO's
   `data_collection_permissions`). The `Ctrl+Shift+S` command may
   clash with Firefox's screenshot shortcut — rebind it under
   `about:addons → ⚙ → Manage Extension Shortcuts` if it doesn't fire; the popup
   button works regardless.

`pnpm --filter @memry/extension dev:firefox` launches a dev Firefox with
auto-reload (via web-ext). `zip:firefox` produces a signable artifact when you
take it to AMO.

## Load unpacked in Edge

Edge is Chromium, so the Chrome build already runs on it (same
`chrome-extension://` origin → capture pairing works unchanged). The `:edge`
scripts just produce a separately-named artifact for the Edge Add-ons store.

1. `pnpm --filter @memry/extension build:edge`
2. Edge → `edge://extensions` → enable **Developer mode**.
3. **Load unpacked** → select `apps/extension/.output/edge-mv3`.

`zip:edge` produces `.output/*-edge.zip` for submission to the Microsoft Edge
Add-ons store.

## Publishing

Submission is automated by [`.github/workflows/publish-extension.yml`](../../.github/workflows/publish-extension.yml),
triggered by pushing an `extension-v*` tag (`pnpm --filter @memry/extension release`)
or a manual **workflow_dispatch**. It runs two independent jobs:

- **Chrome** (`zip` → `submit`) → Chrome Web Store. Secrets: `CHROME_EXTENSION_ID`,
  `CHROME_CLIENT_ID`, `CHROME_CLIENT_SECRET`, `CHROME_REFRESH_TOKEN`.
- **Firefox** (`zip:firefox` → `sources:firefox` → `submit:firefox`) → AMO. Secrets:
  `FIREFOX_EXTENSION_ID` (the `gecko.id`, `web-clipper@memrynote.com`),
  `FIREFOX_JWT_ISSUER`, `FIREFOX_JWT_SECRET`.

> [!IMPORTANT]
> **Ship the desktop app first.** The extension only ever adds fields to the
> `/capture` payload, and the desktop validates that payload strictly: a newer
> extension talking to an older desktop gets a 422 on every capture using a field
> that desktop doesn't know yet (currently PDF clips, which are also never queued,
> so each one is lost). Release order is always: desktop version containing the
> contract change → then the `extension-v*` tag.

Run `pnpm --filter @memry/extension exec wxt submit init` once to obtain the store
credentials; add them as GitHub **repository secrets**. The Firefox submit step
skips (job stays green) until `FIREFOX_JWT_SECRET` exists.

### Firefox source-code review

AMO requires a rebuildable source ZIP because the add-on is bundled/minified. WXT's
own sources ZIP is incomplete in this monorepo (it omits the workspace package
`@memry/article-extract`), so `sources:firefox` builds a self-contained bundle via
[`scripts/build-extension-firefox-sources.mjs`](../../scripts/build-extension-firefox-sources.mjs):
the extension + `@memry/article-extract` + `@memry/typescript-config` + root
manifests, with a trimmed `pnpm-workspace.yaml` so a reviewer builds only those
three packages (no Electron). Verify once locally before relying on CI:

```bash
pnpm --filter @memry/extension zip:firefox
pnpm --filter @memry/extension sources:firefox   # → .output/firefox-review-sources.zip
```

**First listing is manual:** the AMO API only pushes _updates_ to an existing add-on.
Create the initial listing once via AMO's "Submit a New Add-on" wizard (upload the
`*-firefox.zip` and the sources ZIP); afterwards CI pushes every new version.

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
