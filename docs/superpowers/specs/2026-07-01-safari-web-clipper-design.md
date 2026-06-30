# Safari Web Clipper (macOS, Mac App Store)

Date: 2026-07-01
Status: Design approved, pending spec review

## Summary

Ship the existing MemryNote Web Clipper as a **Safari Web Extension on macOS**,
distributed through the **Mac App Store** inside a native container app. Reuse the
current WXT MV3 bundle unchanged. The only product code change is adding the Safari
extension-origin scheme to the desktop capture server's allowlist. Everything else is
build/packaging (Xcode) and distribution (signing, notarization, App Store Connect).

Out of scope: iOS/iPadOS (no local desktop app to reach over loopback — would require a
separate sync-server upload path), and a custom container app UI.

## Background

The clipper (`apps/extension`, WXT) reads the current page into a readable article and
`POST`s it to the desktop app's localhost capture server (`http://127.0.0.1`, ports
7849–7856). Requests are authorized by:

- a bearer token minted in the desktop keychain and stored in the extension's
  `storage.local` after pairing, and
- an `Origin` header allowlist. `EXTENSION_ORIGIN_PREFIXES` in
  `apps/desktop/src/main/capture/auth.ts` currently accepts `chrome-extension://` and
  `moz-extension://`. The exact paired origin is stored (`captureAllowedOrigins`) and
  matched on every `/capture`.

Chrome, Edge, and Firefox all run from the one WXT source. Safari is the same
WebExtension API surface, but Apple requires it to be delivered as a macOS app.

## Why Safari is different

- There is **no standalone Safari extension store**. A Safari extension ships inside a
  macOS `.app` (the "container app"). Users install the app from the Mac App Store, open
  it once, then enable the extension in Safari → Settings → Extensions.
- WXT can **build** a Safari target (`wxt build -b safari`) but cannot **publish** it.
  Packaging into the native app is done with Apple's Xcode CLI
  (`xcrun safari-web-extension-packager`).
- The extension's origin is `safari-web-extension://<UUID>`, where the UUID is assigned
  at install and is **stable for the life of that install** — so the existing
  token + stored-origin pairing model works without change.

## Approach

Reuse the WXT bundle; commit one generated Xcode wrapper.

- Add `dev:safari` / `build:safari` / `zip:safari` scripts mirroring the existing
  Firefox scripts. Build MV3 (`--mv3`) so `browser.action`, `host_permissions`, and the
  service worker match the Chrome/Firefox source. Safari 16.4+ supports MV3.
- Run `safari-web-extension-packager` **once** to generate the macOS container app +
  extension target into `apps/extension/safari/`, then commit it. Icons, entitlements,
  and signing config live there and are maintained by hand from then on.
- Add `safari-web-extension://` to the server allowlist.

Rejected alternatives:

- **Separate `apps/safari` package + CI notarize lane** — more infrastructure than a
  per-release native build needs.
- **Regenerate the Xcode project on every build** — would discard icons, entitlements,
  and signing config each regen; hostile to a signed App Store target.

## Changes

### 1. Capture server origin allowlist (the only product code change)

`apps/desktop/src/main/capture/auth.ts`:

```ts
const EXTENSION_ORIGIN_PREFIXES = [
  'chrome-extension://',
  'moz-extension://',
  'safari-web-extension://'
]
```

No other change in `auth.ts`, `pairing.ts`, or `server.ts`. `isExtensionOrigin` gates
`/pair/request` and `/pair/claim`; `isOriginAllowed` stores and matches the exact
`safari-web-extension://<UUID>` after the user clicks Allow. The "single source of truth"
comment on `EXTENSION_ORIGIN_PREFIXES` continues to hold.

Test: extend `apps/desktop/src/main/capture/auth.test.ts` to assert a
`safari-web-extension://<uuid>` origin passes `isExtensionOrigin` and that pairing +
`validateCaptureRequest` accept it end to end.

### 2. Build scripts

`apps/extension/package.json` — add, mirroring the `:firefox` scripts:

```jsonc
"dev:safari":   "wxt -b safari --mv3",
"build:safari": "wxt build -b safari --mv3",
"zip:safari":   "wxt zip -b safari --mv3"
```

