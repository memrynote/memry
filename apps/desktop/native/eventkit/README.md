# memry-eventkit

The macOS Calendar bridge (#1405): a small signed Swift executable that main spawns to read EventKit. macOS only. Windows and Linux never build, bundle or load it.

## Why a helper process and not an N-API addon

|                          | (a) N-API addon                                                                                                                       | (b) Swift helper (chosen)                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Electron ABI             | none with pure N-API, but it joins `better-sqlite3`/`keytar`/`classic-level` in `node-gyp`, `rebuild:electron` and the staged rebuild | none: a plain executable, no rebuild step                       |
| Install on Windows/Linux | needs `os` guards so `node-gyp` never runs there                                                                                      | nothing to guard: `build-eventkit-helper.mjs` exits 0 off macOS |
| Crash blast radius       | a bad EventKit call or a missing usage string kills the main process                                                                  | kills the helper; main reports `unavailable` and carries on     |
| Change notifications     | threadsafe function from an ObjC observer into JS                                                                                     | `{"event":"changed"}` lines on stdout                           |
| Tests                    | need the addon or a mock at the module boundary                                                                                       | a fake helper speaking the same protocol, on every OS           |

Rejected as the issue says: AppleScript/JXA (launches Calendar.app, needs Automation) and reading `Calendar.sqlitedb` (Full Disk Access, undocumented).

npm bindings audited: `eventkit-node` (MPL-2.0, one maintainer) runs `node-gyp rebuild` as an unconditional `install` script with no `os` field, so it would try to compile on Windows and Linux, and it has no change notification. `node-mac-permissions` (MIT) only covers the permission status and prompt, not reading. Neither is used.

## TCC attribution

The helper is spawned by the app and inherits it as its _responsible process_, the same way a command in VS Code's terminal asks for access as "Code". So:

- the prompt names MemryNote and shows MemryNote's `NSCalendarsFullAccessUsageDescription`
- the grant appears under MemryNote in System Settings → Privacy & Security → Calendars
- run from Terminal (`--probe`, or piping requests by hand), it is attributed to the terminal app instead. That is only for development

Hardened runtime needs `com.apple.security.personal-information.calendars`. It is in `build/entitlements.mac.plist` (the app) and `config/entitlements.mac.plist` (`entitlementsInherit`, which electron-builder uses to sign the helper).

## Protocol

Newline-delimited JSON on stdin/stdout. The helper exits when stdin closes.

```
-> {"id":1,"method":"authorizationStatus"}
<- {"id":1,"result":"not_determined" | "restricted" | "denied" | "write_only" | "full_access"}
-> {"id":2,"method":"requestFullAccess"}          macOS 14+: requestFullAccessToEvents, older: requestAccess(to: .event)
-> {"id":3,"method":"listCalendars"}
-> {"id":4,"method":"listEvents","params":{"calendarIds":[...],"start":"<ISO>","end":"<ISO>"}}
<- {"id":4,"error":{"code":"not_authorized" | "span_too_long" | "invalid_params" | ...,"message":"..."}}
<- {"event":"ready","protocol":1}
<- {"event":"changed"}                              EKEventStoreChanged
```

`listEvents` refuses a span over four years, because EventKit silently truncates longer predicates. Each event carries title, times, location, notes, URL, status, availability, `attendees` and `organizer` (name, `mailto:` address, response, role, type, `isCurrentUser`), `alarmMinutes` and the first recurrence rule as an RRULE value. Main finds Meet/Zoom/Teams/Webex join links in the URL, location or notes (`eventkit-details.ts`).

## Build and packaging

- `pnpm --filter @memry/desktop build:eventkit` builds `bin/memry-eventkit` (universal arm64 + x86_64, ad-hoc signed). `predev` runs it with `--optional`. Off macOS it prints a skip line and exits 0.
- `scripts/build-packaged-app.js` force-builds it for mac targets only and stages `bin/`. `mac.extraFiles` copies it to `Contents/MacOS/memry-eventkit`, and the app's signing pass signs it with `entitlementsInherit`.
- `scripts/prune-packaged-app.mjs` (afterPack) fails a mac build without the helper and a Windows/Linux build with it.
- `native/**` is excluded from `app.asar` on every platform.

## Developer harness

```bash
apps/desktop/native/eventkit/bin/memry-eventkit --probe      # prints the status, never prompts
printf '{"id":1,"method":"listCalendars"}\n' | apps/desktop/native/eventkit/bin/memry-eventkit
```

In the app, Settings → Calendar → This Mac → **Allow calendar access** is the only thing that shows the permission dialog.

Under `pnpm dev` the helper's responsible app is the dev `Electron.app`, whose Info.plist has no calendar usage string. macOS kills a process that asks for calendar access without one, so the helper dies and This Mac reports "unavailable" (main is unaffected). Run `pnpm --filter @memry/desktop dev:calendar-permission` once to add the strings to the dev bundle. The prompt and the System Settings entry then say "Electron", not MemryNote. Only a packaged build shows the real copy.
