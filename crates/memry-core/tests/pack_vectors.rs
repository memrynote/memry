//! The `pack-container` committed vector class, chapter 08.
//!
//! This class is **reader-only by design** (`README.md` rule 1): the MPAK
//! writer is server-side and is deliberately not ported, so the file records
//! container bytes and asserts the production reader against them. Nothing
//! here builds a pack — a writer written to "check" the reader would prove
//! only that the two agree with each other.
//!
//! The harness rule is otherwise the usual one: the committed JSON is the
//! input and the only input, and no expectation is recomputed.

mod support;

use memry_core::protocol::pack::{
    self, PACK_HEADER_SIZE, PACK_MAGIC, PACK_MAX_ENTRIES, PACK_VERSION, PackError, PackKind,
    PackRegion,
};
use support::{hex_field, str_field, vector_file};

/// `meta.layout` and `meta.kindCodes` are the chapter's tables in
/// machine-readable form. Asserting the crate constants against them is what
/// makes a constant that moves under the chapter a red build rather than a
/// review note (FR-008).
#[test]
fn pack_container_layout_matches_the_crate_constants() {
    let vectors = vector_file("pack-container");
    let layout = &vectors["meta"]["layout"];

    assert_eq!(
        layout["PACK_MAGIC"].as_str(),
        Some(std::str::from_utf8(&PACK_MAGIC).expect("ASCII"))
    );
    assert_eq!(
        layout["PACK_VERSION"].as_u64(),
        Some(u64::from(PACK_VERSION))
    );
    assert_eq!(
        layout["PACK_HEADER_SIZE"].as_u64(),
        Some(PACK_HEADER_SIZE as u64)
    );
    assert_eq!(
        layout["PACK_FOOTER_SIZE"].as_u64(),
        Some(pack::PACK_FOOTER_SIZE as u64)
    );
    assert_eq!(layout["PACK_MAX_ENTRIES"].as_u64(), Some(PACK_MAX_ENTRIES));

    let kinds = &vectors["meta"]["kindCodes"];
    assert_eq!(
        kinds["record"].as_u64(),
        Some(u64::from(PackKind::Record.code()))
    );
    assert_eq!(
        kinds["crdt_snapshot"].as_u64(),
        Some(u64::from(PackKind::CrdtSnapshot.code()))
    );
    assert_eq!(
        kinds["crdt_update"].as_u64(),
        Some(u64::from(PackKind::CrdtUpdate.code()))
    );
}

