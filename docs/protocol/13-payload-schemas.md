# 13 — Payload schemas

**Status**: normative. Every normative sentence carries a `path:line` citation
(chapter 00 §0.1).

The payload is the plaintext inside the record envelope of chapter 04: UTF-8
JSON. This chapter specifies what it contains per type, and — more importantly —
how a client is required to store it.

## 13.1 The twenty-one subscribed types

**Normative.** This feature's client declares exactly these twenty-one in
`X-Memry-Sync-Types` (chapter 05 §5.3), in this order:

`note`, `journal`, `folder_config`, `custom_icon`, `tag_definition`,
`tag_category`, `property_definition`, `template`, `task`, `project`,
`task_activity`, `reminder`, `settings`, `filter`, `inbox`, `calendar_source`,
`calendar_event`, `calendar_external_event`, `calendar_binding`, `bookmark`,
`canvas`.

`filter` (saved task filters, §13.7.14) was added by spec 004 TP022 and is
appended last, so the first thirteen keep their order. `inbox` (captures,
§13.7.15) was added by spec 006 IB012 and is appended after it. The four
calendar types (§13.7.16–§13.7.19) were added by spec 007 CL010 and are appended
last, in chapter 05's apply order (source, event, external event, binding).
`bookmark` (the sidebar's bookmarks, §13.7.20) was added for the phone's
Notes root and is appended after them. `canvas` (whiteboards, §13.7.21) was
added for the phone's whiteboard block and is appended last.

Six more **record types** are served by the server and **not** subscribed to
here: `agent_conversation` and `agent_message` (desktop agent chats,
§13.7.26, §13.7.27), `canvas_folder` (canvas folders,
§13.7.23), `home_page` (Home boards, §13.7.24, §13.11),
`vault_lock` (desktop read-only locks, #2606, §13.7.22), `sticky_draft`
(unsent desktop sticky text, §13.7.25, §13.13).
**The iOS client omits them from the header and never sees them**
(chapter 05 §5.3.1); desktop declares them. The Rust core lists them as
`DESKTOP_ONLY_RECORD_ITEM_TYPES`
(`crates/memry-core/src/protocol/types.rs:71-84`), and desktop passes a
declaration that carries them to `Vault::sync_with_declaration`
(`crates/memry-core/src/api/vault.rs:115-132`), which is not on the FFI
surface, so iOS keeps `Vault::sync` and the twenty-one.

Twenty-one plus six is the **twenty-seven record types**, which is the set
chapter 05 §5.3 calls recognised. `attachment` is the twenty-eighth member of
`SYNC_ITEM_TYPES` and is **not** one of them: it never travels as a record at
all (§13.8), so it is neither subscribed nor declarable.

## 13.2 Verbatim payload preservation — Q13.2

**This is the whole of FR-033 and it binds every other chapter that describes a
payload.**

**Normative.** A conforming client MUST:

1. **persist the decrypted payload bytes exactly as received**;
2. treat every payload schema in this chapter as a **reader over a copy**, never
   as the storage shape;
3. on a local edit, parse a copy, merge the changed keys into it, serialise that
   merged object **with unknown keys intact**, and push the result;
4. **never re-serialise a projection row as the payload**;
5. record a payload that fails its schema as **corrupt or unapplied**, rather
   than skipping it and advancing the cursor.

The platform-free engine establishes rules 1 and 2: it decrypts to
`payloadJson: new TextDecoder().decode(content)`
(`packages/sync-client/src/pull/engine.ts:281`) and parses only a throwaway
copy for `fileType` (`:307-308`), with the contract stated at
`packages/sync-client/src/pull/store.ts:5-9`, `:17`. The Rust core obeys it:
the received string goes into `sync_items.payload` unchanged
(`crates/memry-core/src/storage/repositories/sync_items.rs:399`, `:428`),
projections come from a parsed copy (`:147-148`), a local edit merges the
changed keys into that copy and stores the result
(`crates/memry-core/src/storage/repositories/payload.rs:64-72`), and a push
sends the stored string (`crates/memry-core/src/storage/repositories/sync_items.rs:285-287`).

### 13.2.1 Desktop meets the obligation by a different mechanism (#2183)

Desktop does not satisfy rules 1 to 4 literally — it still parses and projects —
but it no longer loses unknown keys, which is what those rules exist to protect.
`apply-item.ts` parses and then runs
`handler.schema.parse(parsed)`
(`apps/desktop/src/main/sync/apply-item.ts:93-95`); **every handler schema is a
plain `z.object`** — there is no `passthrough`, `loose` or `catchall` anywhere in
`packages/contracts/src/sync-payloads.ts` — and Zod strips unknown keys at every
level. The parsed data is projected into columns
(`apps/desktop/src/main/sync/item-handlers/task-handler.ts:272-288`) and pushed
back by **re-serialising the projection row**
(`apps/desktop/src/main/sync/item-handlers/task-handler.ts:373-378`); the
verbatim string is kept nowhere.

`task-handler.ts:278-284` documents exactly this loss for `linkedCanvasIds`, and
works around it with a presence guard.

**Instead of the verbatim payload, desktop keeps the remainder.** On apply it
diffs the raw parsed JSON against the schema result and stores every stripped
top-level key verbatim in `sync_unknown_fields`
(`apps/desktop/src/main/sync/unknown-fields.ts`); on push,
`resolvePushPayload` merges that remainder back underneath the freshly built
payload, locally built keys winning
(`apps/desktop/src/main/sync/engine/push-coordinator.ts`). The observable
round-trip guarantee of rules 1 to 4 holds: a field written by a newer client
survives an older desktop's edit. Keys stripped from inside a known object are
kept as key paths in `sync_unknown_fields.nested_fields` and merged back only
into a parent object the push payload still has. **The remaining ceiling is
arrays**: an unknown key inside an array element is still stripped, where a
verbatim implementation would keep it.

Rule 5 is met by the schema-invalid ledger (#2285): an item whose payload fails
`parse` returns `'schema_invalid'` from `apps/desktop/src/main/sync/apply-item.ts`
and the pull records it for a retry
(`apps/desktop/src/main/sync/engine/schema-invalid-ledger.ts`) instead of
skipping past it.

**#2183** is closed by #2265 (top-level keys), #2285 (rule 5) and the nested-key
capture above.

### 13.2.2 The wire envelope is a different matter

**Normative, and harmless.** `RecordPullItemResponseSchema`
(`packages/sync-client/src/pull/engine.ts:209`) and
`EncryptedItemPayloadSchema` (`packages/contracts/src/sync-api.ts:321-326`)
strip unknown **envelope** keys, not payload keys, and the signature covers only
the ten allowlisted keys (chapter 04 §4.7.3). A client MAY reject an unknown
envelope key; it MUST NOT reject an unknown payload key.

### 13.2.3 Core obligation

Store the payload verbatim as `TEXT` or `BLOB`. Project through an untyped JSON
value, or a struct carrying a flattened `extra` map. **A plain derived
deserialise-then-reserialise reproduces desktop's original bug exactly**, and
desktop's remainder table is a retrofit, not the shape to copy — it only reaches
the top level.

**Named exception: agent text at rest** (#3533). An `agent_conversation`'s
`title` and an `agent_message`'s `content` and `attachments`
(`crates/memry-core/src/crypto/agent_payload.rs:30-39`) are stored in
`sync_items.payload` and in their projection columns as the chapter 04 §4.17
envelope text of the value, not as received. Electron keeps these three in
sealed columns (chapter 04 §4.17), and a verbatim store would put the
plaintext in `data.db`. The exception is bounded:

- **Sealed-pending is decided when the payload is written, never from its
  shape.** A plain title can look like an envelope, so no reader guesses. The
  owner of the fact is the `agent_sealed_pending` table, one row per record
  whose sealed keys are stored plain
  (`crates/memry-core/src/storage/migrations/data/0028_agent_records.sql:18-26`,
  `:62-66`; `crates/memry-core/src/storage/repositories/projectors/agent.rs:63-92`).
  Projections read it and leave the sealed columns empty for a pending record
  (`crates/memry-core/src/storage/repositories/projectors/agent.rs:100`,
  `:140`, `:177-183`), so a rebuild from `sync_items` reproduces them.
- **Apply seals** the three keys under the installed key before the payload is
  stored and leaves every other key, unknown keys included, as received. It
  seals whatever it is given, a value already shaped like an envelope
  included (`crates/memry-core/src/domain/agent_records.rs:84-112`,
  `crates/memry-core/src/crypto/agent_payload.rs:47-60`). With no key
  installed it stores the payload as received and marks it sealed-pending in
  the same transaction (`crates/memry-core/src/domain/agent_records.rs:101`,
  `:107-110`). A concurrent conversation merge without a key keeps a sealed
  local title sealed and marks the record pending when the stored title is
  plain: the local record was pending, or the remote's title won
  (`crates/memry-core/src/domain/agent_conversation/merge.rs:98-104`,
  `:120-123`). A local title edit seals the title and clears the mark
  (`crates/memry-core/src/domain/agent_conversation/mod.rs:173-177`).
- **A sealed value that does not open is an error, whatever its shape.** Under
  the installed key a value of a record that is not pending must open: one
  sealed under another key, an envelope of a version this build does not read
  (§0.2), altered bytes, or a value that is not an envelope at all fails
  (`crates/memry-core/src/crypto/agent_payload.rs:70-97`). A read returns the
  error (`crates/memry-core/src/domain/agent_records.rs:56-76`). A merge
  refuses the remote before the gate, so the pull records it corrupt and the
  local record stays as it is
  (`crates/memry-core/src/domain/agent_conversation/merge.rs:67-68`,
  `:129-156`). A push holds the row in the outbox with a backoff, never sends
  it sealed and never retires it, as it does with no key installed
  (`crates/memry-core/src/sync/push.rs:248-260`, `:338-369`). Electron
  likewise never reinterprets such a row: when the vault key changes it
  deletes the agent rows (`apps/desktop/src/main/crypto/vault-key-state.ts:35-62`,
  `:95-99`, `:150-162`).
- **Push opens** the sealed keys of a record that is not pending before the
  record envelope is built, so the opened value equals the wire value and
  rules 3 and 4 hold for what leaves the device. A pending record is already
  the wire value and goes as stored, with or without a key
  (`crates/memry-core/src/crypto/agent_payload.rs:99-121`,
  `crates/memry-core/src/sync/push.rs:365`).
- **Installing a key** through `Vault::set_at_rest_key` refuses a key that does
  not match the vault's local key verifier (chapter 01 §1.4.2, `meta` key
  `vault.crypto.verifier.v1`) when one is stored, and installs nothing
  (`crates/memry-core/src/api/vault.rs:144-170`). Otherwise it seals exactly
  the sealed-pending records that are not flagged corrupt, unconditionally,
  and clears their marks, in one transaction; a record that will not seal is
  flagged corrupt and stays pending; the held agent rows are released
  (`crates/memry-core/src/domain/agent_records.rs:188-289`). With nothing
  pending and nothing held it opens no write transaction (`:203-205`).
  `secure_delete` is on for that transaction and restored after it, `FAST`
  included (`:206-217`), so SQLite zeroes the cells the seal frees, and a
  `wal_checkpoint(TRUNCATE)` follows. The checkpoint's result is read: when a
  reader still holds the WAL after the busy handler gives up, the call says so
  (`Sealed::wal_kept`) and the WAL may keep the plain pages until a later
  checkpoint overwrites them (`:162-169`, `:220`, `:305-314`). Neither step
  reaches copies SQLite made earlier with `secure_delete` off: a page split or
  an earlier free can leave plain bytes on a freelist page until the page is
  reused or the file is vacuumed.

**Rule 5 departs for the desktop-only types.** Where Electron's schema
refuses a `vault_lock`, `canvas_folder`, `home_page`, `sticky_draft`,
`agent_conversation` or `agent_message` payload (a `null` where the schema
has no `.nullable()`, a value of the wrong type, or `widgets` that is not a
string), the Rust core returns `Skipped` and writes nothing
(`crates/memry-core/src/domain/desktop_records/mod.rs:67-74`,
`crates/memry-core/src/domain/home_page/merge.rs:53-57`,
`crates/memry-core/src/domain/agent_records.rs:123-134`). `Skipped` only
counts the item (`crates/memry-core/src/sync/apply.rs:208`, `:552`): the
cursor moves past it and no later build fetches it again. Electron records
the same item in its schema-invalid ledger
(`apps/desktop/src/main/sync/engine/pull-coordinator.ts:634`, `:684`), which
fetches it again by id once another app version runs
(`apps/desktop/src/main/sync/engine/schema-invalid-ledger.ts:41-46`). A
payload that a newer build can read is therefore recovered by Electron after
an update and stays lost on the Rust core until the core keeps such a ledger.

**Disposition of Q13.2: answered** (this section).

## 13.3 The forward-tolerance convention

**Normative.** Almost every field on almost every payload is optional **on
purpose**: a payload written by a newer client must still parse on an older one,
so a missing or renamed field degrades to a skip rather than a whole-page parse
failure that advances the cursor past good data.

A client MUST NOT add a required field to an existing payload type.

## 13.4 Absent versus null

**Normative, and load-bearing.** It is stated in three separate schema comments
(`packages/contracts/src/sync-payloads.ts:314-315`, `:373-375`, `:380-381`):

- **`undefined` (key absent)** means the sender does not know the field; **the
  local value MUST be kept**.
- **`null`** is an **explicit clear**.

**Receiving handlers MUST gate on key presence, not on `?? existing`.** A `??`
treats an absent key as a clear, which silently erases a field every time an
older peer round-trips a row it could not model. Desktop's own junction-write
guard exists for exactly this reason
(`apps/desktop/src/main/sync/item-handlers/task-handler.ts:278-288`): an absent
key preserves the local rows, and **an explicit empty array still clears**, which
is how a real unlink travels.

## 13.5 `SyncTimestampSchema` — the cautionary fact

**Normative, and reproduced here in full because it is the most important
cautionary fact in this specification.**

`createdAt` and `modifiedAt` on `note` and `journal` accept **either a string or
a number**, normalising a number through `new Date(value).toISOString()`
(`packages/contracts/src/sync-payloads.ts:21-23`, applied at `:269-270` and
`:286-287`).

Why it exists (`packages/contracts/src/sync-payloads.ts:6-19`): the React Native
client wrote `Date.now()` — a number — where the schema said string. Every note a
phone edited failed `safeParse` on desktop, and the applier skipped the item and
advanced the cursor without retry: **the edit was accepted by the server, counted
as synced by the phone, and silently never applied anywhere else.** Six notes in
one staging vault were in that state before it was noticed.

**Fixing the writer alone is not enough**: those payloads are already on the
server, so a client that only accepts strings keeps rejecting them forever, on
every device that ever syncs the vault. **The union is permanent** and is
strictly a widening — a string still parses to itself.

A conforming client MUST accept both shapes and MUST emit the string shape.

## 13.6 Item id conventions

**Normative.** Some ids are not UUIDs:

- `tag_definition` ids are **tag names**;
- `folder_config` ids are **folder paths**;
- `settings` has exactly **one** item, `synced_settings`
  (`packages/sync-client/src/settings-sync.ts:171`,
  `packages/sync-client/src/settings-sync-keys.ts:12`).

**The sync bookkeeping key MUST therefore be `(type, id)` and never `id`
alone.** An id-only key made a project and a tag both named `inbox` share one
entry and corrupt each other's state
(`apps/desktop/src/main/sync/engine/sync-context.ts:118-124`).

## 13.7 Per-type field lists

Every schema below is a **reader** (§13.2). `clock` is `VectorClockSchema`
optional on every type; `fieldClocks` appears only where §13.9 says so.

### 13.7.1 `note` — `packages/contracts/src/sync-payloads.ts:230-246`

| Field                                                            | Type                                          | Rule                                                                                                                                   |
| ---------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `title`                                                          | string?                                       |                                                                                                                                        |
| `content`                                                        | string, nullable?                             | **a CRDT update push carries `content: null`** (chapter 07); non-null only on `create` and `duplicate` (chapter 12 §12.2, carve-out A) |
| `tags`                                                           | string[]?                                     | see chapter 12 §12.5.2 for the unresolved two-writer case                                                                              |
| `pinnedTags`                                                     | string[]?                                     |                                                                                                                                        |
| `emoji`                                                          | string, nullable?                             |                                                                                                                                        |
| `properties`                                                     | record, nullable?                             | **free-form: values only, never definitions** (`property_definition` carries those)                                                    |
| `aliases`                                                        | string[], nullable?                           | see §13.7.1.2; **absent or `null` keeps the receiver's list, `[]` clears it**                                                          |
| `fileType`                                                       | `markdown \| pdf \| image \| audio \| video`? | **binary types have no CRDT body**                                                                                                     |
| `mimeType`, `attachmentId`, `attachmentReferences`, `folderPath` | nullable?                                     |                                                                                                                                        |
| `cover`                                                          | object, nullable?                             | see §13.7.1.1; **absent keeps the receiver's cover, `null` removes it**                                                                |
| `createdAt`, `modifiedAt`                                        | `SyncTimestampSchema`?                        | §13.5                                                                                                                                  |

#### 13.7.1.1 `cover`

A note's cover image, the frontmatter keys `cover`, `coverFocus`, `coverFocusX`,
`coverZoom`, `coverHeight`, `coverCredit` and `coverCreditUrl`
(`packages/shared/src/cover-image.ts`). Those keys are reserved from
`properties`, so they travel in their own field:

| Field       | Type            | Rule                                                                                                    |
| ----------- | --------------- | ------------------------------------------------------------------------------------------------------- |
| `ref`       | string          | the `cover` value: a note-relative or `attachments/<noteId>/<file>` vault path, `wash:<id>`, or http(s) |
| `focus`     | number 0-100?   | vertical framing of an image, 0 top, 100 bottom; absent means centred                                   |
| `focusX`    | number 0-100?   | horizontal framing of an image, 0 left, 100 right; see below for absent                                 |
| `zoom`      | number 1-3?     | scale of an image around its focal point; see below for absent                                          |
| `height`    | number 120-480? | band height in CSS pixels; see below for absent                                                         |
| `credit`    | string?         | photographer name, written only with `creditUrl`                                                        |
| `creditUrl` | string?         | http(s) link to the photo's page                                                                        |

A vault image's bytes are not named here. They travel as an attachment the
owning note lists in `attachmentReferences` (chapter 14), and every client
materialises an attachment at `attachments/<noteId>/<basename(manifest.filename)>`,
so the path in `ref` names the same file on each device. A client writes an
image cover's file as a note attachment before it writes the ref.

`focusX`, `zoom` and `height` were added after the rest. A sender that knows
them sends all three with every image cover, defaults included (50, 1, 200).
A payload that omits them therefore came from an older sender, and a receiver
whose file has the same `ref` keeps its own values for them; for a different
`ref` it uses the defaults. A receiver writes none of the three at its default,
so an unframed note's frontmatter is unchanged. Each of the three is read on its
own (`.catch(undefined)`): a value out of range drops that field, not the cover.
An older receiver strips all three and renders the cover centred and unzoomed at
200px, exactly as before.

A sender that cannot read the note's frontmatter omits the key rather than
sending `null`. A receiver that cannot read the value treats it as absent
(`.catch(undefined)`), so an unreadable cover never fails the whole note. The
earlier iOS-only unknown key `coverImage` (`{url, offsetY}`, offset 0-1) is read
as a fallback when `cover` is absent and is never written.

#### 13.7.1.2 `aliases`

The note's other names, the frontmatter `aliases:` list, normalized as chapter
12 §12.7.2 describes. A sender that read the note's file sends the list it
read, `[]` when the note has none (`apps/desktop/src/main/sync/note-file-fields.ts:34`).
A sender that could not read the file omits the key. A receiver treats an
array, `[]` included, as the list to hold, and treats absent or `null` as "the
sender does not know" and keeps its own
(`apps/desktop/src/main/sync/item-handlers/note-handler-frontmatter.ts:16`;
the core's projector `crates/memry-core/src/storage/repositories/projectors/notes.rs:110`,
journal `:184-191`).

Builds before this rule never sent `aliases` from desktop, so their pushes keep
every peer's list. They also ignore a pulled list on update, until the user
upgrades and the next push carries it. A journal day follows the same rule
(`packages/contracts/src/sync-payloads.ts:369`).

### 13.7.2 `journal` — `:273-288`

Same shape as `note` minus the file fields, plus `date`.

Spelled out, because "same shape minus" left four fields ambiguous: a `journal`
carries `title`, `emoji`, `aliases`, `properties`, `tags` and `pinnedTags`
exactly as `note` does, and carries `date`. The file fields it does **not**
carry are `fileType`, `mimeType`, `attachmentId`, `attachmentReferences` and
`folderPath`. No committed vector exercises the four that were ambiguous, so
this is a clarification of intent rather than a change: a client that guessed
either way still passes today, and would have diverged the first time a journal
with an alias crossed between two ports.

**A newly created day carries no `title` at all — the key is absent, not
`null`.** §13.4's distinction is the whole reason this has to be written down: a
client that seeds `title: null` on create is making an explicit clear, and the
first peer to merge it wipes a title another device had already set. A day's
display name is derived from its `date` until someone titles it, and a derived
name is not a payload field.

**`date` is optional ONLY so a delete tombstone can omit it** (`:274-280`). A
create or update without it is rejected by **an explicit guard in the handler,
not by the schema**. Deletes never reach the payload parser: the applier
short-circuits `operation === 'delete'` and reads only the optional
`bodyStateVector` out of a `note` or `journal` tombstone (chapter 05 §5.8,
#3037). Both schemas list `bodyStateVector` as an optional string; it appears
only on a delete.

**An inbound `journal` record whose id is not `j<date>` is never projected** (§1.9.1). Its
body is merged into the day's `j<date>` item and its id is tombstoned.

### 13.7.3 `task` — `:39-65`

16 syncable fields (chapter 06 §6.7) plus `tags`, `linkedNoteIds`,
`linkedCanvasIds`, **`fields`**, `clock`, **`fieldClocks`**, `createdAt`,
`modifiedAt`.

`repeatConfig` is `z.unknown().nullable().optional()` (`:51`) — **opaque**, and
the only object-valued field in any field-merged list (chapter 06 §6.4.1).

`durationMinutes` is `z.number().nullable().optional()` (`:49`): the length of
a timed task in minutes. The write path keeps it a positive integer and only on
a task with a `dueTime`, and clears it in the same write that clears `dueTime`
(`packages/domain-tasks/src/commands.ts:612-614`); the wire reader stays loose
like every other field here. Desktop writes the key on both apply paths
(`apps/desktop/src/main/sync/item-handlers/task-handler.ts:299`, `:356`), so an
absent key applies as `null`, as it does for every scalar task column.

**Older builds.** No version byte moves for this field (chapter 06 §6.7).
What an older build does with it depends on whether it keeps unknown keys:

- A desktop build with the §13.2.1 remainder strips the key on parse, keeps it
  in `sync_unknown_fields`, and pushes it back under its own payload, so its
  edits carry the last `durationMinutes` it received. It does not apply the
  `dueTime` rule, so clearing the time there leaves a stale duration on the
  wire; readers ignore a duration on an untimed task, and the next clear on a
  newer build removes it.
- The Rust core keeps the verbatim payload (§13.2), so the key survives an edit
  on any iOS build.
- A desktop build from before #2265 drops the key, and its push omits it. When
  that push wins the document gate on a newer device, the absent key applies as
  `null` and the duration is lost on that task. Nothing else is corrupted.

**`fields` is not one of the sixteen, and chapter 06 §6.3 never merges it.** It is a
versioned map, joined by chapter 06 §6.11 on every apply path (§13.7.3.1).

#### 13.7.3.1 `fields`

The task's field values by field name (`:59`), declared as an opaque, nullable,
optional record that reads a non-object as absent (`:33-37`). **Normative**:

- An entry is `{ "v": <any JSON value>, "t": <integer >= 0> }`, keyed by the
  field name: the vault property key, case-sensitive, 1 to 200 characters on a
  local write (`packages/contracts/src/tasks-api.ts:63`). `v: null` is a removal.
  An entry MAY carry further keys, and a receiver MUST keep an entry whole: the
  join stores the winning entry as it arrived
  (`packages/shared/src/versioned.ts:114-135`).
- A relation value is an array of `memry://note/<id>` strings, even for a
  single-valued field (`packages/contracts/src/relation-uri.ts:48-52`).
- **Absent** means the sender does not model the key, as on every desktop
  build that predates this section. The receiver keeps its local map (§13.4) and heals it (chapter
  06 §6.11.4).
- **`null`** carries no version and MUST NOT be sent. A receiver treats it as
  no information: no write and no heal (`packages/shared/src/versioned.ts:116`).
- A value that is not an object MUST read as absent rather than fail the item
  (`.catch(undefined)`, the `cover` precedent of §13.7.1.1), and an entry that is
  not an object is dropped, never stored (`packages/shared/src/versioned.ts:87-96`).
- A sender that holds no map MUST omit the key. Desktop's NULL column is
  omitted by its one row-to-payload step (`packages/sync-client/src/task-wire.ts:8-14`),
  which builds the push rebuild, the seed and the sync service's payload
  (`apps/desktop/src/main/sync/item-handlers/task-handler.ts:423`, `:446`,
  `packages/sync-client/src/task-sync.ts:42`). `{}` is a valid empty map.

```json
"fields": {
  "Waiting on": { "v": ["memry://note/n_7Qx2"], "t": 2 },
  "Follow up": { "v": "2026-05-14", "t": 1 },
  "Thread": { "v": null, "t": 3 }
}
```

The Rust core projects it as `Field::opt_null("fields", Kind::Any)` with no
column (`crates/memry-core/src/storage/repositories/projectors/tasks.rs:83`). It
joins the map on every apply path and heals by chapter 06 §6.11
(`crates/memry-core/src/sync/versioned_apply.rs:39`, `:74`), stamps a local edit
(`crates/memry-core/src/domain/tasks/fields.rs:128`), pinned by
`crates/memry-core/tests/task_field_values.rs`, and copies the map to a duplicate and to a next
occurrence (`crates/memry-core/src/domain/tasks/create.rs:127`,
`crates/memry-core/src/domain/tasks/lifecycle.rs:35`), pinned by
`crates/memry-core/tests/versioned_keys_carry.rs`.

### 13.7.4 `project` — `:239-253`

`name`, `description`, `color`, `icon`, `position`, `isInbox`, `archivedAt`,
`homeNoteId`, `createdAt`, `modifiedAt`, `clock`, **`fieldClocks`**, plus two
nested arrays with their own schemas: `statuses` (`StatusSyncSchema`,
`:216-223`) and `links` (`ProjectLinkSyncSchema`).

### 13.7.5 `task_activity` — `:101-111`

`taskId`, `action`, `field`, `oldValue`, `newValue`, `actor`, `deviceId`,
`clock`, `createdAt`.

**Append-only and immutable**, hence **no `fieldClocks` and no `modifiedAt`**.
`oldValue` and `newValue` are JSON-encoded scalars and are always `null` for
`description`, because the body can be note-sized.

A task field value (§13.7.3.1) is logged as `field: "fields.<name>"`, one row
per changed field, and a string value over 500 characters is logged like
`description`: `oldValue` is `null` and `newValue` is `{"delta": n}`
(`apps/desktop/src/main/tasks/activity-log.ts:206-228`).

### 13.7.6 `template` — `:113-127`

`name`, `description`, `icon`, `tags`, `properties`, `content`, `clock`,
`createdAt`, `modifiedAt`.

**`properties` must stay an array** (`TemplatePropertySchema[]`, `:122`) or note
creation from the template throws.

**The element shape**, from `packages/contracts/src/templates-api.ts:102-117`:
`name` (non-empty string), `type`, `value` (**`z.unknown()`** — any JSON), and
optional `options` (`string[]`).

**Applying a template maps that array onto §13.7.1's free-form `properties`
record by name and value only**: `properties[prop.name] = prop.value`. `type`
and `options` are **discarded at note-creation time**. They are not lost — a
vault-wide `property_definition` carries the type (§13.7.9) — but nothing a
template says about a type reaches the note it creates. Where a caller supplies
its own properties too, **the caller's value wins**: the record is built
template-first and then overlaid.

**A template's `type` enum and `property_definition`'s vocabulary are not the
same list**, and a port MUST NOT treat either as the other's validator. The
template enum is closed at nine values and includes `rating`; §13.7.9's
enumeration includes `status` and `relation` and does not include `rating`. The
two were written for different purposes and have drifted. This is recorded as
an observation, not a rule to enforce — `type` is advisory on both sides and
neither list is a wire constraint on the other.

### 13.7.7 `tag_definition` — `:345-362`

`name` and `color` are **required**; `icon`, `categoryId`, `sortOrder`,
`colorAuthored`, `views`, **`schema`**, `clock`, `createdAt`.

- **`colorAuthored` absent means "cannot tell" and the receiver honours the
  colour**; only a sender that knows the field can say `false` (`:348-350`).
  A client that mints a definition on a palette colour MUST say `false`, or a
  peer holding the tag takes the palette's colour over the one its user picked
  (`apps/desktop/src/main/database/queries/tag-definitions.ts:82`,
  `crates/memry-core/src/domain/tag_admin.rs:442-447`).
- **`views`: `undefined` keeps the local value, `null` is an explicit clear**
  (`:355-356`). **A sender that holds no views omits the key** (desktop: a NULL
  column), and an explicit "no views" travels as `[]`
  (`apps/desktop/src/main/sync/item-handlers/tag-definition-handler.ts:205`,
  `apps/desktop/src/main/database/queries/tag-definitions.ts:229-234`); deleting
  a tag's last view writes `[]` (`apps/desktop/src/main/ipc/folder-view-handlers.ts:296`).
  Desktop builds before this rule send `views: null` for a tag without saved
  views, which clears a peer's; the receive rule is unchanged.
- **`schema`: absent keeps the local value, `null` carries no information, and
  an object is joined by chapter 06 §6.11 on every apply path rather than by the
  document gate** (§13.7.7.1).

- **A tag name has one identity, the tag fold**
  (`packages/shared/src/tag-fold.ts:25-36`,
  `crates/memry-core/src/domain/tags.rs:60-87`). **Normative**: each Unicode
  scalar folds on its own, with no locale and no context. `İ` (U+0130) folds to
  `i`; `ς` (U+03C2) folds to `σ`; a U+0307 directly after a scalar that folded
  to `i` is dropped; every other scalar takes its Unicode lowercase mapping. So
  `Ünal`, `ünal` and `ÜNAL` are one tag, `İş`, `iş`, `IŞ` and `i̇ş` (U+0307)
  are one tag, `ΟΔΟΣ`, `οδος` and `οδοσ` are one tag, and `ı` stays apart from
  `i` and `ß` from `ss`. For every string `fold(fold(s))` and
  `fold(lowercase(s))` equal `fold(s)`, so a key an older build stored as the
  full lowercase still folds to the same tag. Spellings that fold equal are one
  tag on an item, in a definition's `name`, and in the names in `schema`
  (§13.7.7.2); a definition's key is the trimmed name, folded
  (`packages/shared/src/tag-fold.ts:42-44`,
  `crates/memry-core/src/domain/tags.rs:78-82`). The vectors are
  `packages/contracts/test-vectors/tag-fold.json`
  (`packages/contracts/scripts/vectors/tag-fold.ts`), verified by
  `packages/contracts/src/__tests__/tag-fold.test.ts` and
  `crates/memry-core/tests/tag_fold_vectors.rs`.
- SQLite `COLLATE NOCASE` on the tag columns folds `A`-`Z` only, so a client
  MUST NOT decide tag identity with it; both clients register a `tag_fold`
  SQL function and compare through it
  (`apps/desktop/src/main/database/sqlite-functions.ts:31-33`,
  `apps/desktop/src/main/database/queries/tag-match.ts:13-41`,
  `crates/memry-core/src/storage/connection.rs:140-150`).
- A fold can change a name's length, so a client MUST NOT cut a carrier's
  spelling at the length of a folded name; a rename keeps a child's suffix by
  `/` segment (`packages/shared/src/tag-fold.ts:51-54`).
- A definition's sync id stays the name its row was first stored under, which
  may keep the typed spelling (`Ünal`). A new definition is stored under the
  trimmed spelling (`apps/desktop/src/main/database/queries/tag-definitions.ts:81-82`);
  the core writes it over a deleted definition of the same tag when one exists,
  because its projection keys names without ASCII case: the projection's deleted
  row first, else a deleted `tag_definition` item, which is all a device holds
  of a peer's delete of a tag it never had live
  (`crates/memry-core/src/domain/tag_admin.rs:163-186`,
  `crates/memry-core/src/domain/tag_admin.rs:422-425`). A peer's delete of one
  spelling's item marks the projection row of another spelling's live item
  deleted too; the core then edits that live item, which projects it live again
  (`crates/memry-core/src/domain/tag_admin.rs:426-433`). Builds before this rule could hold two
  live definitions that now fold equal. A client MUST read one of them, the
  survivor: the higher `schema.t` (none below 0), then the older `createdAt`,
  then the smaller id by UTF-16 code unit
  (`apps/desktop/src/main/tags/converge-identity.ts:43-50`,
  `crates/memry-core/src/domain/tag_admin.rs:82-128`). Desktop deletes the
  others on vault open, after copying into the survivor any icon, category,
  views or authored colour it lacks, and pushes the deletes
  (`apps/desktop/src/main/tags/converge-identity.ts:70-106`,
  `apps/desktop/src/main/vault/index.ts:571`). Every device picks the same
  survivor from the same rows, so devices converge on one id. An older build
  that still compares ASCII-only can mint a plain definition under its own
  spelling again; the next open merges it back, and since the survivor keeps
  the higher schema and every authored field nothing is lost.

#### 13.7.7.1 `schema`

One versioned object holding the tag's fields, template, parent and preset
(`:359`), declared like `task.fields` (`:33-37`). **Normative**:

```json
"schema": {
  "t": 3,
  "fields": [
    { "name": "Company", "relation": { "target": "company", "many": false, "inverse": "People" } },
    { "name": "Role" },
    { "name": "Email" }
  ],
  "template": { "id": "tpl_8f2c", "autofill": true },
  "extends": null,
  "preset": "person"
}
```

- `t` is the value's own version (chapter 06 §6.11.2): an integer `>= 0`,
  missing or invalid reading as 0.
- `fields` is ordered. `name` is a vault property key, and **its type is owned
  by the vault-wide property definition** (§13.7.9): this payload carries no
  type, so no new `property_definition.type` value is introduced. `relation`
  present marks a relation field: `target` (a definition key, or `null` for
  any note), `many`, and `inverse` (the label of the list derived on the
  target, which is never stored on the target).
- `template` names a `template` item (§13.7.6) and whether to apply it to a note
  that gets the tag while its body is empty, or is `null`. `extends` is the
  lowercase name of one parent tag, or `null`. `preset` is the ready-made tag
  the definition came from, or `null`; an unknown string round-trips.
- Every object inside `schema` is open: a receiver MUST keep every key at every
  depth, and the join stores the winning object as it arrived
  (`packages/shared/src/versioned.ts:102-112`), so a schema a newer build wrote is
  stored and pushed verbatim.
- A sender that holds no schema MUST omit the key (desktop: a NULL column,
  `apps/desktop/src/main/sync/item-handlers/tag-definition-handler.ts:206`).
  Removing everything is a versioned empty value, never `null`.

The Rust core projects it as `Field::opt_null("schema", Kind::Any)` with no
column (`crates/memry-core/src/storage/repositories/projectors/taxonomy.rs:64`).
It runs §6.3.1's document gate on the rest of the definition, then joins
`schema` by chapter 06 §6.11 on every apply path, the skip included, and heals
(`crates/memry-core/src/sync/apply.rs:444-446`, `:492-503`,
`crates/memry-core/src/sync/versioned_apply.rs:46`, `:74`). A schema edit
stamps `t` one past the stored value's
(`crates/memry-core/src/domain/tag_schema/edit.rs:97`,
`crates/memry-core/src/sync/versioned.rs:177`). Builds before #4002 stored the
schema verbatim and took the remote payload on a concurrent definition; they
never edited it, and a desktop heals for them.

#### 13.7.7.2 Reference rewrite

A rename or merge of tag `from` into `to` MUST rewrite every other live
definition whose `schema` names `from`
(`packages/contracts/src/tag-schema.ts:155-181`,
`crates/memry-core/src/domain/tag_schema_refs.rs:25-66`). **Normative**:

- Names compare by definition key (trimmed, then the tag fold, §13.7.7).
  `extends` equal to `from` becomes `to`'s key; each `fields` entry that is an object whose
  `relation` is an object whose `target` equals `from` gets `target` set the
  same way. Every other key at every depth, and every other entry, is kept.
- `to` equal to `from` after folding, or nothing naming `from`, is no rewrite:
  the stored schema is left as it is.
- Otherwise the new `t` is the old `t` (an integer `>= 0`, else 0) plus 1, so
  the rewrite wins the §6.11 join against the value it replaces. The rewritten
  definition is written and pushed like any other definition edit
  (`crates/memry-core/src/domain/tag_rename.rs:100`,
  `crates/memry-core/src/domain/tag_admin.rs:392`).
- A rename renames each `/` child of `from` too, so it applies the rule once
  per renamed tag: `from` to `to`, and each `from/rest` any item or
  definition holds to `to/rest`, children first
  (`apps/desktop/src/main/tags/rename-tag.ts:33-63`, `:151`,
  `crates/memry-core/src/domain/tag_rename.rs:26-56`, `:100`). A merge
  applies it to `from` alone.
- The rule accepts `to = null` (the reference becomes `null`), but **a tag
  delete does not invoke it**: references to a deleted tag stay, and resolve
  again if the tag returns. A reader MUST tolerate an `extends` or `target`
  naming a tag with no live definition.

The shared vectors are `packages/contracts/test-vectors/tag-schema-refs.json`
(`packages/contracts/scripts/vectors/tag-schema-refs.ts`), verified by
`packages/contracts/src/__tests__/tag-schema-refs.test.ts` and
`crates/memry-core/tests/tag_schema_refs_vectors.rs`.

### 13.7.8 `tag_category` — `:332-339`

`name` and `sortOrder` **required**; `clock`, `createdAt`, `updatedAt`,
`deletedAt`.

### 13.7.9 `property_definition` — `:322-330`

`name` and `type` **required**; `options`, `defaultValue`, `color`, `clock`,
`createdAt`.

**`options` is opaque JSON _text_, deliberately not re-declared** (`:317-320`),
so a newer client's per-option field is not parsed away on a round trip. This is
§13.2 applied inside one field.

**`type` is an open string on the wire, and a port MUST NOT close it.** The
payload schema declares it `z.string()`, not an enum, and that is deliberate for
the same reason `options` is opaque: a definition whose type a newer desktop
introduced must survive a round trip through this core rather than be refused.

The values desktop writes today are the ten in `PropertyTypes`:

| value         | note                                                                                                            |
| ------------- | --------------------------------------------------------------------------------------------------------------- |
| `text`        |                                                                                                                 |
| `number`      |                                                                                                                 |
| `checkbox`    |                                                                                                                 |
| `date`        |                                                                                                                 |
| `url`         |                                                                                                                 |
| `status`      | carries `categories`, keyed `todo`, `in_progress`, `done`                                                       |
| `select`      | carries `options`                                                                                               |
| `multiselect` | carries `options`                                                                                               |
| `relation`    | **never written to a definition store** — typed from its value every time, because its URIs are self-describing |
| `project`     | reserved for the `project` frontmatter key, whose type is always `project` whatever inference would say         |

That list is **informative, not normative**: it tells a port what it will see,
and an eleventh value is a valid payload that this core stores verbatim and
projects unchanged.

**A port MUST NOT map a type name to a JSON type in order to validate a
property _value_.** No such mapping exists in this specification, nothing on the
wire carries one, and the enumeration above is the desktop's local vocabulary
rather than a wire contract. A core that invented one would refuse a legitimate
edit on real data the first time the two disagreed. Where a client needs to know
that an edit does not retype a property — FR-048 — it compares the new value
against the value **already stored on that note**, which is the only typing
claim the payload actually makes. An explicit `null` is §13.4's clear and claims
no type; a property with no value yet claims none either.

### 13.7.10 `folder_config` — `:341-346`

**`icon` is `z.string().nullable()`** (`:342`). Plus `clock`, `createdAt`,
`modifiedAt`.

`icon` is nullable rather than optional: the key is always present and its value
may be `null`. That is a narrower claim than an earlier draft's "the only
non-optional field on any subscribed type", which contradicted §13.7.7 to
§13.7.9 — those sections mark `name`, `color`, `sortOrder` and `type` required
on their own types, and they are correct. **Where a per-type section marks a
field required, that section wins**; there is no cross-type uniqueness claim
about `icon` and none should be read into it.

#### 13.7.10.1 A folder id is a path, and what that obliges

`folder_config` is keyed by the folder's **path**, so a rename or a move changes
the id rather than a field. Nothing above stated what that does to the subtree,
and FR-051 requires the resulting hierarchy to match desktop's, so it is written
down here.

On desktop a folder **is a directory on disk**. `renameFolder` is a single
`fs.rename` of that directory (`apps/desktop/src/main/vault/notes-crud.ts:885`)
and `deleteFolder` is `rm -rf`
(`apps/desktop/src/main/vault/notes-crud.ts:900`). Everything inside therefore
follows implicitly, because a note's `folderPath` is where its file sits rather
than an independent field.

A core with no filesystem has to reproduce that explicitly:

- **A rename or move is a re-key of the whole subtree.** Create at the new id
  from the old row's **stored bytes**, so unknown keys ride along (§13.2);
  tombstone the old id; rewrite every descendant `folder_config` id and every
  `note.folderPath` under the prefix. All of it in one transaction, each row with
  its own outbox row. Not rewriting the subtree orphans it and forks the folder
  in two.
- **A delete cascades on desktop and takes the notes with it.** `rm -rf` does not
  ask.

**Known divergence, recorded rather than hidden.** `memry-core` currently
**refuses** to delete a folder that still holds a live note, where desktop would
delete both. The asymmetry is deliberate: the prefix rewrite is reversible and a
recursive delete is not, and the only caller today is a headless CLI operating
on a real account. A port MUST NOT read this paragraph as permission to
cascade silently, and MUST NOT read it as settled — it is an open product
question for the shell that first exposes folder deletion in a UI, and the two
behaviours are distinguishable by any user who tries it.

### 13.7.11 `custom_icon` — `:355-363`

`name`, `ext`, **`data` (base64 image bytes carried inline)**, `clock`,
`createdAt`, `updatedAt`.

**Normative: `custom_icon` is a reader-only type with no projection table.**
data-model §A.4 lists none and the baseline migrations create none, and that is
deliberate rather than an omission. The payload is a single inline blob with no
field a query would filter or sort on, and §13.7.11's self-healing rule already
says a consumer reads it from the row on demand. A conforming client stores the
item in `sync_items` like any other, projects nothing, and resolves an icon by
reading the stored payload. Adding a projection table for it is allowed but buys
nothing, and it must never be the _source_ — the row remains the record.

The bytes ride in the record payload rather than the attachment pipeline because
a normalised icon is a few KB, and this keeps every device's icon directory
self-healing from the row (`:348-354`).

### 13.7.12 `reminder` — `:170-186`

`targetType`, `targetId`, `remindAt`, `anchorId`, `highlightText`,
`highlightStart`, `highlightEnd`, `title`, `note`, `status`, `dismissedAt`,
`snoozedUntil`, `clock`, `createdAt`, `modifiedAt`.

**`triggeredAt` is deliberately absent from the payload** (`:165-169`): each
device shows its own notification, so a synced value would suppress it on a
device that never displayed it. **Dismiss and snooze state does sync.**

### 13.7.13 `settings`

`{ settings, fieldClocks }` where `fieldClocks` is keyed by **dotted path**
(`packages/contracts/src/settings-sync.ts:113-116`; chapter 06 §6.9).

**The `calendar` group** (spec 007 D3a) carries `weekStartDay`,
`showNotesOnCalendar`, `defaultWriteTarget` (`{ provider, remoteCalendarId }`, or
`null` for none), `google.{defaultTargetCalendarId, onboardingCompleted,
promoteConfirmDismissed, pushEventsToGoogle, agentReadEventsConsent}` and
`<provider>.{agentReadEventsConsent, pushEventsToProvider}` for other providers,
one field clock per leaf (`calendar.google.pushEventsToGoogle`). Every key is
optional, and the group accepts provider keys it does not name. Device-local
and never here: the desktop day-panel click settings, the `apple-eventkit`
group, provider credentials and cursors.

**The `features` group** carries the per-vault module toggles `home`, `inbox`,
`journal`, `tasks`, `calendar`, `graph` and `spatialCanvas`, each a boolean with
its own field clock (`features.journal`)
(`packages/contracts/src/settings-sync.ts:169-184`;
`packages/contracts/src/settings-schemas.ts:577-588`). Every key is optional, and
the group accepts a key it does not name. Desktop pushes a flag only when the
user sets it (`apps/desktop/src/main/ipc/settings-handlers.ts`, the
`SET_FEATURES_SETTINGS` handler), and applies a merged group to its local
`features` row without pushing it back
(`apps/desktop/src/main/sync/item-handlers/settings-handler.ts`,
`propagateMergedSettings`).

**The `readwise` group** (#1408 D8, D18) is the synced half of the Readwise
import: `syncDeviceId` and `syncDeviceName` name the one desktop that pulls,
`rootFolder`, `folderLayout`, `cadence`, `categories.*`, `readerDocuments`,
`readerFullText` and `journalHighlights` are the user's choices, and
`status.{lastChangeAt, error}` is the run status, one field clock per leaf
(`readwise.status.error`) (`packages/contracts/src/settings-sync.ts:185-231`).
Every key is optional, and the group and its `categories` and `status` objects
accept a key they do not name (`packages/contracts/src/settings-sync.ts:196-230`).
The token and the run state (cursor, retry list) are device-local and never here.

**Normative, `readwise.status`.** `lastChangeAt` is an ISO 8601 string and
`error` is an error code (`invalid-token`, `subscription-expired`) or `null`
(`packages/contracts/src/settings-sync.ts:219-227`). **Only the pulling device
writes them, and only when a run changed something or the error state changed:
a run that changed nothing sends no field**
(`apps/desktop/src/main/readwise/status-publish.ts:14-41`). A cleared error is an
explicit `null`, never a removed key (§13.4). **Every other device treats the
group as read-only.** The iOS app shows `syncDeviceName`, `rootFolder`,
`status.lastChangeAt` and `status.error` and writes none of them (D13). It reads
a `syncDeviceId` that is absent, `null` or empty as "not connected", and an
unknown `error` code as a generic "needs attention".

**Normative, `readwise` (compat).** A build that predates the group, or the
`status` object inside it, strips what it does not know on parse and echoes the
field clocks it received, so the merge keeps the pulling device's values
(§6.9.0, `packages/sync-client/src/settings-merge.ts:22-26`). A client that does
not model `readwise` keeps it byte for byte through §13.2
(`apps/desktop/src/main/sync/item-handlers/settings-handler.ts:158-166`).

**Normative, compat (D7).** An older build whose schema lacks a key strips its
value on parse but keeps its field clock, so it re-uploads the clock with no
value. **An absent value under a field clock equal to the local one is not a
removal** (a removal ticks the clock): the receiver keeps its value. A device
seeds a key from its own device-local value only while no device has clocked
that path.

**Normative, `features` (compat).** A build that predates the group strips its
values on parse and echoes the clocks it received, so the merge keeps the
newer device's values (§6.9.0,
`packages/sync-client/src/settings-merge.ts:22-26`). A device that has stored
`features` flags locally seeds a flag that differs from its default only while
no device has clocked that path and no value is present
(`apps/desktop/src/main/settings/features-settings-sync.ts`,
`seedFeaturesSyncedSettings`). A stored default records no decision, because the
desktop write path stores the whole group
(`apps/desktop/src/main/ipc/settings-handlers.ts`, `writeGroupSettings`), so it
is never seeded and cannot overwrite another device's choice.

### 13.7.14 `filter` — `:86-98`

`name`, `config`, `expression`, `position`, `clock`, `createdAt`. No `modifiedAt` and no
`fieldClocks`: `filter` takes the document-level resolver (§13.9). Desktop's
push is its whole `saved_filters` row serialised
(`packages/sync-client/src/item-handlers/filter-handler.ts:94-103`), so `id` and
`syncedAt` also arrive as unmodelled keys and are preserved like any other.

`config` is `z.unknown()` on the wire. Desktop writes
`{ filters, sort?, starred? }` (`packages/contracts/src/saved-filters-api.ts:76-80`);
**a client treats it as opaque JSON and keeps keys it does not model**, so an
edit merges into the stored `config` rather than replacing it (§13.2 rule 3).
Starring writes `config.starred` as a boolean, `false` included.

**`expression`** holds a saved filter's advanced rules, ANDed with
`config.filters`. It sits beside `config`, not inside it, because desktop builds
before it rebuild `config` from the keys they model when they star a filter,
while §13.2.1 carries an unknown top-level key through their push. Desktop
stores it in `saved_filters.expression`
(`apps/desktop/src/main/database/drizzle-data/0082_saved_filter_expression.sql`),
which adopts a value a build without the column captured into
`sync_unknown_fields`. On apply, an absent `expression` keeps the stored value
(a writer that predates the key) and `null` clears it
(`packages/sync-client/src/item-handlers/filter-handler.ts:45`). Desktop's IPC
update merges `config` and `config.filters` key by key into the stored config
and writes `starred` alone (`apps/desktop/src/main/ipc/saved-filters-handlers.ts:60-82`),
so this build keeps the keys a newer one wrote.

The value is a group, `{ match, rules }`, where `match` is `all`, `any` or
`none` and each element of `rules` is a group or a rule. A rule is
`{ field, op, ... }`; the shapes this build writes are
`TaskFilterGroupSchema` (`packages/contracts/src/saved-filters-api.ts:149-206`).
Each rule reuses the chip filter of its dimension, so a rule matches what the
chip with the same values matches (`packages/domain-tasks/src/filtering/expression.ts`):

| `field`                         | `op`                                      | value keys                                                                                  |
| ------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------- |
| `title`                         | `contains`, `notContains`                 | `values[0]`, case-folded with `toLowerCase`, title only                                     |
| `priority`, `status`, `project` | `any`, `none`                             | `values`                                                                                    |
| `tags`                          | `any`, `all`, `none`, `empty`, `notEmpty` | `values`, folded as the tag chip folds                                                      |
| `due`                           | `is`, `isNot`                             | `values`: due presets, any of; `custom` reads `dueStart`/`dueEnd` (`YYYY-MM-DD` local keys) |
| `location`                      | `any`, `none`                             | `folderPaths` (subfolders included), `noteIds`                                              |
| `repeat`                        | `is`                                      | `values[0]`: `repeating` or `one-time`                                                      |
| `hasTime`                       | `is`                                      | `values[0]`: `with-time` or `without-time`                                                  |

**A client skips what it cannot evaluate**
(`packages/domain-tasks/src/filtering/expression.ts:155-250`): a rule with an
unknown `field` or `op`, with no usable value (empty or non-string `values`, a
blank title, a `custom` range missing an end or not a date key), and a group
with an unknown `match` or with nothing left to evaluate. A skipped node drops
out of its group; it neither matches every task nor none. A fully skipped root
passes every task. The `expressions` section of `task-filtering.json` pins
this, task by task, with and without the note index.

### 13.7.15 `inbox` — `packages/contracts/src/sync-payloads.ts:67-91`

`title`, `content`, `type`, `metadata`, `filedAt`, `filedTo`, `filedAction`,
`snoozedUntil`, `snoozeReason`, `archivedAt`, `sourceUrl`, `sourceTitle`,
`captureSource`, `attachmentId`, `clock`, `createdAt`, `modifiedAt`. No
`fieldClocks`: `inbox` takes the document-level resolver (§13.9). Desktop's
push is its whole `inbox_items` row serialised
(`apps/desktop/src/main/sync/item-handlers/inbox-handler.ts:161-169`), so its
local columns (`viewedAt`, `processingStatus`, `transcription`,
`transcriptionStatus`, `attachmentPath`, `thumbnailPath`, `syncedAt`,
`localOnly`) arrive as unmodelled keys and are preserved like any other.

**`attachmentId` is the attachment id of the capture's file (#4157).** It is
the §14.7 id of the bytes at the capture's `attachmentPath`, and it is absent
until the capturing device has uploaded them
(`packages/contracts/src/sync-payloads.ts:81-87`). `attachmentPath` stays an
unmodelled key. §14.7.2 owns what the id means and where a receiver writes the
file.

**Normative apply rule** (desktop's `applyUpsert`, `:32-137`): after the
document gate, a remote payload is laid **key by key** over the local one. A
key the remote omits keeps the local value; a key it sends as `null` clears it
(unsnooze, unarchive and unfile push explicit `null`s); `title`, `type` and
`attachmentId` keep the local value on `null` too, so a remote never clears an
`attachmentId`: an older sender omits the key or sends `null` without knowing
it, and a capture's file never changes once uploaded
(`crates/memry-core/src/domain/inbox/merge.rs:35`, `:84-86`; desktop's
`apps/desktop/src/main/sync/item-handlers/inbox-handler.ts:65` reads it as
`data.attachmentId ?? existing.attachmentId`). A string sets it, including over
a different known id. `metadata` is `z.unknown()` and replaced whole.

### 13.7.16 `calendar_source` — `:410-428`

`provider`, `kind` (`account` | `calendar`), `accountId`, `remoteId`, `title`,
`timezone`, `color`, `isPrimary`, `isSelected`, `isMemryManaged`, `syncCursor`,
`syncStatus` (`idle` | `ok` | `error` | `pending`), `lastSyncedAt`, `metadata`,
`archivedAt`, `clock`, `createdAt`, `modifiedAt`. Document-level resolver.
Desktop's push is its whole `calendar_sources` row
(`packages/sync-client/src/calendar-source-sync.ts:76`), so `lastError` (an ICS
feed's error code, localized by each reader) and `syncedAt` arrive as unmodelled
keys. **Selection travels here**: showing or hiding a calendar writes
`isSelected`. Rows of a device-local provider (`apple-eventkit`) never leave the
device (`calendar-api.ts` `DEVICE_LOCAL_CALENDAR_PROVIDERS`).

**Normative apply rule** (`calendar-source-handler.ts`): after the document
gate, every key is read as `data.x ?? existing.x`, so a `null` **keeps** the local
value. Insert defaults: `provider 'google'`, `kind 'calendar'`, `remoteId` = the
item id, `title 'Untitled calendar'`, `syncStatus 'idle'`, flags `false`.
`syncCursor` is the exception: it is the writing device's pull progress, so a
receiver never takes it. An update keeps the local cursor, `null` included, and
an insert stores `null` so the receiver pulls the calendar in full
(`calendar-source-handler.ts:19-26`, `:115`). Senders still include it.

### 13.7.17 `calendar_event` — `:371-408`

`title`, `description`, `location`, `startAt`, `endAt`, `timezone`, `isAllDay`,
`recurrenceRule`, `recurrenceExceptions`, `attendees`, `reminders`, `visibility`
(`default` | `public` | `private` | `confidential`), `colorId` (Google's event
colour id `"1"`..`"11"`), `conferenceData`, `parentEventId`, `originalStartTime`,
`targetCalendarId`, `archivedAt`, `clock`, `fieldClocks`, `createdAt`,
`modifiedAt`. **Field-level** over the fourteen
`CALENDAR_EVENT_SYNCABLE_FIELDS` (`title` … `conferenceData`,
`apps/desktop/src/main/calendar/field-merge-calendar.ts:4`); the routing and
recurrence-identity keys and `archivedAt` are not field-clocked.

**Normative apply rule** (`calendar-event-handler.ts`): on `concurrent`, a field
the remote omits is read as the local value before `mergeFields`; a side with no
`fieldClocks` seeds all fourteen from its document clock; `targetCalendarId`,
`parentEventId`, `originalStartTime` merge **by presence** (absent keeps,
`null` clears) and `archivedAt` by `??`. On `apply`, `title` …
`recurrenceExceptions` and `archivedAt` use `??`, the rich fields and routing keys
use presence, and the stored field clocks are the remote's or seeded from its
clock. A create ticks every field clock; an update ticks the changed fields only
(never `targetCalendarId`), and re-saving the same colour is not a change.

### 13.7.18 `calendar_external_event` — `:447-470`

`sourceId`, `remoteEventId`, `remoteEtag`, `remoteUpdatedAt`, `title`,
`description`, `location`, `startAt`, `endAt`, `timezone`, `isAllDay`, `status`
(`confirmed` | `tentative` | `cancelled`), `recurrenceRule`, `attendees`,
`reminders`, `visibility`, `colorId`, `conferenceData`, `rawPayload`,
`archivedAt`, `clock`, `createdAt`, `modifiedAt`. Document-level resolver.
Events of a device-local mirror (`ics`, `apple-eventkit`) never sync: each device
reads the feed itself.

**Normative apply rule** (`calendar-external-event-handler.ts`): `??` for every
key except `attendees`, `reminders`, `visibility`, `colorId`, `conferenceData`,
which merge by presence. An event whose `sourceId` has not landed is not shown
until it does (desktop parks and replays it; the phone stores it and its
projection joins the source). Promotion archives the mirror.

### 13.7.19 `calendar_binding` — `:431-445`

`sourceType` (`event` | `task` | `reminder` | `inbox_snooze`), `sourceId`,
`provider`, `remoteCalendarId`, `remoteEventId`, `ownershipMode`
(`memry_managed` | `provider_managed`), `writebackMode` (`schedule_only` |
`time_and_text` | `broad`), `remoteVersion`, `lastLocalSnapshot`, `archivedAt`,
`clock`, `createdAt`, `modifiedAt`. Document-level resolver, `??` for every key.
Insert defaults: `event`, `sourceId` = item id, `google`, `primary`,
`remoteEventId` = item id, `memry_managed`, `broad`. **The oldest live binding of
an item (by `createdAt`, then id) decides which provider writes it**
(`provider/write-routing.ts`); a promote writes one `provider_managed` /
`time_and_text` binding beside the new event.

### 13.7.20 `bookmark` — `:154-160`

`itemType`, `itemId`, `position`, `clock`, `createdAt`. No `modifiedAt` and
no `fieldClocks`: `bookmark` takes the document-level resolver (§13.9).
Desktop's push is its whole `bookmarks` row serialised
(`packages/sync-client/src/item-handlers/bookmark-handler.ts`), so `id` and
`syncedAt` also arrive as unmodelled keys and are preserved. The id is
`bmk_<itemType>_<itemId>` (`packages/contracts/src/bookmark-types.ts`).

`itemType` names what is bookmarked (`note`, `journal`, `task`, `folder`,
`tag`, and file types). A reader resolves `note`, `journal` and `task` by id
to a live row, `folder` by path and `tag` by name, and hides anything else,
as desktop's sidebar does (`resolveBookmarkItem`). This client reads
bookmarks and does not write them.

### 13.7.21 `canvas` — `:198-218`

`id`, `vaultId`, `title`, `scene`, `folder`, `icon`, `ownerNoteId`, `clock`,
`deletedAt`, every one optional on the wire. Desktop's push states all nine,
`ownerNoteId: null` included
(`apps/desktop/src/main/sync/item-handlers/canvas-handler.ts:404-442`),
and a client that writes a canvas MUST do the same: an absent key is read as
"not stated" by every receiver.

`scene` is Excalidraw JSON **text**, and its form is normative because desktop
compares scenes as text to decide a conflict. It is desktop's canonical form
(`apps/desktop/src/main/canvas/scene-file.ts:167-201`): `type`,
`version`, `source`, `elements`, `appState`, `files` first, in that order, each
defaulted when missing or `null` (`"excalidraw"`, `2`, `"memry"`, `[]`, `{}`,
`{}`); the file sidecar `memry` dropped; every other top-level key after them in
UTF-16 code-unit order; compact `JSON.stringify`, nested key order as given. An
empty board is
`{"type":"excalidraw","version":2,"source":"memry","elements":[],"appState":{},"files":{}}`.
A writer that emits any other text for the same drawing makes every concurrent
edit look like a divergence.

`vaultId` is the account vault's uuid, the value of `X-Memry-Vault-Id`
(chapter 05 §5.2). Desktop skips a create without it and lists canvases by it.
`ownerNoteId` names the note whose whiteboard block embeds the canvas.

**Normative**, the apply rule (`canvas-handler.ts:148-345`, `:479-571`). It is the
document-level resolver (§13.9) with five additions:

1. a payload with no string `scene` is skipped and changes nothing;
2. a create (no local row) with no `vaultId` is skipped;
3. on a **concurrent** clock, when the local row is live and its scene text
   differs from the remote's, the client first writes the local scene as a new
   canvas: a fresh nanoid, title `<local title, or "Canvas"> (conflict copy)`,
   the local `vaultId`, `folder` and `ownerNoteId`, `icon: null`, a clock of
   `{<this device>: 1}`, queued for push. The remote then applies under the
   merged clock. Identical scene text merges the clocks and creates nothing;
4. `title`, `folder`, `icon` and `ownerNoteId` absent from the remote keep the
   local value, and `null` clears it. `vaultId` keeps the local value;
5. the copy and the overwrite are one transaction.

A delete follows chapter 05 §5.8 unchanged: a canvas survives a tombstone only
when its local clock is strictly after the tombstone's (#2198,
`canvas-handler.ts:347-397`). The conflict
copy is the one push an apply writes, and it does not contradict §6.5.2 P3: it
is a new item, not a re-push of the merged one.

### 13.7.22 `vault_lock` — `:464-471`

`targetKind`, `target`, `locked`, `clock`, `createdAt`, `updatedAt`, every one
optional on the wire. `vault_lock` is desktop only: the iOS declaration leaves
it out (§13.1), and `payload-schemas.json` lists it under
`meta.desktopOnlyTypes`, not `meta.subscribedTypes`. `targetKind` is `note`
(`target` is the note id) or `folder` (`target` is the vault-relative path)
(`packages/contracts/src/vault-locks-api.ts:13`), and the id is
`<targetKind>:<target>` (`:21-23`), so two devices locking one target share one
record. Unlocking writes `locked: false` on the same record
(`packages/contracts/src/sync-payloads.ts:455-458`). `targetKind` is a
free-form string, so a kind a newer build adds still parses (`:460-462`).
Desktop's push states up to six keys; `clock` is absent when the row has none
(`apps/desktop/src/main/sync/item-handlers/vault-lock-handler.ts:127-134`).
Its seed of a lock made before sync pushes the whole `vault_locks` row
(`:143-157`), so `id` and `syncedAt` also arrive as unmodelled keys and are
preserved (§13.2).

**Normative**, the apply rule (`vault-lock-handler.ts:28-95`). It is the
document-level resolver (§13.9) with four additions:

1. a `targetKind` that is present and not a known kind is skipped, and a local
   record stays as it is (`:37-40`). An absent `targetKind` is not unknown;
2. a create (no live local record) that lacks a non-empty `targetKind`, a
   non-empty `target` or a boolean `locked` is skipped (`:72-76`);
3. a concurrent clock is last-writer-wins: the remote applies under the merged
   clock (`:48-55`);
4. over a local record, the local `targetKind`, `target` and `createdAt` stay,
   and an absent `locked` keeps the local value (`:56-63`). An absent
   `updatedAt` reads as the apply time (`:62`).

The Rust core follows the same rule
(`crates/memry-core/src/domain/vault_locks/merge.rs:39-74`).

A delete follows chapter 05 §5.8 unchanged and unlocks the target: the lock
survives a tombstone only when its local clock is strictly after the
tombstone's (`vault-lock-handler.ts:97-113`). The type is not in
`RECREATABLE_AFTER_PURGE_ITEM_TYPES` (`packages/contracts/src/sync-api.ts:217-228`).
A client that locks a target whose record it holds as a tombstone writes the
new record with a clock past the tombstone's
(`crates/memry-core/src/domain/vault_locks/mod.rs:176`).

### 13.7.23 `canvas_folder` — `:218-225`

`id`, `vaultId`, `path`, `icon`, `clock`, `deletedAt`, every one optional on the
wire. `canvas_folder` is desktop only: the iOS declaration leaves it out
(§13.1), and `payload-schemas.json` lists it under `meta.desktopOnlyTypes`. The
record carries only what a directory cannot: the icon, and the existence of an
empty folder. Which folder a canvas is in lives on the canvas (§13.7.21).

The id is derived from the path: `cvf_` and the path, NFC-normalised and
lowercased (`canvasFolderSyncId`,
`packages/contracts/src/canvas-folder-types.ts:24-26`;
`crates/memry-core/src/domain/canvas_folder/mod.rs:45-48`), so two devices
that create one folder offline make one record, and `Work` and `work` are one
folder on every platform. The type is in `RECREATABLE_AFTER_PURGE_ITEM_TYPES`
(`packages/contracts/src/sync-api.ts:222`): a folder deleted and made again
writes the same id, with a clock past the tombstone's
(`crates/memry-core/src/domain/canvas_folder/mod.rs:106`).

Desktop's push is built key by key and never carries `syncedAt`
(`apps/desktop/src/main/sync/item-handlers/canvas-folder-handler.ts:23-32`):
`icon` and `deletedAt` are stated as `null` when empty, and `clock` is absent
when the row has none. `deletedAt` is epoch milliseconds. Desktop
soft-deletes, so a deleted folder can arrive as a live record whose
`deletedAt` is a number; a reader treats it as deleted.

**Normative**, the apply rule (`canvas-folder-handler.ts:53-133`). It is the
document-level resolver (§13.9) with three additions:

1. a create (no local record, live or deleted) without a non-empty `vaultId`
   and a non-empty `path` is skipped (`:104-112`);
2. a concurrent clock is last-writer-wins: the remote applies under the merged
   clock (`:65-73`);
3. over a local record, deleted ones included, an absent `path` keeps the
   local path, an absent `icon` keeps the local icon and `null` clears it, and
   `vaultId` stays local. A `null` `path` fails the schema, so desktop skips
   the record (`apps/desktop/src/main/sync/apply-item.ts:166-176`) and the Rust
   core skips it too. `deletedAt` is the remote's: absent
   or `null` makes the folder live again (`:74-80`).

The Rust core follows the same rule
(`crates/memry-core/src/domain/canvas_folder/merge.rs:30-66`, over
`crates/memry-core/src/domain/desktop_records/mod.rs:58-92`).

A delete follows chapter 05 §5.8 unchanged: the folder survives a tombstone
only when its local clock is strictly after the tombstone's
(`canvas-folder-handler.ts:135-151`). A client that deletes a folder states
`deletedAt` in the payload too, as desktop's soft delete does
(`crates/memry-core/src/domain/canvas_folder/mod.rs:116-137`).

### 13.7.24 `home_page` — `:330-342`

`name`, `icon`, `position`, `widgets`, `cover`, `clock`, `createdAt`,
`updatedAt`, every one optional on the wire. `home_page` is desktop only: the
iOS declaration leaves it out (§13.1, §13.11), and `payload-schemas.json`
lists it under `meta.desktopOnlyTypes`. `widgets` is opaque JSON **text** that
holds an array, never parsed by the schema, so a widget a newer build adds
still round-trips (`packages/contracts/src/sync-payloads.ts:315-329`). `cover`
is `HomePageCoverSyncSchema` (`:305-311`), and a value that schema cannot read
is read as absent (`:335-338`). Desktop pushes its whole `home_pages` row
(`packages/sync-client/src/item-handlers/home-page-handler.ts:144-153`), so
`id` and `syncedAt` also arrive as unmodelled keys and are preserved (§13.2).
A client that writes a board states the eight schema keys
(`crates/memry-core/src/domain/home_page/mod.rs:71-106`), and writes a
`position` that is an integer as a JSON integer.

**Normative**, the apply rule (`home-page-handler.ts:33-110`). It is the
document-level resolver (§13.9) with four additions:

1. `widgets` that is present and is not text holding a JSON array is skipped
   **before the clock is compared**, so a later readable version of the board
   still wins (`:40-47`). A `widgets` that is not a string at all fails the
   schema; desktop skips it (`apps/desktop/src/main/sync/apply-item.ts:166-176`)
   and the Rust core skips it too
   (`crates/memry-core/src/domain/home_page/merge.rs:53-57`);
2. a create (no live local record) without a non-empty `name` is skipped
   (`:83-90`);
3. a concurrent clock is last-writer-wins: the remote applies under the merged
   clock (`:53-61`);
4. over a local board, an absent `name`, `position` or `widgets` keeps the
   local value, and a `null` one fails the schema, so desktop and the Rust core
   skip the record (`apply-item.ts:166-176`); an absent `icon` or `cover` keeps the local value and
   `null` clears it; an unreadable `cover` is absent and keeps the local one;
   `createdAt` stays local; an absent `updatedAt` reads as the apply time
   (`:63-75`).

The Rust core follows the same rule
(`crates/memry-core/src/domain/home_page/merge.rs:36-80`, over
`crates/memry-core/src/domain/desktop_records/mod.rs:58-92`).

The `home_pages.created_at` column of a board whose payload has no
`createdAt` keeps the time of its first apply: a later projection keeps the
stored value (`COALESCE`,
`crates/memry-core/src/storage/repositories/projectors/home_pages.rs:60`).
`rebuild_projections` into dropped tables has no stored value and writes the
rebuild time (`crates/memry-core/src/storage/repositories/sync_items.rs:358`,
`:385`). Electron writes the apply time once at create
(`packages/sync-client/src/item-handlers/home-page-handler.ts:102`) and has
no rebuild. The payload is unchanged either way; only the local column
differs.

A delete follows chapter 05 §5.8 unchanged: the board survives a tombstone
only when its local clock is strictly after the tombstone's
(`home-page-handler.ts:123-138`). Board ids are random, so the type is not in
`RECREATABLE_AFTER_PURGE_ITEM_TYPES` (`packages/contracts/src/sync-api.ts:217-228`).

### 13.7.25 `sticky_draft` — `:494-500`

`content`, `kind`, `clock`, `createdAt`, `modifiedAt`, every one optional on the
wire. `sticky_draft` is desktop only: the iOS declaration leaves it out
(§13.1, §13.13), and `payload-schemas.json` lists it under
`meta.desktopOnlyTypes`. Desktop pushes its whole `sticky_drafts` row
(`apps/desktop/src/main/sync/item-handlers/sticky-draft-handler.ts:104-113`),
so `id` and `syncedAt` also arrive as unmodelled keys and are preserved
(§13.2). A client that writes a draft states the five schema keys
(`crates/memry-core/src/domain/sticky_draft/mod.rs:70-115`).

**Normative**, the apply rule (`sticky-draft-handler.ts:23-78`). It is the
document-level resolver (§13.9) with three additions:

1. a create (no live local record) without a string `content` is skipped
   (`:54-60`);
2. a concurrent clock is last-writer-wins: the remote applies under the merged
   clock (`:35-39`);
3. over a local draft, an absent `content` or `kind` keeps the local value,
   and a `null` one fails the schema, so desktop and the Rust core skip the
   record (`apps/desktop/src/main/sync/apply-item.ts:166-176`); `createdAt`
   stays local, and an absent `modifiedAt` reads as the
   apply time (`:41-50`).

The Rust core follows the same rule
(`crates/memry-core/src/domain/sticky_draft/merge.rs:31-60`, over
`crates/memry-core/src/domain/desktop_records/mod.rs:58-92`).

A delete follows chapter 05 §5.8 unchanged: the draft survives a tombstone only
when its local clock is strictly after the tombstone's
(`sticky-draft-handler.ts:80-92`).

### 13.7.26 `agent_conversation` — `:699-711`

`vaultId`, `title`, `backend`, `backendModel` (nullable), `trustList`,
`pinned`, `clock` (optional), `fieldClocks`, `createdAt`, `updatedAt`,
`deletedAt` (nullable, optional). Unlike the other desktop-only types, the
schema requires every key except `clock` and `deletedAt`.
`agent_conversation` is desktop only: the iOS declaration leaves it out
(§13.1), and `payload-schemas.json` lists it under `meta.desktopOnlyTypes`.
`title` is plain text on the wire and sealed at rest (§13.2.3, chapter 04
§4.17).

**Normative**, the apply rule
(`apps/desktop/src/main/sync/item-handlers/agent-conversation-handler.ts:86-187`).
It is the field-level merge (§13.9) over `title`, `backend`, `backendModel`,
`trustList` and `pinned`
(`crates/memry-core/src/domain/agent_conversation/mod.rs:36-38`):

1. a remote the schema refuses (a value of the wrong type, or `null` in a key
   the schema does not mark `.nullable()`) is skipped before the clock is
   compared, and nothing is written
   (`crates/memry-core/src/domain/agent_conversation/merge.rs:63-66`,
   `crates/memry-core/src/domain/agent_conversation/mod.rs:40-53`);
2. no local record, or a remote clock that dominates the local one, stores the
   remote as sent (`:113-133`, `:178-186`); a local clock that dominates skips
   the remote (`:136-137`). An equal clock over the same payload skips; the
   Rust core compares the local payload with its title opened, the payload it
   would push (`crates/memry-core/src/domain/agent_conversation/merge.rs:67-71`);
3. concurrent clocks merge field by field under `fieldClocks` (chapter 06
   §6.3). A local record without `fieldClocks` seeds every field from its
   document clock (`:140-142`). `updatedAt` is the later of the two, and
   `deletedAt` is the remote's, else the local one (`:167-168`);
4. without a vault key Electron skips the record (`:92-101`), so the cursor
   moves past it and that device never has it. The Rust core stores it pending
   (§13.2.3) instead; on a concurrent merge a sealed local title that wins
   stays sealed, and a remote title that wins is stored pending. A local title
   that does not open under the installed key makes the remote corrupt
   (§13.2.3).

The Rust core follows the same rule
(`crates/memry-core/src/domain/agent_conversation/merge.rs:54-127`) with one
chosen difference: on a concurrent merge in which no field value changed,
Electron writes nothing (`:171`) and keeps its old clock, while the Rust core
stores the merged clock, as it does for `task` and `project`
(`crates/memry-core/src/domain/agent_conversation/merge.rs:113-123`). Nothing
is pushed either way.

A delete follows chapter 05 §5.8: the conversation survives a tombstone only
when its local clock is strictly after the tombstone's (`:190-210`).

### 13.7.27 `agent_message` — `:713-724`

`conversationId`, `role` (`user`, `assistant`, `tool_call`, `tool_result`,
`system`), `content` (`AgentMessageContentSchema`), `attachments` (an array of
`AgentMessageAttachmentSchema`), `toolCallId` (nullable), `status`
(`completed`, `cancelled`, `error`), `clock` (optional), `createdAt`,
`updatedAt`, `deletedAt` (nullable, optional). `agent_message` is desktop
only: the iOS declaration leaves it out (§13.1), and `payload-schemas.json`
lists it under `meta.desktopOnlyTypes`. `content` and `attachments` are plain
JSON on the wire and sealed at rest (§13.2.3, chapter 04 §4.17).

**Normative**, the apply rule
(`apps/desktop/src/main/sync/item-handlers/agent-message-handler.ts:132-185`).
A message is immutable (§13.9):

1. a message is written once. An id the device already holds keeps the
   local message whatever the remote says (`:179-183`), checked before
   anything else in the Rust core, so a remote with a non-terminal status
   does not mark a held message corrupt: Electron reports an identical
   remote as skipped and logs a different one as a conflict, and the Rust
   core reports both as `Skipped`; a row that has metadata and no payload
   takes the remote
   (`crates/memry-core/src/domain/agent_message/merge.rs:49-53`). A new id
   stores the remote as sent (`:155-176`);
2. a remote the schema refuses (a value of the wrong type, or `null` in a key
   the schema does not mark `.nullable()`) is skipped and nothing is written
   (`crates/memry-core/src/domain/agent_message/merge.rs:54-57`,
   `crates/memry-core/src/domain/agent_message/mod.rs:37-49`);
3. a `status` that is not terminal, absent included, refuses the record:
   Electron returns `parse_error` (`:138`), and the Rust core records it
   corrupt without storing its payload
   (`crates/memry-core/src/domain/agent_message/merge.rs:58-63`,
   `crates/memry-core/src/sync/apply.rs:565-582`). A writer sends only the
   terminal statuses
   (`crates/memry-core/src/domain/agent_message/mod.rs:34-35`, `:87`);
4. without a vault key Electron skips the record (`:140-149`). The Rust core
   stores it pending (§13.2.3) instead;
5. Electron defers a message whose conversation it does not hold to orphan
   repair (`:108-121`, `:156`). The Rust core has no parent check: it stores
   the message, which a read of its conversation returns once the
   conversation arrives
   (`crates/memry-core/src/domain/agent_message/mod.rs:118-127`).

A delete follows chapter 05 §5.8: the message survives a tombstone only when
its local clock is strictly after the tombstone's (`:187-210`).

## 13.8 `attachment` is not a record type

**Normative.** `attachment` is in `SYNC_ITEM_TYPES`
(`packages/contracts/src/sync-api.ts:12`) but **not** in
`RECORD_SYNC_ITEM_TYPES` and **not** in `ENCRYPTABLE_ITEM_TYPES` (chapter 00
§0.7). **Attachments do not travel as record envelopes at all**; see chapter 14.

## 13.9 Which merge algorithm each type uses

**Normative** (the enumeration is chapter 06 §6.8):

| Type                        | Algorithm                                                | Carries `fieldClocks`                              |
| --------------------------- | -------------------------------------------------------- | -------------------------------------------------- |
| `task`                      | field-level                                              | yes (`packages/contracts/src/sync-payloads.ts:61`) |
| `project`                   | field-level                                              | yes (`:247`)                                       |
| `calendar_event`            | field-level                                              | yes (`:405`)                                       |
| `settings`                  | dotted-path field clocks                                 | yes, its own key space                             |
| `canvas`                    | document-level resolver, plus a conflict copy (§13.7.21) | no                                                 |
| `vault_lock`                | document-level resolver, keeping local keys (§13.7.22)   | no                                                 |
| `canvas_folder`             | document-level resolver, keeping local keys (§13.7.23)   | no                                                 |
| `home_page`                 | document-level resolver, keeping local keys (§13.7.24)   | no                                                 |
| `sticky_draft`              | document-level resolver, keeping local keys (§13.7.25)   | no                                                 |
| `agent_conversation`        | field-level (§13.7.26)                                   | yes (`:707`)                                       |
| `agent_message`             | immutable: written once (§13.7.27)                       | no                                                 |
| every other subscribed type | document-level resolver                                  | no                                                 |

**`task.fields` and `tag_definition.schema` are versioned values** joined by
chapter 06 §6.11 on every apply path, in addition to the type's algorithm in the
table.

`settings` is also the one record type **exempt from the clock requirement**
(chapter 00 §0.7, `packages/contracts/src/sync-api.ts:68-95`).

## 13.10 The `settings` payload merges rather than replaces — Q13.1

**Normative.** A client MUST round-trip settings groups it does not model,
without stripping them.

`SyncedSettingsSchema` is a closed Zod object
(`packages/contracts/src/settings-sync.ts:113-116`), so **a parse strips an
unknown group** exactly as §13.2.1 describes for every other type. **The verbatim
copy is therefore §13.2's stored payload string, and nowhere else**: there is no
settings-specific preservation mechanism, and none is needed, because §13.2 is
type-agnostic.

**A client that implements §13.2 satisfies Q13.1 automatically. A client that
does not — desktop today, #2183 — violates FR-033 for settings as it does for
everything else.** Note that the individual key spaces inside settings _are_
tolerant by design: unconstrained string keys so one malformed or future key
cannot stall every other synced setting
(`packages/contracts/src/settings-sync.ts:83-86`, `:99-100`). That tolerance is
about keys **inside** a modelled group; §13.2 is what protects an **unmodelled
group**.

### 13.10.1 The twelve modelled groups

**Normative.** "Unmodelled group" is only meaningful against a list, so here it
is. The modelled groups are exactly:

`general`, `editor`, `tasks`, `calendar`, `keyboard`, `notes`, `sync`, `inbox`,
`journal`, `sidebar`, `features`, `readwise`
(`packages/contracts/src/settings-sync.ts:12-231`).

Every other group — `experimental` among them — is **unmodelled**: it is absent
from the parsed read view and present, byte for byte, in the stored payload.
That split is what `payload-schemas.json` pins, so the list is part of the
format and not an implementation's inventory. A client that models fewer groups
than this is still conforming, because §13.2 preserves whatever it does not
model; a client that models _more_ is not, because it would surface a group the
vectors expect to be stripped.

**Disposition of Q13.1: answered (the verbatim stored payload is the copy; there
is no settings-specific mechanism).**

## 13.11 `home_page` — Q13.3

`home_page` is in `RECORD_SYNC_ITEM_TYPES`
(`packages/contracts/src/sync-api.ts:63`). The iOS declaration does not
subscribe to it (§13.1); a desktop declaration that names it applies it by
§13.7.24. Its payload is `{ name, icon, position, widgets, cover, clock,
createdAt, updatedAt }` (`packages/contracts/src/sync-payloads.ts:330-342`),
where `widgets` is an opaque string and `cover` is the board's banner
(`packages/contracts/src/sync-payloads.ts:305-311`): the note cover's shape plus
an optional `attachmentId`. `cover` follows the `icon` rule: absent keeps the
receiver's value, `null` removes it, and an unreadable value is read as absent
(`packages/sync-client/src/item-handlers/home-page-handler.ts:71`). Its bytes
are an attachment; see chapter 14 §14.7.1.

**Normative — not subscribing to it orphans nothing.** Nothing in any subscribed
payload references a `home_page` id: `note` carries `folderPath` and
`attachmentReferences` (§13.7.1), `project` carries `homeNoteId` — **a note id,
not a home page id** (`packages/contracts/src/sync-payloads.ts:226`) — and no
subscribed type has a `homePageId`. The type is a leaf in the reference graph.
A board's `cover.attachmentId` points from the board to an attachment, never
from anything to the board, so the board stays a leaf.

Because the server serves only the declared set (chapter 05 §5.3), a
non-subscribing client never receives one, never applies one, and never pushes
one, so no row is written that a subscribing desktop would then find dangling.

**Disposition of Q13.3: answered (out of scope, and orphans nothing).**

## 13.12 `task_activity` retention — Q13.4

**Normative.** Retention is **90 days**, as an **age rule, never a per-device row
count** (`TASK_ACTIVITY_RETENTION_DAYS = 90`,
`packages/db-schema/src/schema/task-activity.ts:36`;
`taskActivityRetentionCutoff` at
`packages/sync-client/src/task-activity-retention.ts:15-17`).

**Retention MUST be enforced on apply as well as on write**
(`packages/sync-client/src/task-activity-retention.ts:9-13`). This is the answer
to "does deleting local rows cause a re-pull loop": **it does not, provided the
rule is an age rule applied on both sides.** With a row-count rule, a device that
pruned row X would keep re-accepting it from a peer that had not yet pruned, and
X would resurrect on every pull. With the age rule every device computes the same
cutoff and refuses the same rows.

Comparison is **lexicographic over ISO-8601 UTC strings**, which is chronological
because `created_at` and the cutoff share a shape
(`packages/sync-client/src/task-activity-retention.ts:19-29`). A conforming
client MUST produce `created_at` in that same shape.

**A conforming client MUST apply `isBeyondTaskActivityRetention` before applying
an inbound `task_activity` item**, and MUST still advance its cursor past a
refused row — the row is not corrupt, it is expired.

**Disposition of Q13.4: answered (a 90-day age rule enforced on apply and on
write; no re-pull loop).**

## 13.13 `sticky_draft`

A `sticky_draft` is text typed into the desktop sticky and not sent yet
(`StickyDraftSyncPayloadSchema`, `packages/contracts/src/sync-payloads.ts:494-500`).
Its payload carries `content`, `kind`, `clock`, `createdAt` and `modifiedAt`,
all optional on the wire. One vector clock covers the whole record (chapter 06),
so concurrent edits on two devices keep the later one.

`kind` names where the text goes when sent: `note`, `task` or `journal`
(`STICKY_KINDS`, `packages/contracts/src/sticky-api.ts:13`). It is a free-form
string on the wire, so a kind a newer build adds still parses. **A reader MUST
treat a kind it does not know as `note`** (`parseStickyKind`,
`packages/contracts/src/sticky-api.ts:16-20`).

Sending a draft or discarding it deletes the record. Draft ids are random and
never come back after a delete, so the type is not in
`RECREATABLE_AFTER_PURGE_ITEM_TYPES`. No other payload references a draft id:
the type is a leaf in the reference graph, and a client that does not subscribe
to it orphans nothing.

The iOS declaration does not subscribe to `sticky_draft` (§13.1); a desktop
declaration that names it applies it by §13.7.25.
