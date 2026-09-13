# Checklist: protocol specification completeness (gate G1)

**Feature**: 002-native-foundation-ios | **Gate**: G1 | **Source**:
[../contracts/protocol-spec-outline.md](../contracts/protocol-spec-outline.md)

G1 is green when every row below is ticked and carries a disposition. There are
exactly two dispositions:

- **answered**: the chapter states the answer as a normative fact with a citation.
- **undefined**: the chapter states, in the chapter itself, "undefined, do not rely
  on this". Silently dropping a question is not a disposition.

Rows marked **must answer** cannot take the undefined disposition. They are the
questions a second implementation cannot start without, and they are listed in
[../plan.md](../plan.md)'s gate table.

Write the chapter section or the decision in the "where" slot so a reviewer can find
it without re-reading the chapter.

**Answers live in [../contracts/protocol-answers.md](../contracts/protocol-answers.md).**
A ticked row here means the answer is written and cited there, and that the chapter
author's job is transcription. It does **not** mean the chapter exists yet: a row is
only G1-green once its chapter under `docs/protocol/` states the fact normatively.

## 00-overview-and-versioning.md

- [ ] **Q00.1** `CryptoVersion` is `1 | 2` with no v2 anywhere: reserved or deleted. Disposition: ____ Where: ____
- [ ] **Q00.2** Two record route prefixes: which is canonical for a new client. Disposition: ____ Where: ____
- [ ] **Q00.3** No negotiated protocol version on the wire. Disposition: ____ Where: ____

## 01-identity-and-keys.md

