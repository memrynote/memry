//! The `crdt-update` committed vector class, chapter 04 §4.11 and §4.12.
//!
//! Separate from `vectors.rs` because that file already carries six classes and
//! this one needs the packed envelope's own fixtures. The harness rule is the
//! same: the committed JSON is the only input, nothing here regenerates or
//! recomputes an expectation.

mod support;

use memry_core::crypto::sodium;
use memry_core::protocol::crdt_envelope::{
    self, CIPHERTEXT_OFFSET, CrdtMaterial, CrdtRequest, DATA_NONCE_OFFSET, HEADER_BYTES,
    KEY_NONCE_OFFSET, MIN_PACKED_BYTES, SIGNATURE_OFFSET, WRAPPED_KEY_OFFSET,
};
use memry_core::protocol::envelope::{
    EnvelopeError, NONCE_BYTES, SIGNATURE_BYTES, WRAPPED_KEY_BYTES,
};
use support::{hex_field, str_field, vector_file};
use zeroize::Zeroizing;

/// `meta.layout` is the chapter's table in machine-readable form. Asserting the
/// crate constants against it is what makes a constant that moves under the
/// chapter a red build rather than a review note (FR-008).
#[test]
fn crdt_update_layout_matches_the_crate_constants() {
    let vectors = vector_file("crdt-update");
    let layout = &vectors["meta"]["layout"];

    assert_eq!(layout["headerBytes"].as_u64(), Some(HEADER_BYTES as u64));
    assert_eq!(
        layout["dataNonceOffset"].as_u64(),
        Some(DATA_NONCE_OFFSET as u64)
    );
    assert_eq!(
        layout["keyNonceOffset"].as_u64(),
        Some(KEY_NONCE_OFFSET as u64)
    );
    assert_eq!(
        layout["wrappedKeyOffset"].as_u64(),
        Some(WRAPPED_KEY_OFFSET as u64)
    );
    assert_eq!(
        layout["signatureOffset"].as_u64(),
        Some(SIGNATURE_OFFSET as u64)
    );
    assert_eq!(
        layout["ciphertextOffset"].as_u64(),
        Some(CIPHERTEXT_OFFSET as u64)
    );
    assert_eq!(
        layout["minimumAcceptedBytes"].as_u64(),
        Some(MIN_PACKED_BYTES as u64)
    );
}

