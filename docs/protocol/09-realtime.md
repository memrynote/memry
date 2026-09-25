# 09 — Realtime

**Status**: normative. Every normative sentence carries a `path:line` citation
(chapter 00 §0.1).

The WebSocket is an **advisory wake-up channel**. Every frame it delivers is a
hint that the client should run its ordinary pull (chapters 05 and 07). The one
exception to "no data" is opt-in: a socket that asks for it also receives the
committed items of a record push on `changes_available` (§9.13). They are
advisory too; the pull still runs and still owns the cursor.

## 9.1 Should a client open it at all — Q09.1

**Normative — the socket is optional.** A client that never opens it is
conforming and simply learns about remote changes on its next pull.

There is **no server push infrastructure for a suspended process**: the Durable
Object can only reach a socket that is currently open
(`apps/sync-server/src/durable-objects/user-sync-state.ts:234-246` iterates live
sockets), and nothing in the tree sends a platform push notification.

**When the socket is open depends on the surface**, because "backgrounded"
means different things for a process the OS suspends and for one that keeps
running:

- **A mobile surface MUST close the socket when the application is
  backgrounded, and SHOULD open it while in the foreground.** The OS suspends a
  backgrounded mobile app, so its socket cannot be serviced and every broadcast
  to it is a wasted wake. The Rust core leaves the lifecycle to the shell: it
  exposes `RealtimeClient::connect` and `RealtimeClient::disconnect`
  (`crates/memry-core/src/sync/socket.rs:185`, `:215`) and observes no app
  state itself. No mobile shell drives it yet
  (`apps/ios/Memry/App/ShellState.swift:173-179`).
- **A resident desktop process keeps the socket open for as long as the process
  runs and sync is started.** Closing the main window hides it to the tray and
  leaves the process running
  (`apps/desktop/src/main/index.ts:836-839`); losing window focus only records
  telemetry (`apps/desktop/src/main/index.ts:1614-1620`). Neither is a socket
  lifecycle event. Desktop disconnects only when the engine stops
  (`apps/desktop/src/main/sync/engine.ts:352`), the network drops (`:811`; a
  system `suspend` counts as offline,
  `apps/desktop/src/main/sync/network.ts:92-95`), the device is revoked
  (`apps/desktop/src/main/sync/engine/error-recovery-handler.ts:72`), or a
  close is terminal (`apps/desktop/src/main/sync/websocket.ts:184-205`, §9.9).

An idle desktop socket costs the server nothing. The Durable Object accepts it
through the hibernation API
(`apps/sync-server/src/durable-objects/user-sync-state.ts:190`) and answers the
client's `ping` with the registered `pong` auto-response without waking
(`:69`, §9.6). The client pings every 25 s and terminates the socket after 31 s
without a frame (`apps/desktop/src/main/sync/websocket.ts:12`, `:16`,
`:307-329`), so a half-open connection reports disconnected instead of being
trusted.

**On any surface, a client that returns to the foreground or regains a socket
MUST run a full pull rather than assuming the socket told it everything**:
broadcasts sent while it was away are gone. Desktop pulls on every socket
`connected` event and on network return
(`apps/desktop/src/main/sync/engine.ts:892-906`, `:759-793`).

**Disposition of Q09.1: answered** (this section).

## 9.2 Handshake

**Normative.** `GET /sync/ws`
(`apps/sync-server/src/routes/sync.ts:258`). **Authentication is handshake
headers only — never a query parameter and never a subprotocol**
(`packages/contracts/src/sync-socket.ts:12-16`).

