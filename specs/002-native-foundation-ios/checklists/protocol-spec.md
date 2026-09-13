# Checklist: protocol specification completeness (gate G1)

**Feature**: 002-native-foundation-ios | **Gate**: G1 | **Source**:
[../contracts/protocol-spec-outline.md](../contracts/protocol-spec-outline.md) |
**Chapters**: [`docs/protocol/`](../../../docs/protocol/)

G1 is green when every row below is ticked and carries a disposition. There are
exactly two dispositions:

- **answered**: the chapter states the answer as a normative fact with a citation.
- **undefined**: the chapter states, in the chapter itself, "undefined, do not rely
  on this". Silently dropping a question is not a disposition.

Rows marked **must answer** cannot take the undefined disposition. They are the
questions a second implementation cannot start without, and they are listed in
[../plan.md](../plan.md)'s gate table.

The "where" slot names the chapter section, so a reviewer can find the answer
without re-reading the chapter. Research and citations behind each answer are in
[../contracts/protocol-answers.md](../contracts/protocol-answers.md); a row is
G1-green because the **chapter** states the fact normatively, not because the
answers file does.

## 00-overview-and-versioning.md

- [x] **Q00.1** `CryptoVersion` is `1 | 2` with no v2 anywhere: reserved or deleted. Disposition: answered (reserved, never constructible). Where: [`docs/protocol/00-overview-and-versioning.md`](../../../docs/protocol/00-overview-and-versioning.md) §0.2.1
- [x] **Q00.2** Two record route prefixes: which is canonical for a new client. Disposition: answered (the unprefixed form; `/sync/records/*` is legacy). Where: [`docs/protocol/00-overview-and-versioning.md`](../../../docs/protocol/00-overview-and-versioning.md) §0.3.1
- [x] **Q00.3** No negotiated protocol version on the wire. Disposition: answered (stated as a cross-chapter rule). Where: [`docs/protocol/00-overview-and-versioning.md`](../../../docs/protocol/00-overview-and-versioning.md) §0.1

## 01-identity-and-keys.md

- [x] **Q01.1** `memry-signing-key-v1` and `memry-verify-key-v1` occupy subkey ids with no caller. Disposition: answered (reserved; ids 2 and 3 MUST NOT be reused). Where: [`docs/protocol/01-identity-and-keys.md`](../../../docs/protocol/01-identity-and-keys.md) §1.2.1
- [x] **Q01.2** **must answer.** Recovery phrase entry is unnormalised; whitespace and case change the seed. Disposition: answered (five normalisation steps; changes no existing phrase). Where: [`docs/protocol/01-identity-and-keys.md`](../../../docs/protocol/01-identity-and-keys.md) §1.3
- [x] **Q01.3** **must answer.** Whether a phone stores the master key, the vault key, or both. Disposition: answered (the master key only). Where: [`docs/protocol/01-identity-and-keys.md`](../../../docs/protocol/01-identity-and-keys.md) §1.6
- [x] **Q01.4** **must answer.** Multi vault: one vault key per account, since no vault id is mixed into the derivation. Disposition: answered (one key; vault association MUST be checked outside the ciphertext). Where: [`docs/protocol/01-identity-and-keys.md`](../../../docs/protocol/01-identity-and-keys.md) §1.7

## 02-auth-and-sessions.md

- [x] **Q02.1** `sessionNonce` optional on four schemas, enforced only when the token carries one. Disposition: answered (binds redemption to the sign-in session; SHOULD send, and send consistently). Where: [`docs/protocol/02-auth-and-sessions.md`](../../../docs/protocol/02-auth-and-sessions.md) §2.6
- [x] **Q02.2** Device registration challenge signs `nonce:jti` with no domain separation. Disposition: answered (no prefix for these two contexts; mandatory for any third). Where: [`docs/protocol/02-auth-and-sessions.md`](../../../docs/protocol/02-auth-and-sessions.md) §2.3.2
- [x] **Q02.3** `GET /auth/recovery` dummy data makes a wrong email and a wrong phrase indistinguishable. Disposition: answered (one combined message; no enumeration branch). Where: [`docs/protocol/02-auth-and-sessions.md`](../../../docs/protocol/02-auth-and-sessions.md) §2.7.1

