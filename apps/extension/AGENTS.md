# Extension guide

This directory owns the browser extension (`@memry/extension`), built with WXT for Chrome, Firefox, and Edge. It captures pages and PDFs into the desktop app running on the same machine.

## Layout

- `src/entrypoints` holds the WXT entrypoints: `background.ts`, `content.ts`, `popup/`, and `options/`. A file's name decides its manifest entry, so renaming one changes the shipped manifest.
- `src/lib` holds the capture logic. `capture-client.ts` talks to desktop, `capture-queue.ts` retries a capture while desktop is unreachable or has no vault open, and `capture-permissions.ts` requests optional host access. Page extraction comes from `@memry/article-extract`.
- `wxt.config.ts` owns the manifest, permissions, and browser targets. `store/` holds the Chrome listing assets.

## Desktop contract

- The extension talks only to desktop's [capture server](../desktop/AGENTS.md#capture-server) over HTTP on `127.0.0.1`, ports 7849 to 7856, and never to the sync server or any remote Memry service. Desktop ingests a capture into the vault and syncs it encrypted.
- Users update the extension and desktop on separate schedules, so a change to a route, header, or capture field keeps working against older and newer desktops. Change desktop's capture server in the same change.
- Stored extension state accepts data written by older extension versions.
- Logs carry no page content, URLs with query strings, or tokens.

## Permissions

- The manifest asks for `storage`, `activeTab`, `alarms`, and host access to `http://127.0.0.1/*`. PDF capture requests the page's origin at runtime through the optional `*://*/*` host permission.
- Every permission is a store review risk and a cost to user trust. Name the narrowest one that works, such as `activeTab` over all URLs or one host over a wildcard, and say so explicitly before adding it.
- Store reviewers reject permission growth without visible justification, and removing a permission later costs another review cycle.

## Content scripts

- `content.ts` is declared on every page and stays inert until the extension messages it. Keep it that way.
- A content script runs in someone else's page. Assume no global, framework, or CSS reset exists there.
- Scope every injected style. An unscoped selector breaks the host page and looks like the site's bug.
- Catch failures on hostile pages and return them as `{ ok: false, error }` responses, so the popup can show them. A thrown error in a content script reaches no one.

## Commands

- `pnpm --filter @memry/extension typecheck`, `lint`, and `test` are the gates. The root `pnpm lint` and `pnpm typecheck` skip this app.
- A change to `wxt.config.ts` or an entrypoint builds for all three targets (`build`, `build:firefox`, `build:edge`) before it is done. Firefox builds use `--mv3`, and manifest differences show up only at build time.
- Run `release`, `submit`, or `submit:firefox` only when Kaan asks. `release` bumps the version and pushes an `extension-v*` tag, and that tag submits the build to the Chrome Web Store and Firefox Add-ons.
