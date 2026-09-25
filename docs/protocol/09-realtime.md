# 09 — Realtime

**Status**: normative. Every normative sentence carries a `path:line` citation
(chapter 00 §0.1).

The WebSocket is an **advisory wake-up channel**. It never carries data. Every
frame it delivers is a hint that the client should run its ordinary pull
(chapters 05 and 07).

## 9.1 Should a client open it at all — Q09.1

**Normative — the socket is optional.** A client that never opens it is
conforming and simply learns about remote changes on its next pull.

There is **no server push infrastructure for a suspended process**: the Durable
Object can only reach a socket that is currently open
(`apps/sync-server/src/durable-objects/user-sync-state.ts:217-228` iterates live
sockets), and nothing in the tree sends a platform push notification.

**When the socket is open depends on the surface**, because "backgrounded"
means different things for a process the OS suspends and for one that keeps
running:

- **A mobile surface MUST close the socket when the application is
  backgrounded, and SHOULD open it while in the foreground.** The OS suspends a
  backgrounded mobile app, so its socket cannot be serviced and every broadcast
  to it is a wasted wake. The Rust core leaves the lifecycle to the shell: it
  exposes `RealtimeClient::connect` and `RealtimeClient::disconnect`
  (`crates/memry-core/src/sync/socket.rs:297`, `:327`) and observes no app
  state itself. No mobile shell drives it yet
  (`apps/ios/Memry/App/ShellState.swift:173-179`).
- **A resident desktop process keeps the socket open for as long as the process
  runs and sync is started.** Closing the main window hides it to the tray and
  leaves the process running
  (`apps/desktop/src/main/index.ts:836-839`); losing window focus only records
  telemetry (`apps/desktop/src/main/index.ts:1614-1620`). Neither is a socket
  lifecycle event. Desktop disconnects only when the engine stops
  (`apps/desktop/src/main/sync/engine.ts:329`), the network drops (`:788`; a
  system `suspend` counts as offline,
  `apps/desktop/src/main/sync/network.ts:92-95`), the device is revoked
  (`apps/desktop/src/main/sync/engine/error-recovery-handler.ts:72`), or a
  close is terminal (`apps/desktop/src/main/sync/websocket.ts:180-201`, §9.9).

An idle desktop socket costs the server nothing. The Durable Object accepts it
through the hibernation API
(`apps/sync-server/src/durable-objects/user-sync-state.ts:181`) and answers the
client's `ping` with the registered `pong` auto-response without waking
(`:62`, §9.6). The client pings every 25 s and terminates the socket after 31 s
without a frame (`apps/desktop/src/main/sync/websocket.ts:12`, `:16`,
`:303-325`), so a half-open connection reports disconnected instead of being
trusted.

**On any surface, a client that returns to the foreground or regains a socket
MUST run a full pull rather than assuming the socket told it everything**:
broadcasts sent while it was away are gone. Desktop pulls on every socket
`connected` event and on network return
(`apps/desktop/src/main/sync/engine.ts:864-878`, `:736-770`).

**Disposition of Q09.1: answered** (this section).

## 9.2 Handshake

**Normative.** `GET /sync/ws`
(`apps/sync-server/src/routes/sync.ts:257`). **Authentication is handshake
headers only — never a query parameter and never a subprotocol**
(`packages/contracts/src/sync-socket.ts:10-14`).

