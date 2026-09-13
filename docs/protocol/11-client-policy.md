# 11 — Client policy: identity, version floor, kill switch

**Status**: normative. Every normative sentence carries a `path:line` citation
(chapter 00 §0.1).

This is the only version-skew mechanism on the HTTP path (chapter 00 §0.1, rule
2). There is no protocol handshake; there is this header and a server-side
policy row.

## 11.1 The header

**Normative.** The header name is `x-memry-client`, lowercase in both constants
(`apps/sync-server/src/lib/client-identity.ts:8`,
`packages/sync-client/src/pull/client-header.ts:3`). It is the only sync header
written lowercase; `X-Memry-Sync-Types` and `X-Memry-Vault-Id` are TitleCase
(chapter 05 §5.2).

## 11.2 Grammar

**Normative.**

```
<platform>/<major>.<minor>.<patch>[+<build>]
```

matched by
`/^([a-z]+)\/(\d+)\.(\d+)\.(\d+)(?:\+([0-9A-Za-z.-]+))?$/`
(`apps/sync-server/src/lib/client-identity.ts:26`). The builder is
`` `${platform}/${appVersion}` ``
(`packages/sync-client/src/pull/client-header.ts:15-17`).

`platform` MUST be one of `CLIENT_PLATFORMS` = `ios | android | desktop`
(`packages/contracts/src/sync-api.ts:263`, checked at
`apps/sync-server/src/lib/client-identity.ts:28-29`, `:50-53`). This is **not**
the device-registration platform enum (chapter 02 §2.12).

The `+build` suffix is **recorded and never compared**
(`apps/sync-server/src/lib/client-identity.ts:16-17`, `:58`).

**Pre-release identifiers are rejected on purpose.** The floor comparison is a
numeric triple compare (`apps/sync-server/src/lib/client-identity.ts:67-81`), so
accepting `1.0.0-beta.1` would let a beta satisfy a floor its release does not
(`apps/sync-server/src/lib/client-identity.ts:20-25`). A client MUST NOT try to
smuggle one through (`packages/sync-client/src/pull/client-header.ts:11-13`).

## 11.3 Absent and malformed are the same case

**Normative.** `parseClientIdentity` returns `null` for an absent header, an
empty header, a header that fails the pattern, and a header naming an unknown
platform (`apps/sync-server/src/lib/client-identity.ts:37-53`). All four are
**treated as absent**, which means legacy desktop and full access.

The reason is on record: **a parser bug must never be able to lock a paying user
out of their own vault** (`apps/sync-server/src/lib/client-identity.ts:31-35`).
The no-header branch must also stay free of database work, because it is the
branch every currently-shipped build takes
(`apps/sync-server/src/middleware/client-gate.ts:36-38`).

**A client SHOULD verify its own header against the server's grammar before
sending**, because a malformed value silently opts it out of the write gate
rather than failing loudly
(`packages/sync-client/src/pull/client-header.ts:19-23`).

## 11.4 Reads are never gated

**Normative.** `GET`, `HEAD` and `OPTIONS` bypass **both** the version floor and
the kill switch (`apps/sync-server/src/middleware/client-gate.ts:13`, `:34`), so
a device dropped to read-only can still open every note it owns.

Parsing, by contrast, is **unconditional** and runs on reads too, because
downstream handlers read the identity for write attribution and for the policy
echo on status (`apps/sync-server/src/middleware/client-gate.ts:28-32`).

Parsing and gating live in **one** middleware deliberately: splitting them meant
a router could be mounted with the gate but without the parser, which fails open
silently (`apps/sync-server/src/middleware/client-gate.ts:17-21`).

## 11.5 The kill switch is evaluated before the version floor

**Normative** (`apps/sync-server/src/services/client-policies.ts:43` precedes
`:45-50`). When writes are off for a platform, answering
`CLIENT_UPGRADE_REQUIRED` would send users chasing an update that cannot help
them (`specs/001-mobile-app/contracts/sync-protocol-additions.md:46-48`).

## 11.6 Responses

**Normative** (`apps/sync-server/src/middleware/client-gate.ts:44-65`):

| Condition                        | Status  | Body                                                                      |
| -------------------------------- | ------- | ------------------------------------------------------------------------- |
| kill switch on for this platform | **403** | `{"error":{"code":"PLATFORM_WRITES_DISABLED","message":…}}`               |
| client version below the floor   | **426** | `{"error":{"code":"CLIENT_UPGRADE_REQUIRED","message":…,"minVersion":…}}` |