## 03-device-linking.md

- [x] **Q03.1** **must answer.** `linkingSecret` format, length, and entropy. Disposition: answered (32 CSPRNG bytes, standard base64, 44 chars). Where: [`docs/protocol/03-device-linking.md`](../../../docs/protocol/03-device-linking.md) §3.3
- [x] **Q03.2** **must answer.** `LINKING_IP_MISMATCH`: which requests are IP-bound, and the Wi-Fi to cellular case. Disposition: answered (decision: relax the binding, #2184). Where: [`docs/protocol/03-device-linking.md`](../../../docs/protocol/03-device-linking.md) §3.11
- [x] **Q03.3** **must answer.** The linking session TTL behind `expiresAt`. Disposition: answered (300 s, absolute from initiate, never extended). Where: [`docs/protocol/03-device-linking.md`](../../../docs/protocol/03-device-linking.md) §3.4
- [x] **Q03.4** **must answer.** `encryptedProviderAuth` and `encryptedVaultTransfer` version literals. Disposition: answered (provider auth soft-fail and optional; vault transfer hard-fail and required). Where: [`docs/protocol/03-device-linking.md`](../../../docs/protocol/03-device-linking.md) §3.10
- [x] **Q03.5** **must answer.** Scan channel HMAC-SHA-256 versus confirm channel HMAC-SHA512-256: intentional or not. Disposition: answered (server-verified vs device-verified; the rationale is inferred and labelled). Where: [`docs/protocol/03-device-linking.md`](../../../docs/protocol/03-device-linking.md) §3.7

## 04-record-envelope.md

- [x] **Q04.1** Packed CRDT header is 160 and the signature sits at 96. Disposition: answered (160/96; the `offset 72` comment corrected in this change). Where: [`docs/protocol/04-record-envelope.md`](../../../docs/protocol/04-record-envelope.md) §4.11
- [x] **Q04.2** `EncryptedCrdtItem` declares fields with no producer: dead type or v2 shape. Disposition: answered (dead; MUST NOT be modelled). Where: [`docs/protocol/04-record-envelope.md`](../../../docs/protocol/04-record-envelope.md) §4.12.1
- [x] **Q04.3** `metadata.fieldClocks` is allowed by the signature schema and never written. Disposition: answered (a writer MUST NOT set it; a reader never sees it). Where: [`docs/protocol/04-record-envelope.md`](../../../docs/protocol/04-record-envelope.md) §4.8.1
- [x] **Q04.4** `EncryptedItem.signedAt` exists, is unsigned and unused. Disposition: answered (unused; MUST NOT be sent, MUST be ignored). Where: [`docs/protocol/04-record-envelope.md`](../../../docs/protocol/04-record-envelope.md) §4.8.2
- [x] **Q04.5** The server rewrites `cryptoVersion` to 1 when verifying. Disposition: answered (correct today because it is not a wire field; a v2 makes it one). Where: [`docs/protocol/04-record-envelope.md`](../../../docs/protocol/04-record-envelope.md) §4.10
- [x] **Q04.6** `CBOR_FIELD_ORDER.TOMBSTONE` has no producer. Disposition: answered (reserved and unused). Where: [`docs/protocol/04-record-envelope.md`](../../../docs/protocol/04-record-envelope.md) §4.8.3
- [x] **Q04.7** `SignaturePayloadV1Schema.deletedAt` admits a fractional number. Disposition: answered (a writer MUST NOT sign a non-integral number; the float rules are pinned as vectors). Where: [`docs/protocol/04-record-envelope.md`](../../../docs/protocol/04-record-envelope.md) §4.13
- [x] **Q04.8** The in-code comments claiming CBOR keeps a nested object's key order are wrong. Disposition: answered (the encoder sorts; all four comments corrected in this change). Where: [`docs/protocol/04-record-envelope.md`](../../../docs/protocol/04-record-envelope.md) §4.7.1

## 05-record-sync.md

- [x] **Q05.1** The shipped client always declares all 25 types, so the subset path is untested. Disposition: answered (the server serves only the declared set; FR-032's real risk is an unknown field). Where: [`docs/protocol/05-record-sync.md`](../../../docs/protocol/05-record-sync.md) §5.3.1
- [x] **Q05.2** The `deleted` array is untyped strings, so a subset subscriber cannot tell what a tombstone is for. Disposition: answered (record a bare tombstone; a delete for an unseen id is a no-op). Where: [`docs/protocol/05-record-sync.md`](../../../docs/protocol/05-record-sync.md) §5.12.1
- [x] **Q05.3** **must answer.** The same four blob fields are canonicalised twice, differently: JSON key sort and CBOR key sort. Disposition: answered (both orders stated; a client may assume neither). Where: [`docs/protocol/05-record-sync.md`](../../../docs/protocol/05-record-sync.md) §5.9
- [x] **Q05.4** `limit` above `MAX_CHANGES_LIMIT`: clamp or reject. Disposition: answered (clamped; a non-positive-integer limit is a 400). Where: [`docs/protocol/05-record-sync.md`](../../../docs/protocol/05-record-sync.md) §5.10.1
- [x] **Q05.5** `ConflictResponseSchema` and `SYNC_VERSION_CONFLICT` have no reader. Disposition: answered (a dead path; MUST NOT be implemented, MUST be tolerated). Where: [`docs/protocol/05-record-sync.md`](../../../docs/protocol/05-record-sync.md) §5.17
- [x] **Q05.6** `PULL_PAGE_LIMIT` is 500 in one engine and 100 in the other. Disposition: answered (both conforming; a new client SHOULD use 500). Where: [`docs/protocol/05-record-sync.md`](../../../docs/protocol/05-record-sync.md) §5.10.2

## 06-vector-clocks-and-field-merge.md

- [x] **Q06.1** **must answer.** The asymmetric `_offline` tie-break makes the outcome depend on which side is called local. Disposition: answered (converges via P1+P2+P3, not the merge rule). Where: [`docs/protocol/06-vector-clocks-and-field-merge.md`](../../../docs/protocol/06-vector-clocks-and-field-merge.md) §6.5.1, §6.5.2
- [x] **Q06.2** `clockTotal` sums across devices and ignores causality. Disposition: answered (tick-sum frozen as an edit-count proxy). Where: [`docs/protocol/06-vector-clocks-and-field-merge.md`](../../../docs/protocol/06-vector-clocks-and-field-merge.md) §6.5.3
- [x] **Q06.3** **must answer.** The canonical form a Rust implementation must produce for `JSON.stringify` equality. Disposition: answered (decision: mandate a canonical comparison, #2185). Where: [`docs/protocol/06-vector-clocks-and-field-merge.md`](../../../docs/protocol/06-vector-clocks-and-field-merge.md) §6.4.2, §6.4.3
- [x] **Q06.4** **must answer.** A concurrent pair with unequal totals resolves silently, so an edit is lost with no conflict surfaced. Disposition: answered (decision: freeze). Where: [`docs/protocol/06-vector-clocks-and-field-merge.md`](../../../docs/protocol/06-vector-clocks-and-field-merge.md) §6.5.4
- [x] **Q06.5** Which types field-merge and which document-merge. Disposition: answered (enumerated; never inferred from the absence of a list). Where: [`docs/protocol/06-vector-clocks-and-field-merge.md`](../../../docs/protocol/06-vector-clocks-and-field-merge.md) §6.8
- [x] **Q06.6** Nothing prunes a vector clock. Disposition: answered (no pruning rule; growth bounded by the 50-device cap and recorded). Where: [`docs/protocol/06-vector-clocks-and-field-merge.md`](../../../docs/protocol/06-vector-clocks-and-field-merge.md) §6.10

## 07-crdt-updates.md

- [x] **Q07.1** **must answer.** The journal question FR-003 names: journal body as CRDT document or as record. Disposition: answered (decision: correct the constants, #2186). Where: [`docs/protocol/07-crdt-updates.md`](../../../docs/protocol/07-crdt-updates.md) §7.1
- [x] **Q07.2** **must answer.** Whether a phone may push a CRDT snapshot, and on what trigger. Disposition: answered (gate is MUST, cadence is SHOULD, no MUST-snapshot). Where: [`docs/protocol/07-crdt-updates.md`](../../../docs/protocol/07-crdt-updates.md) §7.13
- [x] **Q07.3** No server-side signature verification on CRDT updates. Disposition: answered (in the threat model; withholding is undefended and recorded). Where: [`docs/protocol/07-crdt-updates.md`](../../../docs/protocol/07-crdt-updates.md) §7.14
- [x] **Q07.4** What happens to `crdt_updates` and `crdt_snapshots` when a note is deleted. Disposition: answered (nothing; only vault and account deletion remove them). Where: [`docs/protocol/07-crdt-updates.md`](../../../docs/protocol/07-crdt-updates.md) §7.15
- [x] **Q07.5** Update fetch caps at 500 one way and 100 the other. Disposition: answered (differently scoped; both correct). Where: [`docs/protocol/07-crdt-updates.md`](../../../docs/protocol/07-crdt-updates.md) §7.3.1
- [x] **Q07.6** `snapshotMeta.signerDeviceId` is advertised and ignored. Disposition: answered (advisory; a client MUST NOT branch on it). Where: [`docs/protocol/07-crdt-updates.md`](../../../docs/protocol/07-crdt-updates.md) §7.11.1

## 08-pack-container.md

- [x] **Q08.1** `crdt_update = 2` is defined but reserved. Disposition: answered (accept structurally, MAY decline the entry). Where: [`docs/protocol/08-pack-container.md`](../../../docs/protocol/08-pack-container.md) §8.4.1
- [x] **Q08.2** Is a client ever a pack writer. Disposition: answered (never; reader only). Where: [`docs/protocol/08-pack-container.md`](../../../docs/protocol/08-pack-container.md) §8.1
- [x] **Q08.3** `flags` is a uint16 fixed at 0: reject non-zero or ignore. Disposition: answered (ignore; an incompatible change bumps PACK_VERSION instead). Where: [`docs/protocol/08-pack-container.md`](../../../docs/protocol/08-pack-container.md) §8.7
- [x] **Q08.4** Packs are optional, so a client that never fetches one is still correct. Disposition: answered (stated first in the chapter). Where: [`docs/protocol/08-pack-container.md`](../../../docs/protocol/08-pack-container.md) §8.0

## 09-realtime.md

- [x] **Q09.1** Whether a conforming phone client opens the socket at all. Disposition: answered (optional and foreground-only; full pull on resume). Where: [`docs/protocol/09-realtime.md`](../../../docs/protocol/09-realtime.md) §9.1
- [x] **Q09.2** `heartbeat` has no payload schema and no handler. Disposition: answered (dead; the keepalive is client-initiated). Where: [`docs/protocol/09-realtime.md`](../../../docs/protocol/09-realtime.md) §9.5.2
- [x] **Q09.3** `calendar_changes_available`, `linking_request` and `linking_approved` have no payload schema. Disposition: answered (all three shapes stated, read from their producers). Where: [`docs/protocol/09-realtime.md`](../../../docs/protocol/09-realtime.md) §9.5.1
- [x] **Q09.4** Reconnect policy, backoff, and behaviour between a 4003 and a successful refresh. Disposition: answered (the reference policy adopted; the 4003 sequence written). Where: [`docs/protocol/09-realtime.md`](../../../docs/protocol/09-realtime.md) §9.10, §9.10.1

## 10-bootstrap-session.md

- [x] **Q10.1** **must answer.** Is a bootstrap session required for FR-028 and SC-007, or an optimisation. Disposition: answered (an optimisation, never required). Where: [`docs/protocol/10-bootstrap-session.md`](../../../docs/protocol/10-bootstrap-session.md) §10.6
- [x] **Q10.2** A first sync exceeding the 6 hour absolute lifetime falls back mid-run. Disposition: answered (treated as a rate change; progress MUST survive it). Where: [`docs/protocol/10-bootstrap-session.md`](../../../docs/protocol/10-bootstrap-session.md) §10.11
- [x] **Q10.3** `BOOTSTRAP_SESSION_HMAC_KEY` is optional per deployment; staging must have it. Disposition: answered (behaviour specified; the deployment's configuration is verified operationally). Where: [`docs/protocol/10-bootstrap-session.md`](../../../docs/protocol/10-bootstrap-session.md) §10.12

## 11-client-policy.md

- [x] **Q11.1** Two version gates coexist, one on HTTP writes and one on the socket. Disposition: answered (both live; only the HTTP gate drives read-only mode). Where: [`docs/protocol/11-client-policy.md`](../../../docs/protocol/11-client-policy.md) §11.11
- [x] **Q11.2** The poll interval a conforming client should use for `clientPolicy`. Disposition: answered (foreground, pre-drain, and at most 300 s; there is no push channel). Where: [`docs/protocol/11-client-policy.md`](../../../docs/protocol/11-client-policy.md) §11.8.1
- [x] **Q11.3** Attribution keeps only the latest writer, so a rollback window is bounded by rewrites. Disposition: answered (limitation recorded for an incident responder). Where: [`docs/protocol/11-client-policy.md`](../../../docs/protocol/11-client-policy.md) §11.10.1

## 12-note-body-format.md

- [x] **Q12.1** **must answer.** Frontmatter key ordering on the edited path. Disposition: answered (decision: option B, the verbatim path is the only guarantee). Where: [`docs/protocol/12-note-body-format.md`](../../../docs/protocol/12-note-body-format.md) §12.4.3
- [x] **Q12.2** **must answer.** Markdown to Y.Doc conversion: who owns it. Disposition: answered (the editor bundle owns both directions; `doc-load.seedMarkdown`, not `seed-from-markdown`). Where: [`docs/protocol/12-note-body-format.md`](../../../docs/protocol/12-note-body-format.md) §12.1
- [x] **Q12.3** The three-way merge resolves a genuine conflict in favour of the house style. Disposition: answered (desktop write-back behaviour; the core never merges). Where: [`docs/protocol/12-note-body-format.md`](../../../docs/protocol/12-note-body-format.md) §12.10
- [x] **Q12.4** `MAX_EDIT_DISTANCE = 2000` silently changes behaviour by size. Disposition: answered (an implementation budget of one writer, not a protocol constant). Where: [`docs/protocol/12-note-body-format.md`](../../../docs/protocol/12-note-body-format.md) §12.10
- [x] **Q12.5** **must answer.** Which of the seven Y.Doc roots a conforming client must preserve. Disposition: answered (seven roots, not eight; every root MUST survive, unnamed ones included). Where: [`docs/protocol/12-note-body-format.md`](../../../docs/protocol/12-note-body-format.md) §12.5
- [x] **Q12.6** The encoding of `inlineImage` and `inlineCheckbox` outside a table. Disposition: answered (there is none; outside a table they are the block forms). Where: [`docs/protocol/12-note-body-format.md`](../../../docs/protocol/12-note-body-format.md) §12.7.1

## 13-payload-schemas.md

- [x] **Q13.1** The `settings` payload merges rather than replaces. Disposition: answered (the verbatim stored payload is the copy; no settings-specific mechanism). Where: [`docs/protocol/13-payload-schemas.md`](../../../docs/protocol/13-payload-schemas.md) §13.10
- [x] **Q13.2** **must answer.** Verbatim payload preservation against Zod's unknown-key stripping. Disposition: answered (five normative rules; desktop is the non-reference, #2183). Where: [`docs/protocol/13-payload-schemas.md`](../../../docs/protocol/13-payload-schemas.md) §13.2
- [x] **Q13.3** Whether `home_page` is really out of scope. Disposition: answered (out of scope, and orphans nothing). Where: [`docs/protocol/13-payload-schemas.md`](../../../docs/protocol/13-payload-schemas.md) §13.11
- [x] **Q13.4** `task_activity` retention on a phone, and whether local deletion causes a re-pull loop. Disposition: answered (a 90-day age rule enforced on apply and on write; no loop). Where: [`docs/protocol/13-payload-schemas.md`](../../../docs/protocol/13-payload-schemas.md) §13.12

## 14-attachments.md

- [x] **Q14.1** Which routes a read-only, inline-image-only client needs. Disposition: answered (three routes). Where: [`docs/protocol/14-attachments.md`](../../../docs/protocol/14-attachments.md) §14.5.1
- [x] **Q14.2** What connects `attachmentReferences` to a manifest. Disposition: answered (the array holds attachment ids; the full resolution chain is written). Where: [`docs/protocol/14-attachments.md`](../../../docs/protocol/14-attachments.md) §14.7
- [x] **Q14.3** Whether never dereferencing chunks is safe. Disposition: answered (safe; quota is consumed by uploads only). Where: [`docs/protocol/14-attachments.md`](../../../docs/protocol/14-attachments.md) §14.8
- [x] **Q14.4** `CHUNK_SIZE` is a desktop constant, not a contract constant. Disposition: answered (per-file `chunkSize` in the manifest; the desktop constant is a writer's choice). Where: [`docs/protocol/14-attachments.md`](../../../docs/protocol/14-attachments.md) §14.9

---

**Count**: 69 questions, 19 of them must-answer. If the outline grows a question,
this file grows a row in the same change; a question that exists in one file and not
the other is a review failure.

**State on 2026-09-13**: **69 answered, 0 undefined, 0 undispositioned.** Every
must-answer row reads answered: Q01.2, Q01.3, Q01.4, Q03.1, Q03.2, Q03.3, Q03.4, Q03.5, Q05.3, Q06.1, Q06.3, Q06.4, Q07.1, Q07.2, Q10.1, Q12.1, Q12.2, Q12.5, Q13.2.

**Issues, tracked separately and not checklist rows.** Nine were opened while
answering, all labelled `protocol-spec`: #2179 (`_offline` on the wire), #2180 (the
push/pull merge race), #2181 (`compactYDoc` drops roots), #2182 (the `cancelled`
linking status), #2183 (desktop strips unknown payload keys), #2184 (relaxing
`LINKING_IP_MISMATCH`), #2185 (the canonical value comparison), #2186 (the journal
CRDT constants), #2187 (returning `revision` from a snapshot push). Four decisions
are written into the chapters and are not re-litigated: #2184, #2185, #2186 and
Q12.1 option B. Where a chapter describes behaviour one of them changes, the
chapter states the current behaviour, cites the issue, and marks what will change.

**Two dispositions that are answers _about_ an undefined area**, and are called out
so a reviewer does not mistake them for silent drops. Both are stated inside their
chapter as explicit "undefined, do not rely on this" clauses sitting under an
answered question:

- chapter 06 §6.6.2 — the push-build / pull-apply race (#2180) has no chosen fix,
  and a client MUST NOT depend on either outcome.
- chapter 12 §12.5.2 — the two-writer case where a document's `tags` root and the
  note record payload's `tags` disagree has no tiebreak.

One further open item is recorded in chapter 12 §12.2: whether the guest
serialiser's output is acceptable as create-time `content` is undefined, so
create-time `content` is best-effort and the Y.Doc pushed alongside is
authoritative.
