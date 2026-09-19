# 13 — Payload schemas

**Status**: normative. Every normative sentence carries a `path:line` citation
(chapter 00 §0.1).

The payload is the plaintext inside the record envelope of chapter 04: UTF-8
JSON. This chapter specifies what it contains per type, and — more importantly —
how a client is required to store it.

## 13.1 The thirteen subscribed types

**Normative.** This feature's client declares exactly these thirteen in
`X-Memry-Sync-Types` (chapter 05 §5.3):

`note`, `journal`, `folder_config`, `custom_icon`, `tag_definition`,
`tag_category`, `property_definition`, `template`, `task`, `project`,
`task_activity`, `reminder`, `settings`.

Twelve more **record types** are served by the server and **not** subscribed to
here: `inbox`, `filter`, `calendar_event`, `calendar_source`, `calendar_binding`,
`calendar_external_event`, `agent_conversation`, `agent_message`, `canvas`,
`canvas_folder`, `bookmark`, `home_page`. **A conforming client omits them from
the header and never sees them** (chapter 05 §5.3.1).

Thirteen plus twelve is the **twenty-five record types**, which is the set
chapter 05 §5.3 calls recognised. `attachment` is the twenty-sixth member of
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
`packages/sync-client/src/pull/store.ts:5-9`, `:17`. The reference phone obeys
it: the raw string goes into `sync_items.payload`
(`apps/mobile/src/db/pull-store.ts:128-136`, `:163`), projections come from a
parsed copy (`:207`), and a push sends the whole stored object with only the
changed keys mutated (`apps/mobile/src/sync/outbox.ts:66-71`).

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
survives an older desktop's edit. **The stated ceiling is nesting** — an unknown
key inside a known object is still stripped by that object's schema, where a
verbatim implementation would keep it.

It still violates rule 5: an item whose payload fails `parse` is marked
`'skipped'` **with the cursor advanced and no retry**
(`apps/desktop/src/main/sync/apply-item.ts`, and the comment naming it a
mixed-version tripwire). Routing it to `'parse_error'` would refetch identical
bytes forever, so the fix is a real quarantine state, not a reclassification.

**#2183** closed the key-loss half. Rule 5 and nested keys remain open.

### 13.2.2 The wire envelope is a different matter

**Normative, and harmless.** `RecordPullItemResponseSchema`
(`packages/sync-client/src/pull/engine.ts:209`) and
`EncryptedItemPayloadSchema` (`packages/contracts/src/sync-api.ts:311-316`)
strip unknown **envelope** keys, not payload keys, and the signature covers only
the ten allowlisted keys (chapter 04 §4.7.3). A client MAY reject an unknown
envelope key; it MUST NOT reject an unknown payload key.

### 13.2.3 Core obligation

Store the payload verbatim as `TEXT` or `BLOB`. Project through an untyped JSON
value, or a struct carrying a flattened `extra` map. **A plain derived
deserialise-then-reserialise reproduces desktop's original bug exactly**, and
desktop's remainder table is a retrofit, not the shape to copy — it only reaches
the top level.

**Disposition of Q13.2: answered** (this section).

## 13.3 The forward-tolerance convention

**Normative.** Almost every field on almost every payload is optional **on
purpose**: a payload written by a newer client must still parse on an older one,
so a missing or renamed field degrades to a skip rather than a whole-page parse
failure that advances the cursor past good data.

A client MUST NOT add a required field to an existing payload type.

## 13.4 Absent versus null

**Normative, and load-bearing.** It is stated in three separate schema comments
(`packages/contracts/src/sync-payloads.ts:125-126`, `:293-295`, `:300-301`):

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
  (`packages/sync-client/src/settings-sync.ts:196`,
  `packages/sync-client/src/settings-sync-keys.ts:12`).

**The sync bookkeeping key MUST therefore be `(type, id)` and never `id`
alone.** An id-only key made a project and a tag both named `inbox` share one
entry and corrupt each other's state
(`apps/desktop/src/main/sync/engine/sync-context.ts:118-124`).

## 13.7 Per-type field lists

Every schema below is a **reader** (§13.2). `clock` is `VectorClockSchema`
optional on every type; `fieldClocks` appears only where §13.9 says so.

### 13.7.1 `note` — `packages/contracts/src/sync-payloads.ts:255-271`

| Field                                                            | Type                                          | Rule                                                                                                                                   |
| ---------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `title`                                                          | string?                                       |                                                                                                                                        |
| `content`                                                        | string, nullable?                             | **a CRDT update push carries `content: null`** (chapter 07); non-null only on `create` and `duplicate` (chapter 12 §12.2, carve-out A) |
| `tags`                                                           | string[]?                                     | see chapter 12 §12.5.2 for the unresolved two-writer case                                                                              |
| `pinnedTags`                                                     | string[]?                                     |                                                                                                                                        |
| `emoji`                                                          | string, nullable?                             |                                                                                                                                        |
| `properties`                                                     | record, nullable?                             | **free-form: values only, never definitions** (`property_definition` carries those)                                                    |
| `aliases`                                                        | string[], nullable?                           |                                                                                                                                        |
| `fileType`                                                       | `markdown \| pdf \| image \| audio \| video`? | **binary types have no CRDT body**                                                                                                     |
| `mimeType`, `attachmentId`, `attachmentReferences`, `folderPath` | nullable?                                     |                                                                                                                                        |
| `createdAt`, `modifiedAt`                                        | `SyncTimestampSchema`?                        | §13.5                                                                                                                                  |

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
not by the schema**. Deletes never reach any parser at all: the applier
short-circuits `operation === 'delete'` before decoding the body.

