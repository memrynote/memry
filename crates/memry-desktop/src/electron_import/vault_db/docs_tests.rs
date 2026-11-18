//! The `note_body` payload decoder is a reader of persisted data: its size cap, its strict
//! alphabet and its output bound.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use memry_test_kit::{assert_output_bounded, on_small_stack, output_bound, proptest_config};
use proptest::prelude::*;

use super::{MAX_BODY_PAYLOAD, decode_payload};
use crate::electron_import::ImportError;

fn refused(result: Result<Option<Vec<u8>>, ImportError>) -> &'static str {
    match result {
        Err(ImportError::MalformedRow { what, .. }) => what,
        other => panic!("not refused: {:?}", other.map(|bytes| bytes.map(|b| b.len()))),
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
    assert_eq!(decode_payload("", 1).unwrap(), None, "the full-state payload");
    for payload in ["QQ", "QQ==\n", " QQ==", "-_8=", "QQ=", "Q===", "not base64!"] {
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