**`minVersion` rides _inside_ the `error` object, not at the top level**
(`apps/sync-server/src/middleware/client-gate.ts:56-63`, and the contract
sketch's correction at `:23-25`).

## 11.7 An unreadable policy degrades to allow

**Normative** (`apps/sync-server/src/services/client-policies.ts:34-52`). Every
one of these resolves to **allowed**:

| Condition                                                     | Line                                     |
| ------------------------------------------------------------- | ---------------------------------------- |
| no policy row for the platform                                | `:38`                                    |
| `min_write_version` is NULL or blank                          | `:46`                                    |
| `min_write_version` is not a plain `major.minor.patch` triple | `:49` (`compareVersions` returns `null`) |

Only `writes_enabled === 0` (`:43`) and a strictly-below comparison (`:50`) deny.
**An unreadable policy table degrades to today's behaviour, never to a lockout**
(`specs/001-mobile-app/contracts/sync-protocol-additions.md:48-50`).

## 11.7.1 `Unentitled` does not come from the policy

**Normative.** The three write-blocked states are not read from one place, and
conflating them is how a client ends up polling `clientPolicy` for an answer it
will never contain.

| State            | Source                                                                                  |
| ---------------- | --------------------------------------------------------------------------------------- |
| `ReadOnly`       | `clientPolicy.writesEnabled === false` (§11.8)                                          |
| `BlockedUpgrade` | `clientPolicy.minWriteVersion` above this build (§11.8)                                 |
| `Unentitled`     | **a `402` carrying `SYNC_PAYMENT_REQUIRED`** from any `/sync/*` route (chapter 00 §0.5) |

`clientPolicy` carries `platform`, `writesEnabled` and `minWriteVersion` and
**no entitlement field**, so entitlement is only ever learned by being told
`402`. A client therefore enters `Unentitled` reactively and must not try to
predict it.

Consistent with §11.3, an entitlement that has never been contradicted is
treated as **present**: a client starts entitled and is demoted by a `402`,
never the reverse. Starting from "unentitled until proven otherwise" locks a
paying user out of writes whenever the first status call fails.

**Leaving `Unentitled` is not a sync-tier event.** The state is reached
reactively and there is no polled field that clears it: `clientPolicy` carries
no entitlement, and a client whose outbox is parked attempts no write that
could earn a 2xx and prove the plan is back. So the sync tier cannot recover on
its own, and a client MUST NOT invent a probe write to find out.

It is cleared by the **account tier** — the layer that knows about
subscriptions — telling the sync tier the plan is active again, after a
purchase or a billing refresh. Data-model §C.3's `Unentitled -> Idle` edge is
that, not a status poll.

**Only `SYNC_PAYMENT_REQUIRED` demotes.** `SYNC_VAULT_LIMIT_EXCEEDED` is also a
`402` (chapter 00 §0.5) and means the opposite thing: the plan is active and a
limit inside it was hit. Treating it as an entitlement failure tells a paying
user to buy a plan they already have.

## 11.8 Policy is discoverable without attempting a write

**Normative.** `GET /sync/status` echoes
`clientPolicy: { platform, writesEnabled, minWriteVersion? }`
(`packages/contracts/src/sync-api.ts:275-287`,
`apps/sync-server/src/services/client-policies.ts:61-62`) **when the request
identified itself**, and omits it entirely for a legacy client
(`packages/contracts/src/sync-api.ts:271-273`).

`writesEnabled` defaults to `true` when there is no row
(`apps/sync-server/src/services/client-policies.ts:61`), and `minWriteVersion` is
present only when a non-empty floor exists (`:62`).

A pull-only client learns about a flipped switch this way
(`packages/sync-client/src/pull/engine.ts:454-465`).

### 11.8.1 Poll interval — Q11.2

**Normative.** A conforming client MUST refresh `clientPolicy` from
`GET /sync/status`:

- on every transition to foreground;
- immediately before draining a parked outbox;
- on an interval of **at most 300 seconds** while in the foreground.

300 s is chosen to match `CLOCK_SKEW_THRESHOLD_SECONDS` (chapter 05 §5.16), so a
client that already polls status for skew gets policy for free, and it sits far
inside the `sync_status` budget of 60 requests per 60 s
(`apps/sync-server/src/routes/sync.ts:246-247`).

**There is no push channel for a flipped switch.** The WebSocket's `error` frame
carries only `WS_RATE_LIMITED` and `WS_TOKEN_EXPIRED` (chapter 09 §9.5), and no
broadcast type conveys policy. A client MUST NOT wait for one.

**A flipped switch therefore takes effect without a restart** — which is what
FR-035 and the FR-070 beta gate require — **because the client polls, not because
the server pushes.**

**Disposition of Q11.2: answered** (this section).

## 11.9 Client obligations on either code

**Normative** (`specs/001-mobile-app/contracts/sync-protocol-additions.md:56-59`;
reference implementation `apps/mobile/src/sync/outbox.ts:259`, `:364-369`,
`:706-733`). On `CLIENT_UPGRADE_REQUIRED` or `PLATFORM_WRITES_DISABLED` a client
MUST:

1. enter an **explicit read-only mode**, with a plain explanation and an update
   path;
2. **park** the outbox: queued writes are preserved, attempts stop, and **no
   attempt accrues backoff** — a parked queue must drain at full speed the moment
   the policy clears;
3. poll the policy on foreground and on interval (§11.8.1);
4. **resume automatically when clear**, with no user action and no restart.

A client MUST NOT discard queued writes, and MUST NOT present either code as a
sync failure the user can retry.

## 11.10 Write attribution

**Normative.** The server stamps `client_platform` and `client_version` from the
header on `sync_items`, `crdt_updates` and `crdt_snapshots`; **NULL means a
pre-header client**
(`specs/001-mobile-app/contracts/sync-protocol-additions.md:73-80`). The CRDT
pair is included deliberately: a note's body lands there, and that is the payload
most likely to need a targeted rollback.

**Only the semver triple is persisted**; the `+build` suffix is parsed and
dropped, because build numbers are not orderable across release branches
(`specs/001-mobile-app/contracts/sync-protocol-additions.md:83-85`).

### 11.10.1 Attribution records the latest writer — Q11.3

**Normative.** After a desktop rewrite of a row an iOS device first created, the
row is **no longer mobile-originated**
(`specs/001-mobile-app/contracts/sync-protocol-additions.md:81-83`).

**The consequence an incident responder must know: a targeted rollback window is
bounded by how fast other platforms touch rows, not by how long ago the bad
writes happened.** A rollback that selects on `client_platform = 'ios'` recovers
only the rows no desktop has since rewritten. There is no creator column and this
specification does not add one; the mitigation is to flip the kill switch (§11.5)
early, which stops further writes while attribution still identifies them.

**Disposition of Q11.3: answered** (this section).

## 11.11 Two version gates coexist — Q11.1

**Normative.** There are two independent gates and they use different headers,
different floors and different mechanisms:

|        | HTTP write gate                                                       | WebSocket gate                                                   |
| ------ | --------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Header | `x-memry-client`, `<platform>/<semver>`                               | `X-App-Version`, a bare semver                                   |
| Floor  | `client_policies.min_write_version`, **per platform**, a database row | `MIN_APP_VERSION`, a **deployment-wide** environment value       |
| Scope  | write methods only (§11.4)                                            | the whole socket                                                 |
| Answer | 403 or 426 (§11.6)                                                    | 426 `SYNC_VERSION_INCOMPATIBLE` at handshake (chapter 09 §9.2)   |
| Where  | `apps/sync-server/src/middleware/client-gate.ts:27-66`                | `apps/sync-server/src/durable-objects/user-sync-state.ts:99-122` |

**A client MUST satisfy both, and MUST send both headers.** The two version
strings may be the same application version; they are carried in different
headers because the two gates are configured independently.

**The read-only UI reacts to the HTTP gate only.** The socket gate is not a
read-only condition: it is advisory-channel loss (chapter 09 §9.1), and a client
that presented it as read-only would tell the user writes are blocked when they
are not. A 4009 close latches the socket off for the session (chapter 09 §9.9)
and changes nothing else.

**Is the duplication intended?** The HTTP gate is per-platform and flippable with
one config change, no deploy (`specs/001-mobile-app/contracts/sync-protocol-additions.md:66-68`);
the socket gate is deployment-wide and predates it. **This specification records
the duplication rather than resolving it**: unifying them would change the
socket's failure mode for desktop clients that send no `x-memry-client` header at
all, and is a format change under chapter 00 §0.8 obligation 3.

**Disposition of Q11.1: answered (both gates are live and a client satisfies
both; the HTTP gate alone drives read-only mode).**
