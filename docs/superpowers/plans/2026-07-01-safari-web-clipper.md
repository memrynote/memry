# Safari Web Clipper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the existing MemryNote Web Clipper as a Safari Web Extension on macOS, distributed through the Mac App Store inside a native container app.

**Architecture:** Reuse the current WXT MV3 extension bundle unchanged. The only product code change is adding the `safari-web-extension://` origin scheme to the desktop capture server's allowlist. Safari packaging is a committed Xcode container-app project generated once with `safari-web-extension-packager`; distribution is manual Apple-portal work documented as a runbook.

**Tech Stack:** WXT (web extension build), Vitest (unit tests), Xcode `safari-web-extension-packager` (native wrap), App Store Connect (distribution).

## Global Constraints

- Container app bundle id: `com.memrynote.web-clipper`; extension target: `com.memrynote.web-clipper.extension`. Same Apple Developer team as the desktop app (`com.memrynote.memry`).
- Build Safari as **MV3** (`--mv3`) to match the Chrome/Firefox source. Requires Safari 16.4+.
- Extension origin is `safari-web-extension://<UUID>`, stable per install.
- App Store distribution requires App Sandbox; the loopback `fetch` needs `com.apple.security.network.client`.
- Code style: single quotes, no semicolons, 100-char width, no trailing commas.
- macOS-only. No iOS. No custom container app UI beyond the generated enable screen + icon.

---

### Task 1: Add the Safari origin scheme to the capture server allowlist

**Files:**
- Modify: `apps/desktop/src/main/capture/auth.ts:13`
- Test: `apps/desktop/src/main/capture/auth.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `isExtensionOrigin(origin: string | undefined): boolean` now returns `true` for `safari-web-extension://*`. No signature change. `EXTENSION_ORIGIN_PREFIXES` gains a third entry.

- [ ] **Step 1: Write the failing test**

Add this block to the end of `apps/desktop/src/main/capture/auth.test.ts`, and add `isExtensionOrigin` to the existing import on line 2 (`import { validateCaptureRequest, isExtensionOrigin } from './auth'`):

```ts
describe('isExtensionOrigin', () => {
  it('accepts a Safari web-extension origin', () => {
    expect(isExtensionOrigin('safari-web-extension://A1B2C3D4-0000-0000-0000-000000000000')).toBe(
      true
    )
  })
  it('accepts chrome and firefox extension origins', () => {
    expect(isExtensionOrigin('chrome-extension://abc')).toBe(true)
    expect(isExtensionOrigin('moz-extension://abc')).toBe(true)
  })
  it('rejects a web origin and undefined', () => {
    expect(isExtensionOrigin('https://evil.com')).toBe(false)
    expect(isExtensionOrigin(undefined)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:main auth.test.ts`
Expected: FAIL on "accepts a Safari web-extension origin" — `expected false to be true` (the other cases pass).

- [ ] **Step 3: Add the Safari scheme**

In `apps/desktop/src/main/capture/auth.ts`, replace the `EXTENSION_ORIGIN_PREFIXES` definition (line 13) and its comment so it reads:

```ts
// Capture pairing accepts browser-extension origins only — Chromium (chrome-extension://),
// Firefox (moz-extension://), and Safari (safari-web-extension://). Single source of truth
// so the two pairing guards can't drift.
const EXTENSION_ORIGIN_PREFIXES = [
  'chrome-extension://',
  'moz-extension://',
  'safari-web-extension://'
]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/desktop test:main auth.test.ts`
Expected: PASS — all `validateCaptureRequest` and `isExtensionOrigin` cases green.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/capture/auth.ts apps/desktop/src/main/capture/auth.test.ts
git commit -m "feat(capture): allow safari-web-extension origins"
```

---

### Task 2: Add WXT Safari build scripts

**Files:**
- Modify: `apps/extension/package.json:8-15` (scripts block)
- Modify: `apps/extension/README.md` (add a Safari build section)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `pnpm --filter @memry/extension build:safari` emits an MV3 bundle at `apps/extension/.output/safari-mv3/`. Later tasks (native wrap) consume that directory.

- [ ] **Step 1: Add the Safari scripts**

In `apps/extension/package.json`, add these three lines to the `scripts` block, immediately after the matching `:firefox` scripts (`dev:firefox`, `build:firefox`, `zip:firefox`):

```jsonc
"dev:safari": "wxt -b safari --mv3",
"build:safari": "wxt build -b safari --mv3",
"zip:safari": "wxt zip -b safari --mv3",
```

- [ ] **Step 2: Run the build**

Run: `pnpm --filter @memry/extension build:safari`
Expected: build succeeds; `apps/extension/.output/safari-mv3/manifest.json` exists. Watch the build output for any WXT warning about an unsupported manifest key on the Safari target (`storage`, `activeTab`, `alarms`, `host_permissions`, `commands`). Note any warning for the open-items follow-up; do not change the manifest unless WXT errors.

- [ ] **Step 3: Verify the manifest is MV3**

Run: `node -e "console.log(require('./apps/extension/.output/safari-mv3/manifest.json').manifest_version)"`
Expected: prints `3`.

- [ ] **Step 4: Document the Safari build**

Add a "## Build for Safari (macOS)" section to `apps/extension/README.md` after the Edge section:

```markdown
## Build for Safari (macOS)

