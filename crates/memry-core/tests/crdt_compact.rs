//! The `crdt-compact` committed vector class, chapter 12 §12.5.4: a load plan
//! in, the local snapshot `compact_doc` folds it to (or its refusal) out. The
//! committed JSON is the only input.
//!
//! A snapshot is compared as the document it encodes: both are re-encoded by
//! one encoder and must match byte for byte, and their lengths must match too.
//! Only the delete set's client order may differ between the two (yjs writes
//! clients in the order its store met them, `yrs` in its map's).

#[allow(unused_imports)]
use crate::support;

use memry_core::crdt::compact::compact_doc;
use memry_core::crdt::update_log::{LoadPlan, SnapshotRow, UpdateRow};
use serde_json::Value as Json;
use support::{optional_hex_field, str_field, vector_file};
use yrs::updates::decoder::Decode as _;
use yrs::{Array as _, Doc, ReadTxn as _, StateVector, Transact as _, Update};

fn blobs(input: &Json, field: &str) -> Vec<Vec<u8>> {
    input[field]
        .as_array()
        .unwrap_or_else(|| panic!("`{field}` is not an array"))
        .iter()
        .map(|blob| hex::decode(blob.as_str().expect("a hex blob")).expect("hex"))
        .collect()
}

fn rows(blobs: Vec<Vec<u8>>) -> Vec<UpdateRow> {
    (1..)
        .zip(blobs)
        .map(|(seq, update_blob)| UpdateRow {
            seq,
            update_blob,
            created_at: seq,
        })
        .collect()
}

fn plan(input: &Json) -> LoadPlan {
    LoadPlan {
        server_snapshot: None,
        server_updates: rows(blobs(input, "server")),
        local_snapshot: optional_hex_field(input, "localSnapshot").map(|snapshot| SnapshotRow {
            snapshot,
            last_seq: 0,
            server_revision: None,
            compacted_at: 0,
        }),
        local_updates: rows(blobs(input, "local")),
    }
}

fn replay(blobs: &[&[u8]]) -> Doc {
    let doc = Doc::new();
    for blob in blobs {
        doc.transact_mut()
            .apply_update(Update::decode_v1(blob).expect("decode"))
            .expect("apply");
    }
    doc
}

fn encode(doc: &Doc) -> Vec<u8> {
    doc.transact()
        .encode_state_as_update_v1(&StateVector::default())
}

/// `state` re-encoded by `yrs`, as hex.
fn canonical(state: &[u8]) -> String {
    hex::encode(encode(&replay(&[state])))
}

#[test]
fn every_crdt_compact_case_folds_to_the_committed_snapshot() {
    let file = vector_file("crdt-compact");
    let cases = file["cases"].as_array().expect("cases");
    assert_eq!(cases.len(), 8);
    for case in cases {
        let name = str_field(case, "name");
        let input = &case["input"];
        let expected = &case["expected"];
        let compacted = compact_doc("abc123def456", &plan(input))
            .unwrap_or_else(|error| panic!("{name}: {error}"));
        let Some(state) = optional_hex_field(expected, "state") else {
            assert_eq!(compacted, None, "{name}: refused");
            continue;
        };
        let compacted = compacted.unwrap_or_else(|| panic!("{name}: compacts"));
        assert_eq!(compacted.state.len(), state.len(), "{name}: length");
        assert_eq!(canonical(&compacted.state), canonical(&state), "{name}");
        assert_eq!(
            Some(compacted.saved_bytes as u64),
            expected["savedBytes"].as_u64(),
            "{name}"
        );
        if let Some(peer) = optional_hex_field(input, "peer") {
            let merged = replay(&[&compacted.state, &peer])
                .transact()
                .encode_state_as_update_v1(&StateVector::default());
            let with_peer = optional_hex_field(expected, "withPeer").expect("withPeer");
            assert_eq!(
                hex::encode(merged),
                hex::encode(with_peer),
                "{name}: the peer edit"
            );
        }
    }
}

/// The snapshot carries roots the reader never typed, which a root copy drops
/// (§12.5.3): read back with no accessor called first, they are there.
#[test]
fn a_compacted_snapshot_keeps_the_roots_this_build_does_not_type() {
    let file = vector_file("crdt-compact");
    let case = file["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .find(|case| case["name"] == "roots this build does not type survive")
        .expect("the case");
    let compacted = compact_doc("abc123def456", &plan(&case["input"]))
        .expect("compact")
        .expect("a snapshot");
    let doc = replay(&[&compacted.state]);
    let future = doc.get_or_insert_array("someFutureRoot");
    let txn = doc.transact();
    assert_eq!(future.len(&txn), 2);
    assert!(txn.root_refs().any(|(name, _)| name == "markdownSource"));
    assert!(txn.root_refs().any(|(name, _)| name == "anotherFutureText"));
}