/// Chapter 08 §8.4.2 and §8.4.3, as far as the decoded index reaches without
/// a record or kind 2 reader in this crate: identity, `sortKey`, `keyBytes` and
/// meta of every entry an `entryContract` names. Signature and decrypt checks
/// run in the reference verifier (`pack-container.test.ts`).
#[test]
fn pack_entry_contract_vectors() {
    let vectors = vector_file("pack-container");
    let cases = vectors["cases"].as_array().expect("cases");
    let mut checked = 0;

    for case in cases.iter().filter(|c| c.get("entryContract").is_some()) {
        let name = str_field(case, "name");
        let contract = &case["entryContract"];
        let parsed = pack::parse_pack(&hex_field(case, "packHex"))
            .unwrap_or_else(|error| panic!("{name}: the pack was refused: {error}"));

        let records = contract["records"]
            .as_array()
            .map_or(&[][..], Vec::as_slice);
        let record_entries = parsed
            .entries
            .iter()
            .filter(|e| e.kind == PackKind::Record)
            .count();
        assert_eq!(record_entries, records.len(), "{name}: record entry count");
        for want in records.iter().filter(|r| r.get("pullItem").is_some()) {
            let id = str_field(want, "id");
            let entry = parsed
                .entries
                .iter()
                .find(|e| e.kind == PackKind::Record && e.id == id)
                .unwrap_or_else(|| panic!("{name}: no record entry {id}"));
            let pull = &want["pullItem"];
            // `type:id` splits at the FIRST colon: no record type holds one.
            let (item_type, item_id) = entry.id.split_once(':').expect("type:id");
            assert_eq!(item_type, str_field(pull, "type"), "{name}: type");
            assert_eq!(item_id, str_field(pull, "id"), "{name}: id");
            assert_eq!(
                entry.sort_key,
                want["sortKey"].as_i64().expect("sortKey"),
                "{name}: sortKey"
            );
            // keyBytes is the row's sync_items.blob_key (§8.4.2).
            assert_eq!(
                entry.source_key,
                str_field(want, "sourceKey"),
                "{name}: record keyBytes"
            );
            let mut meta = pull.as_object().expect("pullItem").clone();
            for key in ["id", "type", "blob"] {
                meta.remove(key);
            }
            assert_eq!(
                entry.meta.as_ref(),
                Some(&serde_json::Value::Object(meta)),
                "{name}: meta is the pull item minus id, type, blob"
            );
            checked += 1;
        }

        let updates: Vec<_> = parsed
            .entries
            .iter()
            .filter(|e| e.kind == PackKind::CrdtUpdate)
            .collect();
        for entry in &updates {
            // An update has no R2 object, so keyBytes is empty (§8.4.3).
            assert_eq!(entry.source_key, "", "{name}: kind 2 keyBytes");
            let meta = entry.meta.as_ref().expect("kind 2 meta");
            assert!(
                meta["sequenceNum"].as_u64().is_some_and(|n| n >= 1),
                "{name}"
            );
            assert!(
                meta["signerDeviceId"]
                    .as_str()
                    .is_some_and(|s| !s.is_empty()),
                "{name}"
            );
            assert!(meta["createdAt"].as_u64().is_some(), "{name}");
        }
        let wanted = contract["updates"]
            .as_array()
            .map_or(&[][..], Vec::as_slice);
        // `zip` stops at the shorter side, so an entry dropped on either side
        // must fail here first. Plan cases carry entries with no expectations.
        if contract.get("updatePlans").is_none() {
            assert_eq!(updates.len(), wanted.len(), "{name}: kind 2 entry count");
        }
        for (entry, want) in updates.iter().zip(wanted) {
            assert_eq!(entry.id, str_field(want, "noteId"), "{name}: noteId");
            assert_eq!(
                entry.sort_key,
                want["sortKey"].as_i64().expect("sortKey"),
                "{name}: sortKey"
            );
            assert_eq!(entry.meta.as_ref(), want.get("meta"), "{name}: meta");
            checked += 1;
        }
    }

    assert!(checked >= 7, "entryContract cases went missing: {checked}");
}