### 13.7.3 `task` — `:25-48`

15 syncable fields (chapter 06 §6.7) plus `tags`, `linkedNoteIds`,
`linkedCanvasIds`, `clock`, **`fieldClocks`**, `createdAt`, `modifiedAt`.

`repeatConfig` is `z.unknown().nullable().optional()` (`:36`) — **opaque**, and
the only object-valued field in any field-merged list (chapter 06 §6.4.1).

### 13.7.4 `project` — `:239-253`

`name`, `description`, `color`, `icon`, `position`, `isInbox`, `archivedAt`,
`homeNoteId`, `createdAt`, `modifiedAt`, `clock`, **`fieldClocks`**, plus two
nested arrays with their own schemas: `statuses` (`StatusSyncSchema`,
`:216-223`) and `links` (`ProjectLinkSyncSchema`).

### 13.7.5 `task_activity` — `:85-95`

`taskId`, `action`, `field`, `oldValue`, `newValue`, `actor`, `deviceId`,
`clock`, `createdAt`.

**Append-only and immutable**, hence **no `fieldClocks` and no `modifiedAt`**.
`oldValue` and `newValue` are JSON-encoded scalars and are always `null` for
`description`, because the body can be note-sized.

### 13.7.6 `template` — `:97-111`

`name`, `description`, `icon`, `tags`, `properties`, `content`, `clock`,
`createdAt`, `modifiedAt`.

**`properties` must stay an array** (`TemplatePropertySchema[]`, `:106`) or note
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

### 13.7.7 `tag_definition` — `:290-305`

`name` and `color` are **required**; `icon`, `categoryId`, `sortOrder`,
`colorAuthored`, `views`, `clock`, `createdAt`.

- **`colorAuthored` absent means "cannot tell" and the receiver honours the
  colour**; only a sender that knows the field can say `false` (`:293-295`).
- **`views`: `undefined` keeps the local value, `null` is an explicit clear**
  (`:300-301`).

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

### 13.7.12 `reminder` — `:154-170`

`targetType`, `targetId`, `remindAt`, `anchorId`, `highlightText`,
`highlightStart`, `highlightEnd`, `title`, `note`, `status`, `dismissedAt`,
`snoozedUntil`, `clock`, `createdAt`, `modifiedAt`.

**`triggeredAt` is deliberately absent from the payload** (`:149-153`): each
device shows its own notification, so a synced value would suppress it on a
device that never displayed it. **Dismiss and snooze state does sync.**

### 13.7.13 `settings`

`{ settings, fieldClocks }` where `fieldClocks` is keyed by **dotted path**
(`packages/contracts/src/settings-sync.ts:113-116`; chapter 06 §6.9).

## 13.8 `attachment` is not a record type

**Normative.** `attachment` is in `SYNC_ITEM_TYPES`
(`packages/contracts/src/sync-api.ts:12`) but **not** in
`RECORD_SYNC_ITEM_TYPES` and **not** in `ENCRYPTABLE_ITEM_TYPES` (chapter 00
§0.7). **Attachments do not travel as record envelopes at all**; see chapter 14.

## 13.9 Which merge algorithm each type uses

**Normative** (the enumeration is chapter 06 §6.8):

| Type                        | Algorithm                | Carries `fieldClocks`                              |
| --------------------------- | ------------------------ | -------------------------------------------------- |
| `task`                      | field-level              | yes (`packages/contracts/src/sync-payloads.ts:45`) |
| `project`                   | field-level              | yes (`:247`)                                       |
| `settings`                  | dotted-path field clocks | yes, its own key space                             |
| every other subscribed type | document-level resolver  | no                                                 |

`settings` is also the one record type **exempt from the clock requirement**
(chapter 00 §0.7, `packages/contracts/src/sync-api.ts:64-89`).

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

### 13.10.1 The ten modelled groups

**Normative.** "Unmodelled group" is only meaningful against a list, so here it
is. The modelled groups are exactly:

`general`, `editor`, `tasks`, `calendar`, `keyboard`, `notes`, `sync`, `inbox`,
`journal`, `sidebar`.

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
(`packages/contracts/src/sync-api.ts:61`) and this feature does not subscribe to
it (§13.1). Its payload is `{ name, icon, position, widgets, clock, createdAt,
updatedAt }` (`packages/contracts/src/sync-payloads.ts:128-136`), where
`widgets` is an opaque string.

**Normative — not subscribing to it orphans nothing.** Nothing in any subscribed
payload references a `home_page` id: `note` carries `folderPath` and
`attachmentReferences` (§13.7.1), `project` carries `homeNoteId` — **a note id,
not a home page id** (`packages/contracts/src/sync-payloads.ts:251`) — and no
subscribed type has a `homePageId`. The type is a leaf in the reference graph.

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
