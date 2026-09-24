# Calendar Providers

memrynote reads calendars from more than one service. Google Calendar and subscribed ICS
feeds were the first two; each was built on its own. This page describes the layer that puts
every provider behind one model, and the rules that keep a live vault safe while devices run
different app versions.

Code lives in `apps/desktop/src/main/calendar/provider/`.

## Capabilities, not provider ids

**Problem.** Every "is this read-only", "can this be promoted" and "does this sync" decision
used to compare the provider id: `provider === 'ics'` in the projection, in promotion, and in
three renderer files. A third provider would have added a third branch at each site.

**Solution.** Each provider declares its capabilities once, in
`provider/capabilities.ts`, and the call sites read those:

| Capability             | Google                  | ICS               |
| ---------------------- | ----------------------- | ----------------- |
| `supportsWrite`        | yes                     | no                |
| `supportsPush`         | yes (sync-server relay) | no (polled)       |
| `supportsMultiAccount` | yes                     | no                |
| `requiresMemryAccount` | yes                     | no                |
| `mirrorScope`          | `synced`                | `device`          |
| `sourceScope`          | `synced`                | `synced`          |
| `incrementalMode`      | `sync-token`            | `conditional-get` |
| `authFlow`             | `oauth2`                | `url`             |

A provider id this build does not know gets nothing writable. Its events show read-only and
cannot be promoted: promoting them would write a binding for a provider this build cannot
reach.

`platforms` lists the operating systems a provider exists on. When it is set and excludes the
current OS, the provider is absent: not listed, not connectable, not rendered.

### Mirror scope: the cursor travels only if the mirror travels

`calendar_external_events` is the local mirror of a provider's events. The two shipped
providers made opposite choices, and both are coherent:

- **Google** (`synced`): mirrored events and the `sync_cursor` on the source row sync, so a
  second device shows Google events without its own sign-in and continues from the same cursor.
- **ICS** (`device`): every device reads the feed itself. The HTTP validators stay in memory
  and the events are never enqueued. Only the source row syncs.

`@memry/sync-client` cannot read the desktop table, so `DEVICE_LOCAL_CALENDAR_PROVIDERS` in
`packages/contracts/src/calendar-api.ts` lists the providers whose rows must never be
enqueued. The `seedUnclocked` sweeps of the calendar source and external event handlers both
filter on it, and a desktop test keeps the constant in step with the capability table.

## CalDAV

CalDAV (RFC 4791) reaches iCloud, Fastmail, Nextcloud, Radicale, Baïkal, mailbox.org, Posteo,
Zoho, Yahoo, Synology and self-hosted servers through one adapter in `calendar/caldav/`.

**Discovery.** `/.well-known/caldav` → `current-user-principal` → `calendar-home-set` → the
collections. Hosts come from the server's answers; nothing is hardcoded. Collections that cannot
hold events (VTODO-only task lists) are skipped. The XML requests and responses go through the
`tsdav` library; every request goes through `caldav-transport.ts`.

**Credentials across redirects.** iCloud answers discovery with a redirect to a per-account
partition host such as `p67-caldav.icloud.com`. `fetch` drops the `Authorization` header on any
cross-origin redirect, and re-attaching it blindly would send the app password wherever a server
points. The transport follows redirects itself and attaches credentials only to hosts in the
account's scope: the server's host, and, when that host has at least three labels, its parent
domain and every subdomain (`caldav.icloud.com` covers `*.icloud.com`). Credentials never move
from HTTPS to plain HTTP; plain HTTP gets them only for the exact origin the user typed, which is
how a LAN Radicale works. Servers that only offer HTTP Digest are answered from their challenge.

**Reading.** The `sync_cursor` is `sync-token:<token>` when the collection supports RFC 6578
`sync-collection`, and `ctag:<ctag>` otherwise, in which case the ETags of all objects are diffed
against the mirror. `sync-collection` has no time-range filter, so the first pull (and every pull
after the cursor is reset) reads the token first and then fetches only the objects inside the
mirror window (90 days back, a year ahead) with a `calendar-query` time-range REPORT. A token the
server no longer accepts (the `valid-sync-token` precondition) is `ProviderGoneError`: the cursor
is cleared and the calendar is pulled in full.

**Instances per object.** A CalDAV object (an `href`) holds a master event and its overrides.
Mirrored instances are keyed `<href>` or `<href>::<recurrence-id>`, so a changed or deleted
object replaces or removes exactly its own instances. The mirror keeps each object's ETag on
every row and the whole iCalendar text on one row per object, for write-back.

**One parser.** VEVENT expansion (RRULE, RDATE, EXDATE, RECURRENCE-ID overrides, VTIMEZONE,
undefined TZIDs, floating times, cancelled instances, caps on runaway rules) lives in
`calendar/ical/` and is shared by ICS feeds and CalDAV.

**Mirror scope: synced.** Credentials never leave the device. With a device-local mirror, a
second device would show the account as needing its password and no events at all until the
app password is entered there too. A synced mirror is what Google users already get, and an app
password per device is real friction, so CalDAV's mirror and its cursor sync. A device without
the password shows the events, skips pulling, and shows the account as needing the password.

**Auth.** Basic over TLS with an app password, stored as the `password` secret kind. A `401`
marks the account `reconnect_required` on that device only (resetting an Apple ID password
revokes every app-specific password), and the next successful sync or a reconnect clears it.

## Registry

`provider/registry.ts` holds one `ProviderDefinition` per provider: connect, disconnect,
refresh, local-auth checks, the selection toggle, per-source retry, and (for providers with a
write target) calendar listing and the default calendar. The calendar IPC handlers dispatch
through it. An unknown provider still gets `Unsupported calendar provider: <id>`, byte for byte.