#[test]
fn pack_container_vectors() {
    let vectors = vector_file("pack-container");
    let cases = vectors["cases"].as_array().expect("cases");
    let error_cases = vectors["errorCases"].as_array().expect("errorCases");

    assert_eq!(
        vectors["meta"]["caseCount"].as_u64(),
        Some((cases.len() + error_cases.len()) as u64),
        "meta.caseCount must cover both arrays"
    );

    for case in cases {
        let name = str_field(case, "name");
        let bytes = hex_field(case, "packHex");
        let expected = &case["expected"];

        let parsed = pack::parse_pack(&bytes)
            .unwrap_or_else(|error| panic!("{name}: the pack was refused: {error}"));

        assert_eq!(
            u64::from(parsed.version),
            expected["version"].as_u64().expect("version"),
            "{name}: version"
        );
        // `integrityVerified` is a field on the reference reader's return and
        // a property of the type here: `VerifiedPack` has no constructor that
        // skips the digests, so reaching this line is the assertion.
        assert_eq!(
            expected["integrityVerified"].as_bool(),
            Some(true),
            "{name}: every recorded success case is a verified one"
        );

        let expected_entries = expected["entries"].as_array().expect("entries");
        assert_eq!(
            parsed.entries.len(),
            expected_entries.len(),
            "{name}: entry count"
        );

        for (index, (entry, want)) in parsed.entries.iter().zip(expected_entries).enumerate() {
            let at = format!("{name}: entry {index}");

            assert_eq!(entry.kind.as_str(), str_field(want, "kind"), "{at}: kind");
            // `idLen` counts bytes, not characters: the multi-byte case fails
            // here first if that is ever confused.
            assert_eq!(entry.id, str_field(want, "id"), "{at}: id");
            assert_eq!(
                entry.source_key,
                str_field(want, "sourceKey"),
                "{at}: sourceKey"
            );
            assert_eq!(
                entry.sort_key,
                want["sortKey"].as_i64().expect("sortKey"),
                "{at}: sortKey"
            );
            assert_eq!(
                entry.offset,
                want["offset"].as_u64().expect("offset"),
                "{at}: offset"
            );
            assert_eq!(
                entry.length,
                want["length"].as_u64().expect("length"),
                "{at}: length"
            );
            // `metaLen` 0 means NO meta key on the decoded entry, which is not
            // the same as an empty object (§8.3).
            assert_eq!(entry.meta.as_ref(), want.get("meta"), "{at}: meta");

            // The payload bytes an entry points at are exactly as long as it
            // claims, which is the §8.3 off-by-eight: `offset` is relative to
            // the payload region, not to the file.
            let payload = pack::extract_entry(&bytes, entry)
                .unwrap_or_else(|error| panic!("{at}: extract failed: {error}"));
            assert_eq!(payload.len() as u64, entry.length, "{at}: extracted length");
            assert_eq!(
                &bytes[PACK_HEADER_SIZE + entry.offset as usize..][..payload.len()],
                payload,
                "{at}: extracted slice"
            );
        }
    }

    /// Asserts the recorded message when the class fixes one. A case with no
    /// `expectErrorContains` is one where the reference's English is
    /// unreachable for a conforming reader, and only the code is normative.
    fn assert_message(name: &str, error: &PackError, expected: Option<&str>) {
        if let Some(expected) = expected {
            assert!(
                error.to_string().contains(expected),
                "{name}: {error} does not contain {expected}"
            );
        }
    }

    for case in error_cases {
        let name = str_field(case, "name");
        let bytes = hex_field(case, "packHex");
        // The portable contract is the code; the message is one reader's
        // English. §8.5's table is normative about the English for the four
        // cases it fixes, so those assert both, and the fifth asserts only
        // the code — see its arm below.
        let expected_code = str_field(case, "expectErrorCode");
        let expected_message = case["expectErrorContains"].as_str();

        let error = pack::parse_pack(&bytes).expect_err(&format!("{name}: expected a rejection"));

        match expected_code {
            "header-magic-mismatch" => {
                assert_eq!(error, PackError::HeaderMagicMismatch, "{name}");
                assert_message(name, &error, expected_message);
            }
            "unsupported-version" => {
                assert_eq!(
                    error,
                    PackError::UnsupportedVersion {
                        version: 2,
                        region: PackRegion::Header,
                    },
                    "{name}"
                );
                assert_message(name, &error, expected_message);
            }
            "payload-checksum-mismatch" => {
                assert_eq!(error, PackError::PayloadChecksumMismatch, "{name}");
                assert_message(name, &error, expected_message);
            }
            "entry-checksum-mismatch" => {
                assert_eq!(
                    error,
                    PackError::EntryChecksumMismatch {
                        id: "abc123def456".to_owned(),
                    },
                    "{name}"
                );
                assert_message(name, &error, expected_message);
            }
            "entry-count-too-large" => {
                // The one case with no `expectErrorContains`, deliberately.
                // The reference reader says `pack truncated` only because it
                // runs out of index bytes; §8.6 says so itself and then
                // requires a conforming reader to apply the cap *before
                // allocating*, which is an earlier and different failure.
                // Reproducing the message would mean deleting the check the
                // chapter mandates, so the vector now records the message as
                // `referenceOnlyMessage` and pins only the code.
                assert_eq!(
                    error,
                    PackError::EntryCountTooLarge {
                        count: 4097,
                        max: PACK_MAX_ENTRIES,
                    },
                    "{name}"
                );
            }
            other => panic!("unknown error case `{other}`"),
        }
    }
}