| Header                                | Required        | Effect                                                                                                                                                                       |
| ------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Authorization: Bearer <accessToken>` | yes             | `401 AUTH_INVALID_TOKEN` when invalid (`apps/sync-server/src/durable-objects/user-sync-state.ts:95-104`)                                                                     |
| `X-App-Version: <semver>`             | **yes**         | absent is `426 SYNC_VERSION_INCOMPATIBLE` (`:106-117`)                                                                                                                       |
| `X-Memry-Vault-Id: <uuid>`            | effectively yes | defaults to `default` (`:156`); **a socket on the wrong vault connects and then hears nothing**, because every broadcast is filtered by the socket's attached vault (`:198`) |
| `X-Memry-Socket-Items: 1`             | no              | opts the socket in to socket items (§9.13); any other value or absence means hint-only frames (`apps/sync-server/src/lib/socket-items.ts:45-48`)                             |
| `X-Memry-Sync-Types: <csv>`           | no              | read only with the opt-in above; same grammar and resolution as the HTTP header (chapter 05 §5.3), and it decides which item types the socket receives                       |

Failures:

| Condition                       | Answer                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------ |
| invalid token                   | `401 AUTH_INVALID_TOKEN` (`:93-96`)                                                        |
| missing `X-App-Version`         | `426 SYNC_VERSION_INCOMPATIBLE` (`:101-109`)                                               |
| version below `MIN_APP_VERSION` | `426 SYNC_VERSION_INCOMPATIBLE` with `minVersion` **inside** the error object (`:112-121`) |
| unknown or revoked device       | `403 AUTH_DEVICE_REVOKED` (`:130-135`)                                                     |

A successful handshake answers `101` with the socket
(`apps/sync-server/src/durable-objects/user-sync-state.ts:168`).

**Normative.** Before answering `101`, the server stores the handshake's
`X-App-Version` as the device's `app_version` when it differs from the stored
one. This is best effort: a failed write never refuses the connection. The
value is what `GET /devices` reports as `appVersion` (chapter 02), so other
devices can warn before a change older builds would mishandle (#1396).

**This version gate is not the one in chapter 11.** It uses `X-App-Version`
against `MIN_APP_VERSION`, not `x-memry-client` against `client_policies`. See
chapter 11 §11.11.

## 9.3 One socket per device

**Normative.** An existing socket tagged `device:<deviceId>` is closed with code
**4001** when a new one connects for the same device
(`apps/sync-server/src/durable-objects/user-sync-state.ts:144-148`).

A client MUST NOT open two sockets for one device: the second silently kills the
first.

## 9.4 Message envelope

**Normative.** `{ "type": string, "payload"?: object }`, serialised as JSON
(`packages/contracts/src/sync-socket.ts:60-66`;
`apps/sync-server/src/durable-objects/user-sync-state.ts:193`).

**`type` is deliberately a plain string, not an enum**, so a newer server can add
a type without an older client treating the frame as corrupt; unknown names parse
and are ignored (`packages/contracts/src/sync-socket.ts:61-63`). **A client MUST
NOT reject a frame for carrying an unknown `type`.**

## 9.5 Message types

**Normative.** The complete list the server can put on a socket
(`packages/contracts/src/sync-socket.ts:27-36`), with the payload each carries
and where it is produced:

| Type                         | Payload                                                                                                                                          | Producer                                                                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `changes_available`          | `{ cursor?, vaultId?, committedAtMs?, items? }` (`packages/contracts/src/sync-socket.ts:70-75`); the last two only on an opted-in socket (§9.13) | the default broadcast type (`apps/sync-server/src/durable-objects/user-sync-state.ts:220`), sent after a record push (`apps/sync-server/src/routes/sync.ts:526`) |
| `crdt_updated`               | `{ vaultId?, noteId, cursor? }` (`packages/contracts/src/sync-socket.ts:86-93`)                                                                  | after a CRDT update push (`apps/sync-server/src/routes/sync.ts:849`), a snapshot push (`:1067`) and a batch (`:1243`)                                            |
| `calendar_changes_available` | `{ sourceId }`                                                                                                                                   | the calendar webhook route (`apps/sync-server/src/routes/webhooks.ts:183-187`)                                                                                   |
| `auth_ok`                    | `{ exp? }` (`packages/contracts/src/sync-socket.ts:101`)                                                                                         | the in-place re-auth reply (§9.8)                                                                                                                                |
| `error`                      | `{ code?, message? }` (`packages/contracts/src/sync-socket.ts:102`)                                                                              | `WS_RATE_LIMITED` (`apps/sync-server/src/durable-objects/user-sync-state.ts:355-360`) and `WS_TOKEN_EXPIRED` (`:464-469`)                                        |
| `linking_request`            | `{ sessionId, newDeviceName, newDevicePlatform }`                                                                                                | `POST /auth/linking/scan` (`apps/sync-server/src/routes/linking.ts:155-163`)                                                                                     |
| `linking_approved`           | `{ sessionId }`                                                                                                                                  | `POST /auth/linking/approve` (`apps/sync-server/src/routes/linking.ts:262-266`)                                                                                  |
| `heartbeat`                  | **none**                                                                                                                                         | **no producer**; see §9.5.2                                                                                                                                      |

### 9.5.1 Calendar and linking payload shapes — Q09.3

`calendar_changes_available`, `linking_request` and `linking_approved` are in
`SYNC_SOCKET_MESSAGE_TYPES` (`packages/contracts/src/sync-socket.ts:30`, `:34`,
`:35`) and have payload schemas in the contract
(`packages/contracts/src/sync-socket.ts:90-96`), so `parseSyncSocketFrame`
narrows them to `{ kind: 'calendar_changes_available', sourceId }`,
`{ kind: 'linking_request', sessionId, newDeviceName, newDevicePlatform }` and
`{ kind: 'linking_approved', sessionId }` (`:180-191`). Desktop parses every
frame through that helper (`apps/desktop/src/main/sync/websocket.ts:158-170`).
Until #2291 the contract had no schema for them and desktop read their payloads
directly; a frame missing a required field was forwarded to the renderer as-is.
It is now `ignored`.

**Normative — the shapes are those in the table above**, as sent by their
producers. All listed fields are required (`sourceId` non-empty); unknown
payload keys are stripped, never rejected. Specifically:

```
linking_request   { sessionId: string, newDeviceName: string, newDevicePlatform: string }
linking_approved  { sessionId: string }
calendar_changes_available { sourceId: string }
```

**A client implementing linking MUST handle `linking_request` and
`linking_approved`**: they are how the approving device learns that a new device
scanned and how the initiator learns the session moved on (chapter 03).
Both are delivered through `/notify-linking` to one target device
(`apps/sync-server/src/routes/linking.ts:152`, `:259`), not broadcast to all.

**Both are advisory.** Delivery is best-effort and failures are captured in the
background (`apps/sync-server/src/routes/linking.ts:166`, `:269`), so a client
MUST also poll (chapter 03 §3.4) and MUST NOT make linking depend on a socket
frame arriving.

`calendar_changes_available` is targeted too: the webhook route broadcasts
with `targetDeviceId` set to the device that registered the Google push channel
(`apps/sync-server/src/routes/webhooks.ts`), so only that device's socket
receives it. Push channels are per-device, and each device runs its own sync
against Google. It is advisory in the same way: Google itself drops a small
share of notifications, so a client MUST keep polling the calendar provider.

**Disposition of Q09.3: answered** (this section).

### 9.5.2 `heartbeat` — Q09.2

`heartbeat` is in the type list (`packages/contracts/src/sync-socket.ts:31`),
has no payload schema, and **has no producer anywhere in
`apps/sync-server/src`**. `parseSyncSocketFrame` collapses it to `ignored`
(`packages/contracts/src/sync-socket.ts:200-201`), which desktop drops with a
debug log (`apps/desktop/src/main/sync/websocket.ts:165-168`).

**Normative — `heartbeat` is dead. There is no server-initiated keepalive.** The
keepalive is client-initiated and is §9.6. A client MUST ignore a `heartbeat`
frame if one ever arrives and MUST NOT use its absence as a liveness signal.

**Disposition of Q09.2: answered (dead; the keepalive is client-initiated).**

## 9.6 Keepalive must be exactly `ping`

**Normative.** The client sends the literal text frame `ping` and the server
answers `pong` (`packages/contracts/src/sync-socket.ts:48-49`).

The Durable Object registers
`new WebSocketRequestResponsePair('ping', 'pong')`
(`apps/sync-server/src/durable-objects/user-sync-state.ts:66`), so Cloudflare
answers **that one payload** without waking the object or spending the socket's
inbound rate-limit budget. **Any other keepalive text is a real message that
costs a wake on every beat and consumes rate-limit budget**
(`packages/contracts/src/sync-socket.ts:41-46`).

Reference cadence: send `ping` every **25 s**
(`apps/desktop/src/main/sync/websocket.ts:15`, `PING_INTERVAL_MS = 25_000`,
started at `:305-311`), and terminate the socket if no frame arrives within the
heartbeat timeout (`apps/desktop/src/main/sync/websocket.ts:321-327`).

## 9.7 Inbound rate limit

**Normative.** 100 inbound messages per 10 seconds per socket
(`apps/sync-server/src/durable-objects/user-sync-state.ts:26-27`). On overrun the
server sends an `error` frame carrying `WS_RATE_LIMITED` and then closes with
**4008** (`:315-323`).

The `ping`/`pong` auto-response does not count against this budget (§9.6), which
is the whole reason the keepalive text is fixed.

## 9.8 Re-authentication in place

**Normative.** The client sends

```json
{ "type": "auth", "payload": { "token": "<fresh access token>" } }
```

(`packages/contracts/src/sync-socket.ts:138-141`) and the server answers `auth_ok`
with the new `exp`
(`apps/sync-server/src/durable-objects/user-sync-state.ts:327-331`).

**Rejection is non-fatal**: the socket keeps its existing `tokenExp` and the
alarm closes it at the original expiry, which is the pre-renewal behaviour
(`apps/sync-server/src/durable-objects/user-sync-state.ts:338-343`).

A conforming client SHOULD re-authenticate in place whenever it refreshes its
access token (chapter 02 §2.10), rather than tearing the socket down.

## 9.9 Close codes

**Normative** (`packages/contracts/src/sync-socket.ts:51-58`, mirrored at
`apps/sync-server/src/durable-objects/user-sync-state.ts:29-33`):

| Code | Name                  | Cause                                                                                                       | Reconnectable                |
| ---- | --------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------- |
| 4001 | `replaced`            | another socket connected for this device (§9.3)                                                             | yes                          |
| 4003 | `tokenExpired`        | the alarm sweep found `tokenExp <= now` (`apps/sync-server/src/durable-objects/user-sync-state.ts:422-434`) | yes, **after** a refresh     |
| 4004 | `deviceRevoked`       | the device was revoked                                                                                      | **terminal**                 |
| 4008 | `rateLimited`         | §9.7                                                                                                        | yes                          |
| 4009 | `versionIncompatible` | the app version floor                                                                                       | **terminal for the session** |

**4004 and 4009 are terminal.** A conforming client MUST latch reconnection off
for both — for 4004 by signing the device out, for 4009 until the application is
updated (`apps/desktop/src/main/sync/websocket.ts:182-204`, where 4004 clears
`shouldBeConnected` and 4009 sets `versionRejected`).

## 9.10 Reconnect and backoff — Q09.4

**Normative.** A reconnect policy exists in the reference implementation
(`apps/desktop/src/main/sync/websocket.ts:12-15`, `:337-352`) and this chapter
adopts it:

| Constant                  | Value  | Line  |
| ------------------------- | ------ | ----- |
| `BASE_RECONNECT_DELAY_MS` | 1 000  | `:13` |
| `MAX_RECONNECT_DELAY_MS`  | 30 000 | `:12` |
| `RECONNECT_JITTER_MS`     | 500    | `:14` |

```
delay = min(BASE * 2^attempt + random()*JITTER, MAX)
```

(`apps/desktop/src/main/sync/websocket.ts:342-346`), with `attempt` incremented
per scheduled reconnect (`:348`) and **reset to zero on a successful open**.

A reconnect MUST NOT be scheduled when any of these latches is set:
the client no longer wants a connection, the handshake was rejected `401`, the
version was rejected, or transport pinning failed
(`apps/desktop/src/main/sync/websocket.ts:338-339`). A reconnect MUST only fire
when the device believes it is online (`:352`).

### 9.10.1 What a client does between a 4003 and a successful refresh

**Normative.** On close code **4003** a client MUST:

1. **not** reconnect immediately — the same expired token yields another 4003 and
   burns an attempt;
2. request a fresh access token through the ordinary refresh path (chapter 02
   §2.9, §2.10), **single-flighted** with any refresh the HTTP path is already
   running;
3. reconnect only after a refresh succeeds, resetting the backoff attempt counter
   because the disconnection was expected;
4. if the refresh **fails terminally** (three 401s, chapter 02 §2.10), latch
   reconnection off and treat the session as signed out.

While in this state the client MUST continue to function offline and MUST NOT
present the socket's absence as a sync failure: the socket is advisory (§9.11),
so the only consequence is that remote changes arrive on the next pull rather
than immediately.

**Disposition of Q09.4: answered** (this section).

## 9.11 Broadcasts are advisory

**Normative.** `changes_available` carries an optional `cursor` and the client
still runs its normal pull; **a client MUST NOT use the broadcast's `cursor` as
its own cursor** (chapter 05 §5.11).

A client MAY drop a `changes_available` whose `cursor` is at or below its own
applied cursor without pulling. This is a skip filter, not cursor adoption, and
it is exact only because the server assigns cursors in commit order (chapter 05
§5.5, #2282) and the pull cursor moves only after apply (§5.11): every row at or
below the applied cursor is already on the device. A broadcast without a
`cursor` MUST still be treated as a wake. The desktop also coalesces wakes: one
that arrives while a wake-driven pull is queued adds nothing, and any number
that arrive while a pull runs queue exactly one trailing pull
(`apps/desktop/src/main/sync/engine.ts` `scheduleWakePull`, #2290). The Rust
core does the same in `SyncEngine::wake`
(`crates/memry-core/src/sync/engine.rs`), fed by the `cursor` that
`Hint::ChangesAvailable` carries (`crates/memry-core/src/sync/socket_frame.rs`). The
periodic pull stays the fallback for a missed broadcast.

Items on the frame (§9.13) change none of this: a client MUST NOT move its
cursor because of them, and MUST still treat the frame as a wake.

`crdt_updated` carries an optional `cursor` (#2420): the highest
`server_cursor` the write reserved. For an update push that is the highest
cursor among the rows it inserted; for a snapshot push, single or batch, the
stored row's cursor. **It is omitted when the write stored nothing new**: a
duplicate-only update retry (chapter 07, #2296), or a snapshot write re-read as
committed after its batch answer was lost (chapter 07 §7.7.1). A refused
snapshot write broadcasts nothing. The same rule as the `changes_available` cursor applies: **a client
MUST NOT use it as its own pull cursor**; it exists for the skip filter above.
Clients that predate it ignore the key, and a `crdt_updated` without one keeps
meaning "pull this note". A client that reads a malformed `cursor` MUST drop
the cursor and keep the frame, which still names a note to pull.

The desktop treats `crdt_updated` as a wake (#2421) once the change feed serves
it every body row (its one-time legacy sweep is done, chapter 07 §7.17.5) and
the frame carries a `cursor`: the same coalesced wake pull as
`changes_available`, with the same skip filter, and no per-note pull. The feed
delivers the body. Until `LAST_CURSOR` reaches the frame's cursor the note
counts as unmerged, so no snapshot push prunes the write just announced. A
wake refused because a full sync runs is latched and pulled when that sync
ends, if the cursor is still ahead. Every pull outside a full sync, the wake's
included, then pays the body debts it owed. Before `done`, and for a frame
without `cursor`, it pulls the named note.

**A device is excluded from its own broadcast** by `excludeDeviceId`
(`apps/sync-server/src/durable-objects/user-sync-state.ts:233`), and a broadcast
carrying a `vaultId` reaches only sockets attached to that vault (`:234`).

Delivery is best-effort: a send that throws because the socket closed between
enumeration and send is swallowed
(`apps/sync-server/src/durable-objects/user-sync-state.ts:200-205`). **A client
MUST NOT treat a missed broadcast as data loss.**

## 9.12 Frame parsing rules

**Normative** (`packages/contracts/src/sync-socket.ts:147-202`):

- **`null` is returned only when the frame is not a message envelope at all** —
  bad JSON, or no `type` (`:150-158`). That is the only case worth logging.
- Everything else collapses to a single `ignored` outcome: the keepalive answer
  (`:148`), a type with no handler (`:200-201`), and **a known type whose payload
  does not carry what it needs** (`:166`, `:178`, `:182`, `:186`, `:190`, `:194`,
  `:198`).
- **An unrecognised frame MUST never reach a throw**
  (`packages/contracts/src/sync-socket.ts:106-110`).

## 9.13 Socket items (#2300)

**Normative.** A client MAY opt in on the handshake (§9.2) with
`X-Memry-Socket-Items: 1` and `X-Memry-Sync-Types: <csv>`. The server stores
the resolved types on the socket
(`apps/sync-server/src/durable-objects/user-sync-state.ts:179`,
`apps/sync-server/src/lib/socket-items.ts:45-48`). With the opt-in and no
`X-Memry-Sync-Types`, the socket gets the frozen legacy list, exactly as an
HTTP request without the header does (chapter 05 §5.3). `note_body` is never a
socket item: it is not a record type, and a record push never commits one. Nor
is a purged tombstone (chapter 05 §5.12.3): `purged_tombstones` is a feed-only
token, not a record type, and a marker reaches a client only as a
`purgedTombstones` entry of `POST /sync/pull`, where its delete attestation is
checked. A frame item is always a signed record.

When a record push commits, the server attaches the committed rows to that
socket's `changes_available` payload:

```json
{
  "type": "changes_available",
  "payload": {
    "cursor": 812,
    "vaultId": "…",
    "committedAtMs": 1790000000123,
    "items": [/* RecordPullItemResponse, ascending cursor */]
  }
}
```

- **What `items` holds.** Each element is exactly what `POST /sync/pull`
  returns for that row version, byte for byte, tombstones included with
  `deletedAt`. The push builds it from the values it just committed through
  the same constructor the pull uses
  (`apps/sync-server/src/services/sync.ts:399`, `:491`, `:564`). Only accepted rows
  appear, in ascending server cursor order. `committedAtMs` is the commit time
  of the push's latest wave, for the latency trace (#2280).
- **Only negotiated types.** A socket receives only the item types it
  declared. A filter that leaves no item sends the hint-only frame.
- **Budget, all or nothing.** Items are attached only when the push's whole
  item list serializes to at most 64 KiB
  (`apps/sync-server/src/lib/socket-items.ts:15`, `:31-38`). A larger push is
  hint-only; the server never truncates the list. The server decides from the
  committed payload sizes before it builds anything, and builds the items only
  after every wave committed, so building can never reject a committed row
  (`apps/sync-server/src/services/sync.ts:554-574`). The server variable
  `SYNC_SOCKET_ITEMS_MAX_BYTES` can lower the budget and `"0"` turns items off
  at no cost (`apps/sync-server/src/lib/socket-items.ts:18-24`); it cannot
  raise it.
- **Only while the token is valid.** Authorization is checked at connect. A
  socket whose token has expired since receives the hint-only frame
  (`apps/sync-server/src/durable-objects/user-sync-state.ts:239`). **Accepted
  risk:** a device revoked while `/revoke-device` fails keeps receiving items
  until the revocation alarm closes its socket, at most 60 s later (§9.9); the
  revoke path and the alarm are unchanged.
- **Old clients are unaffected.** A socket that did not opt in, including every
  socket accepted before this shipped, receives byte for byte the frame it
  received before (`apps/sync-server/src/lib/socket-items.ts:56-98`). A server
  that predates this ignores both headers, so an opted-in client sees plain
  wakes.

**Client rules.** The frame is still a wake, and `items` is advisory.

- A client MUST still run its normal pull for the frame (§9.11) and MUST NOT
  move its cursor because of `items` (chapter 05 §5.11). Items may be dropped,
  partial or out of order; the pull makes delivery complete.
- **Re-delivery covers an item only above the applied cursor.** The feed
  re-delivers rows with a cursor above the client's applied cursor and no
  others. A client MUST therefore skip a frame whose `cursor` is at or below
  the highest cursor whose rows it has applied or is applying: for desktop that
  is the larger of `LAST_CURSOR` and the owned-through mark, the highest
  `nextCursor` of a changes page a pull has read, kept until `LAST_CURSOR`
  reaches it, across runs. A pull commits a page's rows before its cursor (a
  slice before the last, a page with post-commit work, a run that stops
  mid-page), so without the mark an older frame item could undo a newer row the
  pull already applied, for example re-create a row a tombstone deleted, and
  nothing would re-deliver the tombstone. A mark that is too high only sends
  frames to the pull. A client MUST apply frames one at a
  time in arrival order. The re-delivery of an item that did land is an
  equal-clock, identical-payload skip (chapter 06 §6.5.2 P4); that holds
  because the server refuses a re-push at an equal clock (chapter 05 §5.7), so
  two committed rows with one clock never differ.
- **Accepted transient: a newer frame delete, then an older page upsert.** The
  mark guards an older frame against a newer page, not the reverse. A frame
  that deletes a row between a pull's `POST /sync/pull` for that row and the
  page's apply is followed by the page's older upsert, which finds no row and
  no pending delete and re-creates it. The tombstone's cursor is above the
  page's, so the frame's own wake pull re-delivers it and the row goes away
  again within one pull cycle. Nothing diverges; the row re-appears briefly.
- A client that applies items MUST validate each one on its own (chapter 05
  §5.14), MUST verify its signature, and MUST apply it through its ordinary
  apply rules (pending local delete, vector clocks, conflict push-back). A
  malformed `items` or `committedAtMs` never demotes the wake to `ignored`
  (`packages/contracts/src/sync-socket.ts:68-85`).
- A client MUST NOT record any failure state because of a socket item:
  no quarantine, no schema-invalid entry of any kind (`blob_missing` and
  `pending_intent` included), no corrupt mark, no key-mismatch verdict. It
  drops the failing item and lets the pull decide, with the page context the
  frame lacks.
- The ordinary apply rules include every per-item rule of the pull's apply: a
  remote delete records its tombstone clock (chapter 05 §5.8), and an item
  whose local edit still has an undrained sync intent is not applied and is
  left to the pull, which defers it (desktop, #2301).
- A client MUST NOT land a note or journal body from a frame. A note or journal
  record the frame changes (applied or merged) owes its whole body exactly as a
  pulled record does (chapter 07 §7.17.5), including the withheld snapshot
  claim (chapter 07 §7.7.1); the pull that follows the frame pays it. A frame
  item skipped as already applied owes nothing: whatever applied that version
  owed it then.
- A client MUST commit each item's row, its conflict push-back and its body
  debt together or not at all, and MUST journal the item's file operations
  before that commit, exactly as a pull page does, so a failed or interrupted
  file operation is healed by the journal replay (#2385).
- A client whose conflict push-back is a coalescing outbox row MUST NOT apply
  socket items while a push of that outbox is awaiting its response (chapter 06
  §6.6.2). It MAY wait for the push to settle within its own deadline.
- **Merge gate (#2300).** The latency gate reads the combined `e2e_latency`
  metric, pull and socket sources together, not the socket source alone: the
  socket path samples only frames it applied, and dropped frames reach the
  device through the pull. Both sources emit one sample per changed row.

**Desktop.** `WebSocketManager` sends both headers with the types its HTTP
requests declare (`apps/desktop/src/main/sync/websocket.ts:125-126`). On a frame
with items the engine fires the socket applier and schedules the wake pull
unconditionally (`apps/desktop/src/main/sync/engine.ts:964-965`). The applier
(`apps/desktop/src/main/sync/engine/socket-apply.ts:105`) runs frames one at a
time in arrival order (`:265`). It skips a frame while sync is paused, offline,
cancelled, stopped or in a full sync, and when `cursor` is at or below the
larger of `LAST_CURSOR` and the owned-through mark
(`apps/desktop/src/main/sync/engine/pull-coordinator.ts:114`, `:343`). It
applies at most 50 items of a frame; the rest are left to the pull. It drops
quarantined items, then decrypts and verifies signatures with the pull's batch
decrypt. It then waits until no pull page transaction is open, every journaled
page file op has landed (`apps/desktop/src/main/sync/bulk-apply.ts:166-195`)
and no push is in flight
(`apps/desktop/src/main/sync/engine/push-coordinator.ts:71`, `:76`), for at
most 5 s together, and drops the frame otherwise, with one diagnostic per
session naming the cause (`page_apply` or `push_in_flight`). Only the push
that set the in-flight gate clears it; the stale-lock watchdog resets it for a
push it abandons (`apps/desktop/src/main/sync/engine.ts:853`). The last check
runs in the applier's own continuation
(`apps/desktop/src/main/sync/engine/socket-apply.ts:221`), and from it through
the eligibility and cursor re-checks to the last note file write nothing is
awaited, so neither a page nor a push can start in between.

The frame then applies in its own page session, exactly as a pull page
(`apps/desktop/src/main/sync/engine/socket-apply.ts:134`): one transaction on
both DBs, each item on a SAVEPOINT (`:139`) that holds its apply through the
pull's `ItemApplier`, its conflict requeue (`:145`) and, for a note or journal
record it applied or merged, its body debt through the pull's `oweRecordBody`
(`:147`), in the pull's order. A throw rolls the item back with its file ops
and renderer events (`apps/desktop/src/main/sync/bulk-apply.ts:331`), and the
frame goes on. The note file ops are journaled before COMMIT and landed
synchronously in the same run (`apps/desktop/src/main/sync/bulk-apply.ts:483`,
`apps/desktop/src/main/sync/engine/socket-apply.ts:179`). A failed write or
unlink stays in the journal and keeps the applier waiting until the replay at
the start of the next pull heals it, and the wake pull that follows every frame
runs that replay. The `ItemApplier` keeps the pending-delete refusal, the
sync-intent deferral and the tombstone clock record unchanged. Renderer events
go out after COMMIT and only for rows the apply changed. Its dependencies can
read the cursor and cannot write it. Latency samples are one per changed row
under the pull's per-run cap, counted per minute
(`apps/desktop/src/main/sync/engine/sync-latency-telemetry.ts:128`).

**Rust core.** It sends neither header, so its sockets receive hint-only
frames.