| Header                                | Required        | Effect                                                                                                                                                                       |
| ------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Authorization: Bearer <accessToken>` | yes             | `401 AUTH_INVALID_TOKEN` when invalid (`apps/sync-server/src/durable-objects/user-sync-state.ts:88-97`)                                                                      |
| `X-App-Version: <semver>`             | **yes**         | absent is `426 SYNC_VERSION_INCOMPATIBLE` (`:99-110`)                                                                                                                        |
| `X-Memry-Vault-Id: <uuid>`            | effectively yes | defaults to `default` (`:149`); **a socket on the wrong vault connects and then hears nothing**, because every broadcast is filtered by the socket's attached vault (`:189`) |

Failures:

| Condition                       | Answer                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------ |
| invalid token                   | `401 AUTH_INVALID_TOKEN` (`:93-96`)                                                        |
| missing `X-App-Version`         | `426 SYNC_VERSION_INCOMPATIBLE` (`:101-109`)                                               |
| version below `MIN_APP_VERSION` | `426 SYNC_VERSION_INCOMPATIBLE` with `minVersion` **inside** the error object (`:112-121`) |
| unknown or revoked device       | `403 AUTH_DEVICE_REVOKED` (`:130-135`)                                                     |

A successful handshake answers `101` with the socket
(`apps/sync-server/src/durable-objects/user-sync-state.ts:161`).

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
(`apps/sync-server/src/durable-objects/user-sync-state.ts:137-141`).

A client MUST NOT open two sockets for one device: the second silently kills the
first.

## 9.4 Message envelope

**Normative.** `{ "type": string, "payload"?: object }`, serialised as JSON
(`packages/contracts/src/sync-socket.ts:51-57`;
`apps/sync-server/src/durable-objects/user-sync-state.ts:184`).

**`type` is deliberately a plain string, not an enum**, so a newer server can add
a type without an older client treating the frame as corrupt; unknown names parse
and are ignored (`packages/contracts/src/sync-socket.ts:52-54`). **A client MUST
NOT reject a frame for carrying an unknown `type`.**

## 9.5 Message types

**Normative.** The complete list the server can put on a socket
(`packages/contracts/src/sync-socket.ts:18-27`), with the payload each carries
and where it is produced:

| Type                         | Payload                                                                 | Producer                                                                                                                                                         |
| ---------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `changes_available`          | `{ cursor?, vaultId? }` (`packages/contracts/src/sync-socket.ts:59-62`) | the default broadcast type (`apps/sync-server/src/durable-objects/user-sync-state.ts:177`), sent after a record push (`apps/sync-server/src/routes/sync.ts:439`) |
| `crdt_updated`               | `{ vaultId?, noteId }` (`packages/contracts/src/sync-socket.ts:63-66`)  | after a CRDT update push (`apps/sync-server/src/routes/sync.ts:731`), a snapshot push (`:930`) and a batch (`:1062`)                                             |
| `calendar_changes_available` | `{ sourceId }`                                                          | the calendar webhook route (`apps/sync-server/src/routes/webhooks.ts:183-187`)                                                                                   |
| `auth_ok`                    | `{ exp? }` (`packages/contracts/src/sync-socket.ts:74`)                 | the in-place re-auth reply (§9.8)                                                                                                                                |
| `error`                      | `{ code?, message? }` (`packages/contracts/src/sync-socket.ts:75`)      | `WS_RATE_LIMITED` (`apps/sync-server/src/durable-objects/user-sync-state.ts:293-298`) and `WS_TOKEN_EXPIRED` (`:401-406`)                                        |
| `linking_request`            | `{ sessionId, newDeviceName, newDevicePlatform }`                       | `POST /auth/linking/scan` (`apps/sync-server/src/routes/linking.ts:155-163`)                                                                                     |
| `linking_approved`           | `{ sessionId }`                                                         | `POST /auth/linking/approve` (`apps/sync-server/src/routes/linking.ts:262-266`)                                                                                  |
| `heartbeat`                  | **none**                                                                | **no producer**; see §9.5.2                                                                                                                                      |

### 9.5.1 Calendar and linking payload shapes — Q09.3

`calendar_changes_available`, `linking_request` and `linking_approved` are in
`SYNC_SOCKET_MESSAGE_TYPES` (`packages/contracts/src/sync-socket.ts:21`, `:25`,
`:26`) and have payload schemas in the contract
(`packages/contracts/src/sync-socket.ts:67-73`), so `parseSyncSocketFrame`
narrows them to `{ kind: 'calendar_changes_available', sourceId }`,
`{ kind: 'linking_request', sessionId, newDeviceName, newDevicePlatform }` and
`{ kind: 'linking_approved', sessionId }` (`:138-149`). Desktop parses every
frame through that helper (`apps/desktop/src/main/sync/websocket.ts:154-166`).
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

`heartbeat` is in the type list (`packages/contracts/src/sync-socket.ts:22`),
has no payload schema, and **has no producer anywhere in
`apps/sync-server/src`**. `parseSyncSocketFrame` collapses it to `ignored`
(`packages/contracts/src/sync-socket.ts:158-159`), which desktop drops with a
debug log (`apps/desktop/src/main/sync/websocket.ts:161-164`).

**Normative — `heartbeat` is dead. There is no server-initiated keepalive.** The
keepalive is client-initiated and is §9.6. A client MUST ignore a `heartbeat`
frame if one ever arrives and MUST NOT use its absence as a liveness signal.

**Disposition of Q09.2: answered (dead; the keepalive is client-initiated).**

## 9.6 Keepalive must be exactly `ping`

**Normative.** The client sends the literal text frame `ping` and the server
answers `pong` (`packages/contracts/src/sync-socket.ts:39-40`).

The Durable Object registers
`new WebSocketRequestResponsePair('ping', 'pong')`
(`apps/sync-server/src/durable-objects/user-sync-state.ts:59`), so Cloudflare
answers **that one payload** without waking the object or spending the socket's
inbound rate-limit budget. **Any other keepalive text is a real message that
costs a wake on every beat and consumes rate-limit budget**
(`packages/contracts/src/sync-socket.ts:32-37`).

Reference cadence: send `ping` every **25 s**
(`apps/desktop/src/main/sync/websocket.ts:15`, `PING_INTERVAL_MS = 25_000`,
started at `:301-307`), and terminate the socket if no frame arrives within the
heartbeat timeout (`apps/desktop/src/main/sync/websocket.ts:317-323`).

## 9.7 Inbound rate limit

**Normative.** 100 inbound messages per 10 seconds per socket
(`apps/sync-server/src/durable-objects/user-sync-state.ts:19-20`). On overrun the
server sends an `error` frame carrying `WS_RATE_LIMITED` and then closes with
**4008** (`:292-300`).

The `ping`/`pong` auto-response does not count against this budget (§9.6), which
is the whole reason the keepalive text is fixed.

## 9.8 Re-authentication in place

**Normative.** The client sends

```json
{ "type": "auth", "payload": { "token": "<fresh access token>" } }
```

(`packages/contracts/src/sync-socket.ts:104-107`) and the server answers `auth_ok`
with the new `exp`
(`apps/sync-server/src/durable-objects/user-sync-state.ts:304-308`).

**Rejection is non-fatal**: the socket keeps its existing `tokenExp` and the
alarm closes it at the original expiry, which is the pre-renewal behaviour
(`apps/sync-server/src/durable-objects/user-sync-state.ts:315-320`).

A conforming client SHOULD re-authenticate in place whenever it refreshes its
access token (chapter 02 §2.10), rather than tearing the socket down.

## 9.9 Close codes

**Normative** (`packages/contracts/src/sync-socket.ts:42-49`, mirrored at
`apps/sync-server/src/durable-objects/user-sync-state.ts:22-26`):

| Code | Name                  | Cause                                                                                                       | Reconnectable                |
| ---- | --------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------- |
| 4001 | `replaced`            | another socket connected for this device (§9.3)                                                             | yes                          |
| 4003 | `tokenExpired`        | the alarm sweep found `tokenExp <= now` (`apps/sync-server/src/durable-objects/user-sync-state.ts:399-411`) | yes, **after** a refresh     |
| 4004 | `deviceRevoked`       | the device was revoked                                                                                      | **terminal**                 |
| 4008 | `rateLimited`         | §9.7                                                                                                        | yes                          |
| 4009 | `versionIncompatible` | the app version floor                                                                                       | **terminal for the session** |

**4004 and 4009 are terminal.** A conforming client MUST latch reconnection off
for both — for 4004 by signing the device out, for 4009 until the application is
updated (`apps/desktop/src/main/sync/websocket.ts:178-200`, where 4004 clears
`shouldBeConnected` and 4009 sets `versionRejected`).

## 9.10 Reconnect and backoff — Q09.4

**Normative.** A reconnect policy exists in the reference implementation
(`apps/desktop/src/main/sync/websocket.ts:12-15`, `:333-348`) and this chapter
adopts it:

| Constant                  | Value  | Line  |
| ------------------------- | ------ | ----- |
| `BASE_RECONNECT_DELAY_MS` | 1 000  | `:13` |
| `MAX_RECONNECT_DELAY_MS`  | 30 000 | `:12` |
| `RECONNECT_JITTER_MS`     | 500    | `:14` |

```
delay = min(BASE * 2^attempt + random()*JITTER, MAX)
```

(`apps/desktop/src/main/sync/websocket.ts:338-342`), with `attempt` incremented
per scheduled reconnect (`:344`) and **reset to zero on a successful open**.

A reconnect MUST NOT be scheduled when any of these latches is set:
the client no longer wants a connection, the handshake was rejected `401`, the
version was rejected, or transport pinning failed
(`apps/desktop/src/main/sync/websocket.ts:334-335`). A reconnect MUST only fire
when the device believes it is online (`:348`).

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
`Hint::ChangesAvailable` carries (`crates/memry-core/src/sync/socket.rs`). The
periodic pull stays the fallback for a missed broadcast.

**A device is excluded from its own broadcast** by `excludeDeviceId`
(`apps/sync-server/src/durable-objects/user-sync-state.ts:188`), and a broadcast
carrying a `vaultId` reaches only sockets attached to that vault (`:189`).

Delivery is best-effort: a send that throws because the socket closed between
enumeration and send is swallowed
(`apps/sync-server/src/durable-objects/user-sync-state.ts:191-196`). **A client
MUST NOT treat a missed broadcast as data loss.**

## 9.12 Frame parsing rules

**Normative** (`packages/contracts/src/sync-socket.ts:113-160`):

- **`null` is returned only when the frame is not a message envelope at all** —
  bad JSON, or no `type` (`:116-124`). That is the only case worth logging.
- Everything else collapses to a single `ignored` outcome: the keepalive answer
  (`:114`), a type with no handler (`:158-159`), and **a known type whose payload
  does not carry what it needs** (`:132`, `:136`, `:140`, `:144`, `:148`, `:152`,
  `:156`).
- **An unrecognised frame MUST never reach a throw**
  (`packages/contracts/src/sync-socket.ts:83-87`).
