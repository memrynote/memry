//! The `note_body` payload decoder is a reader of persisted data: its size cap, its strict
//! alphabet and its output bound.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use memry_test_kit::{assert_output_bounded, on_small_stack, output_bound, proptest_config};
use proptest::prelude::*;
use yrs::updates::encoder::Encode as _;
use yrs::{ClientID, ID, IdSet, Snapshot, StateVector};

use super::{MAX_BODY_PAYLOAD, decode_payload, takes_unstored_file};
use crate::electron_import::ImportError;

fn refused(result: Result<Option<Vec<u8>>, ImportError>) -> &'static str {
    match result {
        Err(ImportError::MalformedRow { what, .. }) => what,
        other => panic!(
            "not refused: {:?}",
            other.map(|bytes| bytes.map(|b| b.len()))
        ),
    }
}

/// Valid base64 one block past the cap is refused before it is decoded.
#[test]
fn a_payload_over_the_cap_is_refused_before_decoding() {
    let payload = "QUFB".repeat(MAX_BODY_PAYLOAD / 4 + 1);
    assert_eq!(
        refused(decode_payload(&payload, 1)),
        "a note_body payload is over the size cap"
    );
    let at_cap = "QUFB".repeat(MAX_BODY_PAYLOAD / 4);
    let decoded = decode_payload(&at_cap, 1).unwrap().unwrap();
    assert_output_bounded("note_body payload", at_cap.len(), decoded.len());
}

/// Electron writes `Buffer.toString('base64')`: padded, standard alphabet, no whitespace.
#[test]
fn only_strict_standard_base64_decodes() {
    assert_eq!(decode_payload("QQ==", 1).unwrap(), Some(b"A".to_vec()));
    assert_eq!(
        decode_payload("", 1).unwrap(),
        None,
        "the full-state payload"
    );
    for payload in [
        "QQ",
        "QQ==\n",
        " QQ==",
        "-_8=",
        "QQ=",
        "Q===",
        "not base64!",
    ] {
        assert_eq!(
            refused(decode_payload(payload, 1)),
            "a note_body payload is not base64",
            "{payload:?}"
        );
    }
}

/// The decoder holds no recursion: a payload at the cap decodes on a 2 MiB stack.
#[test]
fn a_payload_at_the_cap_decodes_on_a_small_stack() {
    let len = on_small_stack(|| {
        decode_payload(&"QUFB".repeat(MAX_BODY_PAYLOAD / 4), 1)
            .map(|bytes| bytes.map_or(0, |b| b.len()))
    });
    assert_eq!(len.unwrap(), MAX_BODY_PAYLOAD / 4 * 3);
}

proptest! {
    #![proptest_config(proptest_config(256))]

    /// Any text decodes within the output bound or is refused as a malformed row; Electron's
    /// own encoding round-trips.
    #[test]
    fn any_payload_decodes_bounded_or_is_refused(text in "(?s).{0,96}", bytes in proptest::collection::vec(any::<u8>(), 0..96)) {
        match decode_payload(&text, 1) {
            Ok(Some(decoded)) => prop_assert!(decoded.len() <= output_bound(text.len())),
            Ok(None) => prop_assert!(text.is_empty()),
            Err(error) => {
                let typed = matches!(error, ImportError::MalformedRow { .. });
                prop_assert!(typed);
            }
        }
        let encoded = STANDARD.encode(&bytes);
        let expected = (!bytes.is_empty()).then(|| bytes.clone());
        prop_assert_eq!(decode_payload(&encoded, 1).unwrap(), expected);
    }
}

/// A snapshot holding client 1 up to `clock`, with `deleted` of it deleted.
fn snapshot(clock: u32, deleted: &[(u32, u32)]) -> Snapshot {
    let mut ds = IdSet::new();
    for &(start, len) in deleted {
        ds.insert(ID::new(ClientID::new(1), start), len);
    }
    Snapshot::new(StateVector::from_iter([(ClientID::new(1), clock)]), ds)
}

fn mark(written: &Snapshot, baseline: Option<&Snapshot>) -> String {
    let part = |s: &Snapshot| STANDARD.encode(s.encode_v1());
    format!(
        "unstored-file:h-written:{}:{}",
        part(written),
        baseline.map(part).unwrap_or_default()
    )
}

/// Electron's `takesUnstoredFile`: the file is the doc's own only when the stored doc covers
/// the snapshot recorded for the file's hash.
#[test]
fn an_unstored_file_is_taken_unless_the_store_covers_its_write() {
    let held = snapshot(10, &[(2, 3)]);
    let covered = mark(&snapshot(8, &[(3, 1)]), Some(&snapshot(4, &[])));
    // The marked write, covered by the store: the doc's own.
    assert!(!takes_unstored_file(
        &covered,
        "h-cached",
        "h-written",
        &held
    ));
    // The bytes under content_hash, covered.
    assert!(!takes_unstored_file(
        &covered, "h-cached", "h-cached", &held
    ));
    // A file with no recorded snapshot is an outside edit.
    assert!(takes_unstored_file(&covered, "h-cached", "h-other", &held));
    // An insert the store lacks.
    let ahead = mark(&snapshot(11, &[]), None);
    assert!(takes_unstored_file(&ahead, "h-cached", "h-written", &held));
    // A delete the store lacks.
    let deleted = mark(&snapshot(8, &[(1, 2)]), None);
    assert!(takes_unstored_file(
        &deleted,
        "h-cached",
        "h-written",
        &held
    ));
    // No snapshot for the bytes under content_hash.
    assert!(takes_unstored_file(&ahead, "h-cached", "h-cached", &held));
}

/// A mark this build cannot read takes the file in: the bare mark of an earlier build of #5698,
/// a pre-release flag, a part that is not base64 or not a snapshot.
#[test]
fn an_unreadable_unstored_mark_takes_the_file_in() {
    let held = snapshot(10, &[]);
    for mark in [
        "unstored-file",
        "unstored-file:h-written:1:",
        "unstored-file:h-written:!!!!:",
        "unstored-file:h-written:////:",
        "unstored-file::AAAA:",
    ] {
        assert!(
            takes_unstored_file(mark, "h-cached", "h-written", &held),
            "{mark}"
        );
    }
}