- [ ] **Q01.1** `memry-signing-key-v1` and `memry-verify-key-v1` occupy subkey ids with no caller. Disposition: ____ Where: ____
- [x] **Q01.2** **must answer.** Recovery phrase entry is unnormalised; whitespace and case change the seed. Disposition: answered. Where: [../contracts/protocol-answers.md#q012--recovery-phrase-normalisation](../contracts/protocol-answers.md#q012--recovery-phrase-normalisation)
- [x] **Q01.3** **must answer.** Whether a phone stores the master key, the vault key, or both. Disposition: answered. Where: [../contracts/protocol-answers.md#q013--does-a-phone-store-the-master-key-or-the-vault-key](../contracts/protocol-answers.md#q013--does-a-phone-store-the-master-key-or-the-vault-key)
- [x] **Q01.4** **must answer.** Multi vault: one vault key per account, since no vault id is mixed into the derivation. Disposition: answered. Where: [../contracts/protocol-answers.md#q014--one-vault-key-per-account](../contracts/protocol-answers.md#q014--one-vault-key-per-account)

## 02-auth-and-sessions.md

- [ ] **Q02.1** `sessionNonce` optional on four schemas, enforced only when the token carries one. Disposition: ____ Where: ____
- [ ] **Q02.2** Device registration challenge signs `nonce:jti` with no domain separation. Disposition: ____ Where: ____
- [ ] **Q02.3** `GET /auth/recovery` dummy data makes a wrong email and a wrong phrase indistinguishable. Disposition: ____ Where: ____

## 03-device-linking.md

- [x] **Q03.1** **must answer.** `linkingSecret` format, length, and entropy. Disposition: answered. Where: [../contracts/protocol-answers.md#q031--linkingsecret-shape](../contracts/protocol-answers.md#q031--linkingsecret-shape)
- [x] **Q03.2** **must answer.** `LINKING_IP_MISMATCH`: which requests are IP-bound, and the Wi-Fi to cellular case. Disposition: answered (decision: relax the binding). Where: [../contracts/protocol-answers.md#q032--linking_ip_mismatch](../contracts/protocol-answers.md#q032--linking_ip_mismatch)
- [x] **Q03.3** **must answer.** The linking session TTL behind `expiresAt`. Disposition: answered. Where: [../contracts/protocol-answers.md#q033--linking-session-ttl](../contracts/protocol-answers.md#q033--linking-session-ttl)
- [x] **Q03.4** **must answer.** `encryptedProviderAuth` and `encryptedVaultTransfer` version literals. Disposition: answered. Where: [../contracts/protocol-answers.md#q034--the-two-optional-encrypted-blocks](../contracts/protocol-answers.md#q034--the-two-optional-encrypted-blocks)
- [x] **Q03.5** **must answer.** Scan channel HMAC-SHA-256 versus confirm channel HMAC-SHA512-256: intentional or not. Disposition: answered. Where: [../contracts/protocol-answers.md#q035--two-mac-algorithms-and-the-sas](../contracts/protocol-answers.md#q035--two-mac-algorithms-and-the-sas)

## 04-record-envelope.md

- [x] **Q04.1** Packed CRDT header is 160 and the signature sits at 96; the stale comment at `crdt-encrypt.ts:38` says 72. Disposition: answered. Where: [../contracts/protocol-answers.md#q041--the-packed-crdt-header](../contracts/protocol-answers.md#q041--the-packed-crdt-header)
- [ ] **Q04.2** `EncryptedCrdtItem` declares fields with no producer: dead type or v2 shape. Disposition: ____ Where: ____
- [ ] **Q04.3** `metadata.fieldClocks` is allowed by the signature schema and never written. Disposition: ____ Where: ____
- [ ] **Q04.4** `EncryptedItem.signedAt` exists, is unsigned and unused. Disposition: ____ Where: ____
- [ ] **Q04.5** The server rewrites `cryptoVersion` to 1 when verifying. Disposition: ____ Where: ____
- [ ] **Q04.6** `CBOR_FIELD_ORDER.TOMBSTONE` has no producer. Disposition: ____ Where: ____
- [ ] **Q04.7** `SignaturePayloadV1Schema.deletedAt` admits a fractional number. Disposition: ____ Where: ____
- [x] **Q04.8** The in-code comments claiming CBOR keeps a nested object's key order are wrong. Disposition: answered. Where: [../contracts/protocol-answers.md#q041--the-packed-crdt-header](../contracts/protocol-answers.md#q041--the-packed-crdt-header)

## 05-record-sync.md

- [ ] **Q05.1** The shipped client always declares all 25 types, so the subset path is untested. Disposition: ____ Where: ____
- [ ] **Q05.2** The `deleted` array is untyped strings, so a subset subscriber cannot tell what a tombstone is for. Disposition: ____ Where: ____
- [x] **Q05.3** **must answer.** The same four blob fields are canonicalised twice, differently: JSON key sort and CBOR key sort. Disposition: answered. Where: [../contracts/protocol-answers.md#q053--the-same-four-fields-canonicalised-twice](../contracts/protocol-answers.md#q053--the-same-four-fields-canonicalised-twice)
- [ ] **Q05.4** `limit` above `MAX_CHANGES_LIMIT`: clamp or reject. Disposition: ____ Where: ____
- [ ] **Q05.5** `ConflictResponseSchema` and `SYNC_VERSION_CONFLICT` have no reader. Disposition: ____ Where: ____
- [ ] **Q05.6** `PULL_PAGE_LIMIT` is 500 in one engine and 100 in the other. Disposition: ____ Where: ____

## 06-vector-clocks-and-field-merge.md

- [x] **Q06.1** **must answer.** The asymmetric `_offline` tie-break makes the outcome depend on which side is called local. Disposition: answered (converges via P1+P2+P3, not the merge rule). Where: [../contracts/protocol-answers.md#q061-and-q062--the-complete-winner-selection-rule](../contracts/protocol-answers.md#q061-and-q062--the-complete-winner-selection-rule)
- [x] **Q06.2** `clockTotal` sums across devices and ignores causality. Disposition: answered (tick-sum frozen as an edit-count proxy). Where: [../contracts/protocol-answers.md#q061-and-q062--the-complete-winner-selection-rule](../contracts/protocol-answers.md#q061-and-q062--the-complete-winner-selection-rule)
- [x] **Q06.3** **must answer.** The canonical form a Rust implementation must produce for `JSON.stringify` equality. Disposition: answered (decision: mandate a canonical comparison). Where: [../contracts/protocol-answers.md#q063--value-equality](../contracts/protocol-answers.md#q063--value-equality)
- [x] **Q06.4** **must answer.** A concurrent pair with unequal totals resolves silently, so an edit is lost with no conflict surfaced. Disposition: answered (decision: freeze). Where: [../contracts/protocol-answers.md#q064--a-concurrent-pair-with-unequal-totals](../contracts/protocol-answers.md#q064--a-concurrent-pair-with-unequal-totals)
- [ ] **Q06.5** Which types field-merge and which document-merge. Disposition: ____ Where: ____
- [ ] **Q06.6** Nothing prunes a vector clock. Disposition: ____ Where: ____

## 07-crdt-updates.md

- [x] **Q07.1** **must answer.** The journal question FR-003 names: journal body as CRDT document or as record. Disposition: answered (decision: correct the constants). Where: [../contracts/protocol-answers.md#q071--the-journal-question](../contracts/protocol-answers.md#q071--the-journal-question)
- [x] **Q07.2** **must answer.** Whether a phone may push a CRDT snapshot, and on what trigger. Disposition: answered (gate is MUST, cadence is SHOULD, no MUST-snapshot). Where: [../contracts/protocol-answers.md#q072--the-client-snapshot-obligation](../contracts/protocol-answers.md#q072--the-client-snapshot-obligation)
- [ ] **Q07.3** No server-side signature verification on CRDT updates. Disposition: ____ Where: ____
- [ ] **Q07.4** What happens to `crdt_updates` and `crdt_snapshots` when a note is deleted. Disposition: ____ Where: ____
- [ ] **Q07.5** Update fetch caps at 500 one way and 100 the other. Disposition: ____ Where: ____
- [ ] **Q07.6** `snapshotMeta.signerDeviceId` is advertised and ignored. Disposition: ____ Where: ____

## 08-pack-container.md

- [ ] **Q08.1** `crdt_update = 2` is defined but reserved. Disposition: ____ Where: ____
- [ ] **Q08.2** Is a client ever a pack writer. Disposition: ____ Where: ____
- [ ] **Q08.3** `flags` is a uint16 fixed at 0: reject non-zero or ignore. Disposition: ____ Where: ____
- [ ] **Q08.4** Packs are optional, so a client that never fetches one is still correct. Disposition: ____ Where: ____

## 09-realtime.md

- [ ] **Q09.1** Whether a conforming phone client opens the socket at all. Disposition: ____ Where: ____
- [ ] **Q09.2** `heartbeat` has no payload schema and no handler. Disposition: ____ Where: ____
- [ ] **Q09.3** `calendar_changes_available`, `linking_request` and `linking_approved` have no payload schema. Disposition: ____ Where: ____
- [ ] **Q09.4** Reconnect policy, backoff, and behaviour between a 4003 and a successful refresh. Disposition: ____ Where: ____

## 10-bootstrap-session.md

- [x] **Q10.1** **must answer.** Is a bootstrap session required for FR-028 and SC-007, or an optimisation. Disposition: answered (optimisation, not required). Where: [../contracts/protocol-answers.md#q101--is-a-bootstrap-session-required](../contracts/protocol-answers.md#q101--is-a-bootstrap-session-required)
- [ ] **Q10.2** A first sync exceeding the 6 hour absolute lifetime falls back mid-run. Disposition: ____ Where: ____
- [ ] **Q10.3** `BOOTSTRAP_SESSION_HMAC_KEY` is optional per deployment; staging must have it (G4 precondition). Disposition: ____ Where: ____

## 11-client-policy.md

- [ ] **Q11.1** Two version gates coexist, one on HTTP writes and one on the socket. Disposition: ____ Where: ____
- [ ] **Q11.2** The poll interval a conforming client should use for `clientPolicy`. Disposition: ____ Where: ____
- [ ] **Q11.3** Attribution keeps only the latest writer, so a rollback window is bounded by rewrites. Disposition: ____ Where: ____

## 12-note-body-format.md

- [x] **Q12.1** **must answer.** Frontmatter key ordering on the edited path. Disposition: answered (decision: option B, verbatim path only). Where: [../contracts/protocol-answers.md#q121--frontmatter-key-ordering](../contracts/protocol-answers.md#q121--frontmatter-key-ordering)
- [x] **Q12.2** **must answer.** Markdown to Y.Doc conversion: who owns it. Disposition: answered. Where: [../contracts/protocol-answers.md#q122--who-converts-markdown](../contracts/protocol-answers.md#q122--who-converts-markdown) — supersedes the outline, which names a non-existent `seed-from-markdown` message
- [x] **Q12.3** The three-way merge resolves a genuine conflict in favour of the house style. Disposition: answered (desktop write-back behaviour; the core never merges). Where: [../contracts/protocol-answers.md#q122--who-converts-markdown](../contracts/protocol-answers.md#q122--who-converts-markdown)
- [x] **Q12.4** `MAX_EDIT_DISTANCE = 2000` silently changes behaviour by size. Disposition: answered (an implementation budget of one writer, not a protocol constant). Where: [../contracts/protocol-answers.md#q122--who-converts-markdown](../contracts/protocol-answers.md#q122--who-converts-markdown)
- [x] **Q12.5** **must answer.** Which of the seven Y.Doc roots a conforming client must preserve. Disposition: answered (seven roots, not eight; every root MUST survive). Where: [../contracts/protocol-answers.md#q125--the-ydoc-roots](../contracts/protocol-answers.md#q125--the-ydoc-roots)
- [ ] **Q12.6** The encoding of `inlineImage` and `inlineCheckbox` outside a table. Disposition: ____ Where: ____

## 13-payload-schemas.md

- [ ] **Q13.1** The `settings` payload merges rather than replaces. Disposition: ____ Where: ____
- [x] **Q13.2** **must answer.** Verbatim payload preservation against Zod's unknown-key stripping. Disposition: answered. Where: [../contracts/protocol-answers.md#q132--verbatim-payload-preservation](../contracts/protocol-answers.md#q132--verbatim-payload-preservation)
- [ ] **Q13.3** Whether `home_page` is really out of scope. Disposition: ____ Where: ____
- [ ] **Q13.4** `task_activity` retention on a phone, and whether local deletion causes a re-pull loop. Disposition: ____ Where: ____

## 14-attachments.md

- [ ] **Q14.1** Which routes a read-only, inline-image-only client needs. Disposition: ____ Where: ____
- [ ] **Q14.2** What connects `attachmentReferences` to a manifest. Disposition: ____ Where: ____
- [ ] **Q14.3** Whether never dereferencing chunks is safe. Disposition: ____ Where: ____
- [ ] **Q14.4** `CHUNK_SIZE` is a desktop constant, not a contract constant. Disposition: ____ Where: ____

---

**Count**: 69 questions, 19 of them must-answer. If the outline grows a question,
this file grows a row in the same change; a question that exists in one file and not
the other is a review failure.

**State on 2026-09-13**: 24 answered (all 19 must-answer, plus Q04.8, Q06.2, Q12.3,
Q12.4), 45 still to disposition. Nine issues were opened while answering — five code
defects and four decisions that need a change landed — all labelled `protocol-spec`:
#2179, #2180, #2181, #2182, #2183, #2184, #2185, #2186, #2187. They are tracked there,
not as checklist rows.