Generic IPC channels sit next to the provider-specific ones:

| Generic                                                    | Kept as a permanent alias                                  |
| ---------------------------------------------------------- | ---------------------------------------------------------- |
| `calendar:list-providers`                                  | none                                                       |
| `calendar:list-provider-calendars`                         | `calendar:list-google-calendars`                           |
| `calendar:set-default-provider-calendar`                   | `calendar:set-default-google-calendar`                     |
| `calendar:retry-source-sync`                               | `calendar:retry-google-source-sync`                        |
| `settings:{get,set}CalendarProviderSettings`               | `settings:{get,set}CalendarGoogleSettings`                 |
| `calendar:connect-provider` with `connection.kind = 'url'` | `calendar:subscribe-ics`, `unsubscribe-ics`, `refresh-ics` |

The old channels are never removed. During a partial update an older renderer can talk to a
newer main process, and a missing channel breaks the app in that window.

## Credentials and settings

- **Credentials** are stored per provider under `com.memry.calendar.<providerId>`, with the
  account key `<kind>-<accountId>`. Google's service name and keys are unchanged. Credentials
  never sync.
- **Settings** live in one `calendar.<providerId>` group per provider. `calendar.google` keeps
  its key and exact shape. Other providers share a base (`agentReadEventsConsent`); writable
  ones add the one-way switch `pushEventsToProvider`. Nothing is migrated: new providers only
  write new keys.
- **Agent read consent** is per provider. The agent's calendar reads carry an allow-list of the
  providers the user consented to, so an ICS feed is hidden from the agent until ICS itself is
  allowed, whatever the answer for Google was. See
  [AI access per calendar service](/user-guide/calendar#ai-access-is-asked-per-calendar-service).

## Write routing: one writer per item

**Problem.** Device A has Google and a second writable provider, with the second provider's
"Work" calendar as the default, so a task gets a binding to it. Device B has Google with pushing
on. It receives the task and the binding, the user edits the title, and B's Google push, which
only looked for Google bindings, found none and created the task in Google too. Every later edit
then forked.

**Solution.** `provider/write-routing.ts` resolves the one provider allowed to write an item:

1. a live binding of **any** provider (the oldest, should two exist);
2. otherwise the event's `target_calendar_id`, looked up in `calendar_sources` across providers.
   The column keeps its bare-id format because older builds read it as a Google calendar id. An
   id no source knows stays Google's, and if two providers ever share an id, Google wins;
3. otherwise `calendar.defaultWriteTarget` (`{ provider, remoteCalendarId }`), which falls back
   to `calendar.google.defaultTargetCalendarId`, so an install with only Google settings routes
   exactly as before;
4. otherwise Google's managed memrynote calendar, as before.

`provider/write-dispatch.ts` hands the change to that provider's writer only, and only when the
provider's capabilities say `supportsWrite`. The Google push path checks the route as well, so it
refuses an item another provider holds even when called directly.

Promotion binds the copy to the source's own provider. Choosing a Google default in Google's own
picker after a cross-provider default exists moves the cross-provider default to Google, so the
older control keeps working.

## Cross-version compatibility

Calendar sources, bindings and external events sync between devices, and devices update at
different times. A row written by a new build for a new provider reaches old builds.

### Why the server cannot filter it

Sync payloads are end-to-end encrypted and `provider` is inside the payload. The server only
sees the item type, so it cannot hold a CalDAV binding back from an older build.

### What older builds do with non-Google rows

Traced against the Google code older builds run, and pinned by tests
(`sync/item-handlers/calendar-foreign-provider-compat.test.ts`,
`calendar/google/foreign-provider-hazards.test.ts`):

- **Source rows, bindings and external events** of any provider are stored as sent: not
  deleted, not archived, not rewritten to Google, and their vector clocks and `provider` survive
  the encrypted round trip. Deletes resolve by vector clock the same way for every provider.
- **Hazard 1, double push.** A task holds a CalDAV binding from device A. Old device B, with
  Google connected, edits the task. B's Google push looks only for a Google binding, finds none,
  and creates the task in Google too.
- **Hazard 2, failing push.** An event targets a CalDAV collection URL. Old device B reads the
  URL as a Google calendar id, and every push of that event fails.
- **Hazard 3, selection purge.** Old device B lists the CalDAV calendar in its filter. Unticking
  it there deletes the mirrored events and syncs the deletes, so they disappear on every device
  until the provider's next pull. That is also what new builds do when a calendar is unticked.

Disconnecting Google on an old build removes only `provider = 'google'` rows.

### Mitigation: a version floor when a second writer connects

Hazards 1 and 2 exist only once a second provider can write. Before a writable provider other
than Google connects, memrynote reads the account's devices from `GET /devices`, which now
includes the build each device last connected with, and lists every other device below
`CALENDAR_MULTI_WRITER_MIN_APP_VERSION`. A device with no recorded version counts as outdated.
The connect is refused until the user updates those devices or explicitly accepts the risk,
and the double-push consequence is spelled out. When the device list cannot be read, the user
must accept blind. Without a Memry account nothing syncs, so nothing is checked.

The sync server keeps `devices.app_version` current: every realtime connection records the
`X-App-Version` it arrived with. The change is additive; older clients ignore the new
`appVersion` field.

A separate sync item type for non-Google bindings (so older builds never receive them) would
close hazard 1 on the server side, at the cost of a new type across handlers, contracts and
server. It stays on the table if the version floor proves leaky.