#[test]
fn crdt_update_vectors() {
    let vectors = vector_file("crdt-update");
    let cases = vectors["cases"].as_array().expect("cases");
    let error_cases = vectors["errorCases"].as_array().expect("errorCases");

    assert_eq!(
        vectors["meta"]["caseCount"].as_u64(),
        Some((cases.len() + error_cases.len()) as u64),
        "meta.caseCount must cover both arrays"
    );

    for case in cases {
        let name = str_field(case, "name");
        let input = &case["input"];
        let expected = &case["expected"];

        let note_id = str_field(input, "noteId");
        let update = hex_field(input, "updateHex");
        let vault_key = hex_field(input, "vaultKeyHex");
        let (public_key, secret_key) =
            sodium::sign_seed_keypair(&hex_field(input, "signingSeedHex")).expect("keypair");

        let material = CrdtMaterial {
            file_key: Zeroizing::new(hex_field(input, "fileKeyHex")),
            data_nonce: hex_field(input, "dataNonceHex"),
            key_nonce: hex_field(input, "keyNonceHex"),
        };

        let packed = crdt_envelope::pack(
            &CrdtRequest {
                note_id,
                update: &update,
                vault_key: &vault_key,
                signing_secret_key: &secret_key,
            },
            &material,
        )
        .unwrap_or_else(|error| panic!("{name}: pack failed: {error}"));

        // Byte for byte against the committed packet.
        assert_eq!(
            hex::encode(&packed),
            str_field(expected, "packedHex"),
            "{name}"
        );
        assert_eq!(
            packed.len() as u64,
            expected["packedBytes"].as_u64().expect("packedBytes"),
            "{name}"
        );

        // Every run of the header, so a failure names the field rather than
        // just reporting that a long hex string differs.
        let parts = &expected["decomposition"];
        assert_eq!(
            hex::encode(&packed[DATA_NONCE_OFFSET..DATA_NONCE_OFFSET + NONCE_BYTES]),
            str_field(parts, "dataNonceHex"),
            "{name}: dataNonce"
        );
        assert_eq!(
            hex::encode(&packed[KEY_NONCE_OFFSET..KEY_NONCE_OFFSET + NONCE_BYTES]),
            str_field(parts, "keyNonceHex"),
            "{name}: keyNonce"
        );
        assert_eq!(
            hex::encode(&packed[WRAPPED_KEY_OFFSET..WRAPPED_KEY_OFFSET + WRAPPED_KEY_BYTES]),
            str_field(parts, "wrappedKeyHex"),
            "{name}: wrappedKey"
        );
        assert_eq!(
            hex::encode(&packed[SIGNATURE_OFFSET..SIGNATURE_OFFSET + SIGNATURE_BYTES]),
            str_field(parts, "signatureHex"),
            "{name}: signature"
        );
        assert_eq!(
            hex::encode(&packed[CIPHERTEXT_OFFSET..]),
            str_field(parts, "ciphertextHex"),
            "{name}: ciphertext"
        );

        // §4.12's signed message, with the signature slot excised.
        assert_eq!(
            hex::encode(crdt_envelope::signed_message(note_id, &packed)),
            str_field(expected, "signedPayloadHex"),
            "{name}: signed message"
        );

        // And the read path returns exactly what went in.
        let round_tripped = crdt_envelope::unpack(&packed, note_id, &vault_key, &public_key)
            .unwrap_or_else(|error| panic!("{name}: unpack failed: {error}"));
        assert_eq!(
            hex::encode(&round_tripped),
            str_field(expected, "roundTripHex"),
            "{name}: round trip"
        );
        assert_eq!(round_tripped, update, "{name}: round trip is the input");
    }

    for case in error_cases {
        let name = str_field(case, "name");
        let note_id = str_field(case, "noteId");
        let vault_key = hex_field(&cases[0]["input"], "vaultKeyHex");
        let (public_key, _) =
            sodium::sign_seed_keypair(&hex_field(&cases[0]["input"], "signingSeedHex"))
                .expect("keypair");

        // The structurally-valid case carries a length, not a packet: 161
        // bytes passes the guard and is expected to fail later, at the
        // signature. `expectRejected: false` is about the *guard*, not about
        // the packet being acceptable.
        if case["expectRejected"].as_bool() == Some(false) {
            let length = case["packedBytes"].as_u64().expect("packedBytes") as usize;
            assert_eq!(length, MIN_PACKED_BYTES, "{name}");
            assert_eq!(
                crdt_envelope::unpack(&vec![0u8; length], note_id, &vault_key, &public_key),
                Err(EnvelopeError::SignatureInvalid),
                "{name}: past the guard, stopped by the signature"
            );
            continue;
        }

        let packed = hex_field(case, "packedHex");
        let error = crdt_envelope::unpack(&packed, note_id, &vault_key, &public_key)
            .expect_err(&format!("{name}: expected a rejection"));

        // `expectErrorContains` is the TypeScript writer's English message and
        // is deliberately NOT asserted here — a second implementation that
        // reproduced that phrasing would be pinning the message rather than
        // the behaviour. `expectErrorCode` is the portable half, and the
        // contracts verifier now requires every message-asserting case to
        // carry one.
        match str_field(case, "expectErrorCode") {
            "too-short" => assert!(
                error.to_string().contains("CRDT update too short"),
                "{name}: {error}"
            ),
            "signature-invalid" => assert_eq!(error, EnvelopeError::SignatureInvalid, "{name}"),
            other => panic!("{name}: unknown error code `{other}`"),
        }
    }
}