Safari ships the extension inside a native macOS app. WXT builds the bundle; Xcode wraps it.

1. `pnpm --filter @memry/extension build:safari` → `.output/safari-mv3` (MV3, matching the
   Chrome/Firefox source).
2. Wrap it into the macOS container app (see the Xcode project at `apps/extension/safari/`).

`build:safari` only produces the web bundle — the native app, signing, and App Store
submission are covered by the Safari release runbook below.
```

- [ ] **Step 5: Commit**

```bash
git add apps/extension/package.json apps/extension/README.md
git commit -m "build(extension): add Safari MV3 build scripts"
```

---

### Task 3: Generate, brand, and entitle the macOS container app (manual — macOS + Xcode)

> Human-run on macOS with Xcode installed. Not an agent TDD task. The deliverable is the committed Xcode project; a reviewer accepts or rejects it as a whole.

**Files:**
- Create: `apps/extension/safari/**` (generated Xcode project — committed)
- Modify: the extension target's `.entitlements` inside that project

**Interfaces:**
- Consumes: `apps/extension/.output/safari-mv3/` from Task 2.
- Produces: an Xcode project that builds a macOS app `MemryNote Web Clipper` (`com.memrynote.web-clipper`) containing the extension target (`com.memrynote.web-clipper.extension`) with the network-client entitlement.

- [ ] **Step 1: Generate the wrapper**

```bash
pnpm --filter @memry/extension build:safari
cd apps/extension
xcrun safari-web-extension-packager .output/safari-mv3 \
  --macos-only \
  --app-name "MemryNote Web Clipper" \
  --bundle-identifier com.memrynote.web-clipper \
  --copy-resources \
  --no-open \
  --force
```
Expected: a new `MemryNote Web Clipper/` Xcode project is created. Move/rename it to `apps/extension/safari/` so the path matches this plan.

- [ ] **Step 2: Set bundle ids and team**

Open `apps/extension/safari/*.xcodeproj` in Xcode. Set:
- App target bundle id → `com.memrynote.web-clipper`
- Extension target bundle id → `com.memrynote.web-clipper.extension`
- Both targets' Team → the MemryNote Apple Developer team (same as `com.memrynote.memry`).

- [ ] **Step 3: Add the network-client entitlement**

In the **extension** target's `.entitlements` file, add (keep the sandbox key the template already added):

```xml
<key>com.apple.security.app-sandbox</key>
<true/>
<key>com.apple.security.network.client</key>
<true/>
```
Verify in Xcode → extension target → Signing & Capabilities that **App Sandbox** is present and **Outgoing Connections (Client)** is checked.

- [ ] **Step 4: Brand the enable screen + icon**

Replace the generated app icon set with the MemryNote icon. Edit the generated container app's HTML/strings so the enable-instructions text reads for MemryNote (the "Turn on MemryNote Web Clipper in Safari Settings" screen). No other container UI.

- [ ] **Step 5: Confirm it builds**

In Xcode, select the app scheme → Product → Build.
Expected: build succeeds for both targets, signed with the development certificate.

- [ ] **Step 6: Commit**

```bash
git add apps/extension/safari
git commit -m "build(extension): add Safari macOS container app project"
```

---

### Task 4: Acceptance gate — verify loopback capture works in Safari (manual QA, go/no-go)

> Human-run on macOS. This is the known risk and gates all distribution work. Do it before Task 5.

**Files:** none (verification only).

**Interfaces:**
- Consumes: the dev-signed build from Task 3 and the running desktop app.

- [ ] **Step 1: Run the desktop app**

Run: `pnpm dev` (and once on macOS dev: `pnpm --filter @memry/desktop dev:protocol` so `memry://` is registered).

- [ ] **Step 2: Install + enable the Safari extension**

In Xcode, Run the container app. Then Safari → Settings → Extensions → enable **MemryNote Web Clipper** → grant access to `127.0.0.1` / websites when prompted.

- [ ] **Step 3: Pair and capture**

Open the popup on a real article → click **Add to Memry** → click **Allow** in the desktop pairing dialog the first time → confirm the capture lands in the inbox.

- [ ] **Step 4: Verify the Origin header + loopback (the risk)**

In Safari → Develop → Web Extension Background Content → Network (or the desktop logs for `/capture`), confirm:
- the background `fetch` to `127.0.0.1` is sent (not blocked by sandbox/ATS), and
- it carries `Origin: safari-web-extension://<UUID>`.

Expected: `/capture` returns 200 and the item appears in the inbox.

**Go/no-go:** if Safari strips the `Origin` header or blocks the loopback request, STOP — this is a design pivot (different auth signal or transport). Record the finding and do not proceed to Task 5.

- [ ] **Step 5: Re-run the full manual QA gate**

Run the 6-step acceptance gate from `apps/extension/README.md` in Safari: app-closed, pairing, capture, failed extraction, launch-when-closed, origin-header check. All must pass.

---

### Task 5: App Store distribution + install docs (manual Apple portal + doc)

> Steps 1–4 are human-run Apple-portal work. Step 5 (docs) is agent-runnable.

**Files:**
- Modify: `apps/extension/README.md` (install flow + release runbook)

**Interfaces:**
- Consumes: the verified build from Task 4.

- [ ] **Step 1: Signing assets**

Create an App Store Distribution certificate and provisioning profiles for both the app and the extension targets in the Apple Developer portal. Select them in Xcode → Signing & Capabilities (Release).

- [ ] **Step 2: Archive + upload**

Xcode → Product → Archive → Organizer → Distribute App → App Store Connect (or `xcrun notarytool` + Transporter). Expected: the build appears in App Store Connect.

- [ ] **Step 3: App Store Connect listing**

Create the app record: name, description, screenshots, and a **privacy nutrition label of "Data Not Collected"** (captures stay local).

- [ ] **Step 4: Submit for review.**

- [ ] **Step 5: Document install flow + runbook**

Add to `apps/extension/README.md` a "## Install (Safari, Mac App Store)" section:

```markdown
## Install (Safari, Mac App Store)

1. Install **MemryNote Web Clipper** from the Mac App Store.
2. Open the app once → "Enable me in Safari" screen.
3. Safari → Settings → Extensions → toggle MemryNote on → grant access to `127.0.0.1` /
   websites.
4. First capture triggers the same in-app **Allow** pairing dialog as Chrome/Firefox.

## Safari release runbook

1. `pnpm --filter @memry/extension build:safari`, then re-run the packager (or copy
   `.output/safari-mv3` over `apps/extension/safari` resources).
2. Bump the version in the Xcode project.
3. Archive → upload to App Store Connect → submit for review.
```

Then verify the keyboard command caveat: if `Cmd+Shift+S` does not fire in Safari (it may be reserved), add a one-line note pointing users to Safari's shortcut settings, mirroring the Firefox caveat. The popup button works regardless.

- [ ] **Step 6: Commit**

```bash
git add apps/extension/README.md
git commit -m "docs(extension): add Safari install flow and release runbook"
```

---

## Self-Review

**Spec coverage:**
- §1 allowlist change → Task 1 ✓
- §2 build scripts → Task 2 ✓
- §3 native wrap → Task 3 ✓
- §4 entitlements → Task 3 Step 3 ✓
- §5 distribution → Task 5 ✓
- §6 install flow → Task 5 Step 5 ✓
- Acceptance gate → Task 4 ✓
- Open items (Cmd+Shift+S caveat, WXT manifest warnings) → Task 5 Step 5 + Task 2 Step 2 ✓
- Unit + manual testing → Task 1 + Task 4 ✓

**Placeholder scan:** no TBD/TODO; all code and commands are concrete.

**Type consistency:** `isExtensionOrigin` / `EXTENSION_ORIGIN_PREFIXES` names match Task 1 and the existing source. Bundle ids consistent across Global Constraints, Task 3, and Task 5.

**Note on task type:** Tasks 1–2 and Task 5 Step 5 are agent-runnable. Tasks 3, 4, and Task 5 Steps 1–4 are human-run macOS/Xcode/Apple-portal steps with observation-based verification — they cannot run in an agent TDD loop.