Output: `.output/safari-mv3`. No `wxt.config.ts` change expected — the existing manifest
(`storage`, `activeTab`, `alarms`, `host_permissions: http://127.0.0.1/*`, the
`capture-page` command) is valid for Safari. Confirm during build that WXT does not warn
on any of these for the Safari target; adjust per-browser via WXT's manifest hook only if
it does.

### 3. Native wrap (run once, then committed)

```sh
pnpm --filter @memry/extension build:safari
xcrun safari-web-extension-packager .output/safari-mv3 \
  --macos-only \
  --app-name "MemryNote Web Clipper" \
  --bundle-identifier com.memrynote.web-clipper \
  --copy-resources
```

- Container app bundle id: `com.memrynote.web-clipper`; extension target:
  `com.memrynote.web-clipper.extension`. Same Apple Developer team as the desktop app
  (`com.memrynote.memry`).
- `--copy-resources` copies the built bundle into the Xcode project so it is
  self-contained at archive time.
- Lightly brand the generated "enable me in Safari Settings" screen and add an app icon.
  No further container UI.
- Output project committed at `apps/extension/safari/`.

Re-release flow: `build:safari` → re-run the packager (or copy `.output/safari-mv3` over
the project's resources) → bump version → archive.

### 4. App Store entitlements (required, non-obvious)

App Store distribution requires the App Sandbox. The extension's background `fetch` to
`127.0.0.1` is an outbound connection and is **blocked under the sandbox without the
network-client entitlement**. The extension target's entitlements must include:

```xml
<key>com.apple.security.app-sandbox</key><true/>
<key>com.apple.security.network.client</key><true/>
```

No App Group is needed — the extension talks only to localhost, not to the container app.

### 5. Distribution (Mac App Store)

Mostly manual Apple-portal work, documented as a release runbook in
`apps/extension/README.md`:

1. App Store Distribution certificate + provisioning profiles for both the app and the
   extension target.
2. Xcode archive → upload via Organizer (or `xcrun notarytool` + Transporter).
3. App Store Connect record: description, screenshots, and a **privacy nutrition label of
   "Data Not Collected"** — captures stay local, which matches the MemryNote privacy
   story.
4. Submit for review.

### 6. User install flow (documented in README)

1. Install **MemryNote Web Clipper** from the Mac App Store.
2. Open the app once → "Enable me in Safari" screen.
3. Safari → Settings → Extensions → toggle MemryNote on → grant access to `127.0.0.1` /
   websites.
4. First capture triggers the same in-app **Allow** pairing dialog as Chrome/Firefox;
   captures then land in the inbox.

## Acceptance gate (the known risk — validate first)

Mirrors the Chrome `Origin`-header risk already noted in `apps/extension/README.md`.
Before any App Store work, validate on real Safari with a **locally dev-signed** build
that the background `fetch` to the capture server:

1. attaches `Origin: safari-web-extension://<UUID>`, and
2. is permitted to reach loopback HTTP under the App Sandbox / App Transport Security.

If Safari strips the `Origin` header or blocks the loopback request, this is a design
pivot (e.g. a different auth signal or a transport change) — so it gates everything
downstream.

## Open items to resolve in the plan

- Whether the `Cmd+Shift+S` (`capture-page`) command needs the same "may clash, rebind in
  settings" caveat Firefox has, or fires cleanly in Safari. The popup button works
  regardless.
- Whether WXT emits any Safari-target manifest warnings that need a per-browser manifest
  hook.

## Testing

- **Unit:** `isExtensionOrigin` / pairing / `validateCaptureRequest` accept the Safari
  scheme (`auth.test.ts`).
- **Manual QA (human-required):** re-run the 6-step acceptance gate in
  `apps/extension/README.md` in Safari — app-closed, pairing, capture, failed extraction,
  launch-when-closed, and the Origin-header check.

## Distinguishing code vs. manual work

- **Code/automatable:** allowlist line + test, build scripts, committed Xcode project,
  entitlements, README runbook.
- **Manual (Apple portal / human):** certificates, archive upload, App Store Connect
  listing, screenshots, privacy label, review, and the Safari manual-QA gate.
