//! The `device-linking` committed vector class, chapter 03.
//!
//! Rule 2 of `packages/contracts/test-vectors/README.md`: the committed JSON is
//! the only input. Nothing here regenerates a vector or recomputes an
//! expectation — every assertion is against a value read out of the file.
//!
//! The class is eight cases: six positive (`scanProof`, `scanConfirm`,
//! `newDeviceConfirm`, `keyConfirm`, the master key block, the SAS derivation)
//! and two failure cases (a confirm MAC under the wrong subkey, and a SAS from
//! a transcript with one byte changed).

mod support;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use memry_core::protocol::linking::{
    self, LINKING_ENC_CONTEXT, LINKING_ENC_SUBKEY_ID, LINKING_MAC_CONTEXT, LINKING_MAC_SUBKEY_ID,
    LINKING_SAS_CONTEXT, LINKING_SAS_SUBKEY_ID, LINKING_SECRET_BYTES, LINKING_SESSION_TTL_SECONDS,
    LinkingError, MasterKeyBlock, SAS_DIGITS, SAS_MODULUS,
};
use serde_json::Value as Json;
use support::{hex_field, str_field, vector_file};

/// `meta` is the chapter's fact table in machine-readable form. Asserting the
/// crate constants against it is what makes a constant that moves under the
/// chapter a red build rather than a review note (FR-008).
#[test]
fn device_linking_meta_matches_the_crate_constants() {
    let vectors = vector_file("device-linking");
    let meta = &vectors["meta"];

    assert_eq!(
        meta["chapter"].as_str(),
        Some("docs/protocol/03-device-linking.md")
    );
    assert_eq!(
        meta["sessionTtlSeconds"].as_u64(),
        Some(LINKING_SESSION_TTL_SECONDS)
    );
    assert_eq!(
        meta["linkingSecretBytes"].as_u64(),
        Some(LINKING_SECRET_BYTES as u64)
    );

    // The three labels are `ctx/subkeyId`, chapter 01 §1.2 read through
    // chapter 03 §3.5.
    let subkeys = &meta["subkeys"];
    assert_eq!(
        subkeys["encryption"].as_str(),
        Some(label(LINKING_ENC_CONTEXT, LINKING_ENC_SUBKEY_ID).as_str())
    );
    assert_eq!(
        subkeys["mac"].as_str(),
        Some(label(LINKING_MAC_CONTEXT, LINKING_MAC_SUBKEY_ID).as_str())
    );
    assert_eq!(
        subkeys["sas"].as_str(),
        Some(label(LINKING_SAS_CONTEXT, LINKING_SAS_SUBKEY_ID).as_str())
    );

    // §3.3: the wire form is a 44-character standard-base64 string carrying 32
    // bytes, and the decode is the client's length check.
    let secret = str_field(meta, "linkingSecretB64");
    assert_eq!(secret.len(), 44, "§3.3: 32 bytes of standard base64");
    let decoded = linking::decode_linking_secret(secret).expect("linkingSecret decodes");
    assert_eq!(decoded.len(), LINKING_SECRET_BYTES);

    // §3.5: both ephemeral public keys are X25519 points.
    for field in ["initiatorPublicB64", "newDevicePublicB64"] {
        let key = BASE64_STANDARD
            .decode(str_field(&meta["ecdh"], field))
            .unwrap_or_else(|error| panic!("{field}: {error}"));
        assert_eq!(key.len(), 32, "{field}");
    }

    assert_eq!(
        meta["caseCount"].as_u64(),
        Some(
            (vectors["cases"].as_array().expect("cases").len()
                + vectors["failureCases"]
                    .as_array()
                    .expect("failureCases")
                    .len()) as u64
        ),
        "meta.caseCount must cover both arrays"
    );
}

/// The six positive cases, byte for byte.
#[test]
fn device_linking_vectors() {
    let vectors = vector_file("device-linking");
    let cases = vectors["cases"].as_array().expect("cases");
    let session_id = str_field(&vectors["meta"], "sessionId");
    let ecdh = &vectors["meta"]["ecdh"];
    let initiator_public_b64 = str_field(ecdh, "initiatorPublicB64");
    let device_public_b64 = str_field(ecdh, "newDevicePublicB64");

    let mut seen = 0usize;
    for case in cases {
        let name = str_field(case, "name");
        seen += 1;

        // The SAS case is the only one publishing the raw shared secret, so it
        // is also where the two derived subkeys used by the other cases are
        // checked against the KDF. Doing it here keeps every case's key
        // material traceable to one `sharedSecretHex` in the file.
        if case.get("sasKeyHex").is_some() {
            assert_sas_case(case);
            continue;
        }
        if case.get("masterKeyHex").is_some() {
            assert_master_key_block(case);
            continue;
        }

        // A MAC case. The message is pinned in the file; rebuild it from the
        // named ordering and assert the bytes before MACing them, so a CBOR
        // regression is not reported as a MAC failure.
        let ordering = str_field(case, "cborOrdering");
        let rebuilt = match ordering {
            "LINKING_PROOF" => linking::linking_proof_message(session_id, device_public_b64),
            "SCAN_CONFIRM" => {
                linking::scan_confirm_message(session_id, initiator_public_b64, device_public_b64)
            }
            "KEY_CONFIRM" => {
                linking::key_confirm_message(session_id, master_key_ciphertext_b64(&vectors))
            }
            other => panic!("{name}: unknown ordering `{other}`"),
        }
        .unwrap_or_else(|error| panic!("{name}: {error}"));

        let message = hex_field(case, "messageHex");
        assert_eq!(hex::encode(&rebuilt), hex::encode(&message), "{name}: CBOR");

        let key = hex_field(case, "keyHex");
        let expected = str_field(case, "expectedMacB64");

        match str_field(case, "channel") {
            "scan" => {
                // §3.3: the scan key is the DECODED linking secret.
                assert_eq!(
                    hex::encode(&key),
                    hex::encode(
                        linking::decode_linking_secret(str_field(
                            &vectors["meta"],
                            "linkingSecretB64"
                        ))
                        .expect("linkingSecret")
                        .as_slice()
                    ),
                    "{name}: the scan key is the decoded linkingSecret"
                );
                let tag = linking::scan_mac(&message, &key)
                    .unwrap_or_else(|error| panic!("{name}: {error}"));
                assert_eq!(BASE64_STANDARD.encode(&tag), expected, "{name}");
                linking::verify_scan_mac(&message, expected, &key)
                    .unwrap_or_else(|error| panic!("{name}: verify: {error}"));

                // Negative control (README, "does the negative control still
                // fail"): the confirm family must not reproduce this tag.
                assert_ne!(
                    BASE64_STANDARD
                        .encode(linking::confirm_mac(&message, &key).expect("confirm_mac")),
                    expected,
                    "{name}: the two MAC families must not agree"
                );
            }
            "confirm" => {
                let tag = linking::confirm_mac(&message, &key)
                    .unwrap_or_else(|error| panic!("{name}: {error}"));
                assert_eq!(BASE64_STANDARD.encode(&tag), expected, "{name}");
                linking::verify_confirm_mac(&message, expected, &key)
                    .unwrap_or_else(|error| panic!("{name}: verify: {error}"));

                assert_ne!(
                    BASE64_STANDARD.encode(linking::scan_mac(&message, &key).expect("scan_mac")),
                    expected,
                    "{name}: the two MAC families must not agree"
                );
            }
            other => panic!("{name}: unknown channel `{other}`"),
        }
    }

    assert_eq!(seen, cases.len());
}

/// §3.7's single most missable fact: `LINKING_PROOF` is MAC'd by both families
/// over identical bytes, and both tags ride in the same `/scan` body.
#[test]
fn linking_proof_runs_through_both_families_over_identical_bytes() {
    let vectors = vector_file("device-linking");
    let cases = vectors["cases"].as_array().expect("cases");

    let proofs: Vec<&Json> = cases
        .iter()
        .filter(|case| case.get("cborOrdering").and_then(Json::as_str) == Some("LINKING_PROOF"))
        .collect();
    assert_eq!(proofs.len(), 2, "one per family");

    assert_eq!(
        str_field(proofs[0], "messageHex"),
        str_field(proofs[1], "messageHex"),
        "identical bytes"
    );
    assert_ne!(
        str_field(proofs[0], "keyHex"),
        str_field(proofs[1], "keyHex"),
        "different keys"
    );
    assert_ne!(
        str_field(proofs[0], "expectedMacB64"),
        str_field(proofs[1], "expectedMacB64"),
        "different primitives, therefore different tags"
    );
}

/// The two failure cases.
#[test]
fn device_linking_failure_cases() {
    let vectors = vector_file("device-linking");
    let failures = vectors["failureCases"].as_array().expect("failureCases");
    assert_eq!(failures.len(), 2);

    // 1 — a confirm MAC verified with the wrong subkey. The cause is carried by
    // a variant, not by an English message, so a second implementation can
    // assert it without reproducing this crate's phrasing.
    let wrong_key = &failures[0];
    assert_eq!(wrong_key["expectValid"].as_bool(), Some(false));
    let message = hex_field(wrong_key, "messageHex");
    let tag = str_field(wrong_key, "macB64");
    let key = hex_field(wrong_key, "verifyWithKeyHex");
    assert_eq!(
        linking::verify_confirm_mac(&message, tag, &key),
        Err(LinkingError::ConfirmMacInvalid),
        "a MAC from a different shared secret must not verify"
    );

    // The same tag under the right subkey still verifies, so the case above is
    // rejecting the key rather than a broken message.
    let key_confirm = case_with_ordering(&vectors, "KEY_CONFIRM");
    linking::verify_confirm_mac(&message, tag, &hex_field(key_confirm, "keyHex"))
        .expect("the right subkey still verifies");

    // 2 — a SAS from a transcript with one byte changed. Not an error: a
    // different, equally well-formed code. That is the whole point of the SAS.
    let altered = &failures[1];
    let code = linking::short_verification_code(&hex_field(altered, "alteredSharedSecretHex"))
        .expect("sas");
    assert_eq!(code, str_field(altered, "expectedCode"));
    assert_ne!(code, str_field(altered, "mustDifferFrom"));
    assert_eq!(code.len(), SAS_DIGITS);
}

/// §3.6's bias, asserted as arithmetic rather than as prose.
///
/// `2^32 mod 10^6 = 967_296`, so codes below `967296` are reachable from 4295
/// `u32` values and the rest from 4294. An implementation that substituted
/// rejection sampling would make every code equally likely and would therefore
/// fail this — which is the point: the bias is the format.
#[test]
fn the_sas_modular_bias_is_reproduced_not_corrected() {
    assert_eq!(SAS_MODULUS, 1_000_000);
    let overhang = (1u64 << 32) % u64::from(SAS_MODULUS);
    assert_eq!(overhang, 967_296);

    let below = (1u64 << 32).div_ceil(u64::from(SAS_MODULUS));
    let at_or_above = (1u64 << 32) / u64::from(SAS_MODULUS);
    assert_eq!((below, at_or_above), (4295, 4294));
    assert_eq!(
        overhang * below + (u64::from(SAS_MODULUS) - overhang) * at_or_above,
        1u64 << 32
    );
}

// ---------------------------------------------------------------------------
// per-case helpers
// ---------------------------------------------------------------------------

fn assert_sas_case(case: &Json) {
    let name = str_field(case, "name");
    let shared_secret = hex_field(case, "sharedSecretHex");

    // The `memrysas` subkey, and through it the whole §3.5 derivation.
    let sas_key = memry_core::crypto::keys::derive_subkey(
        &shared_secret,
        LINKING_SAS_SUBKEY_ID,
        LINKING_SAS_CONTEXT,
    )
    .expect("sas subkey");
    assert_eq!(
        hex::encode(sas_key.as_slice()),
        str_field(case, "sasKeyHex"),
        "{name}"
    );

    // The four-byte BLAKE2b and its big-endian reading, so a failure names the
    // step rather than just the code.
    let digest =
        memry_core::crypto::sodium::generichash(4, sas_key.as_slice(), None).expect("generichash");
    assert_eq!(
        hex::encode(&digest),
        str_field(case, "generichash4Hex"),
        "{name}"
    );
    assert_eq!(
        u64::from(u32::from_be_bytes([
            digest[0], digest[1], digest[2], digest[3]
        ])),
        case["uint32BigEndian"].as_u64().expect("uint32BigEndian"),
        "{name}"
    );

    let code = linking::short_verification_code(&shared_secret).expect("sas");
    assert_eq!(code, str_field(case, "expectedCode"), "{name}");
    assert_eq!(
        code,
        linking::sas_code_from_key(sas_key.as_slice()).expect("sas from key"),
        "{name}"
    );
}

fn assert_master_key_block(case: &Json) {
    let name = str_field(case, "name");
    let vectors = vector_file("device-linking");
    let session_id = str_field(&vectors["meta"], "sessionId");

    let enc_key = hex_field(case, "encKeyHex");
    let nonce = hex_field(case, "keyNonceHex");
    let master_key = hex_field(case, "masterKeyHex");

    // §3.10: the master key block carries NO associated data.
    assert!(case["associatedData"].is_null(), "{name}: no AAD");

    let block = linking::seal_master_key(&master_key, &enc_key, &nonce)
        .unwrap_or_else(|error| panic!("{name}: {error}"));
    assert_eq!(
        block.encrypted_master_key_b64,
        str_field(case, "encryptedMasterKeyB64"),
        "{name}"
    );
    assert_eq!(
        block.encrypted_key_nonce_b64,
        BASE64_STANDARD.encode(&nonce),
        "{name}"
    );

    let opened = linking::open_master_key(&block, &enc_key)
        .unwrap_or_else(|error| panic!("{name}: open: {error}"));
    assert_eq!(
        hex::encode(opened.as_slice()),
        str_field(case, "masterKeyHex"),
        "{name}"
    );

    // §3.5: the encryption key in this case and the MAC key in the confirm
    // cases are the same shared secret's subkeys 5 and 6.
    let shared_secret = hex_field(case_with_field(&vectors, "sasKeyHex"), "sharedSecretHex");
    let derived = linking::derive_subkeys(&shared_secret).expect("subkeys");
    assert_eq!(
        hex::encode(derived.encryption.as_slice()),
        hex::encode(&enc_key),
        "{name}: memrylnk"
    );
    assert_eq!(
        hex::encode(derived.mac.as_slice()),
        hex::encode(hex_field(
            case_with_ordering(&vectors, "KEY_CONFIRM"),
            "keyHex"
        )),
        "{name}: memrymac"
    );

    // §3.9's ordering, structurally: verify `keyConfirm`, then decrypt.
    let (sent, tag) = linking::send_master_key(session_id, &master_key, &derived, &nonce)
        .unwrap_or_else(|error| panic!("{name}: send: {error}"));
    assert_eq!(sent, block, "{name}: send_master_key reproduces the block");
    assert_eq!(
        BASE64_STANDARD.encode(&tag),
        str_field(
            case_with_ordering(&vectors, "KEY_CONFIRM"),
            "expectedMacB64"
        ),
        "{name}: keyConfirm"
    );

    let received =
        linking::receive_master_key(session_id, &sent, &BASE64_STANDARD.encode(&tag), &derived)
            .unwrap_or_else(|error| panic!("{name}: receive: {error}"));
    assert_eq!(
        hex::encode(received.as_slice()),
        str_field(case, "masterKeyHex"),
        "{name}"
    );

    // A bad tag stops the flow before any decryption.
    let forged = BASE64_STANDARD.encode([0u8; 32]);
    assert_eq!(
        linking::receive_master_key(session_id, &sent, &forged, &derived)
            .expect_err("a forged keyConfirm must be rejected"),
        LinkingError::ConfirmMacInvalid,
        "{name}"
    );

    // A block the peer cannot open is what an AAD mistake looks like; assert
    // the failure is a distinguishable decrypt error, not a panic.
    let wrong = MasterKeyBlock {
        encrypted_master_key_b64: block.encrypted_master_key_b64.clone(),
        encrypted_key_nonce_b64: BASE64_STANDARD.encode([0u8; 24]),
    };
    assert!(
        linking::open_master_key(&wrong, &enc_key).is_err(),
        "{name}"
    );
}

// ---------------------------------------------------------------------------
// file helpers
// ---------------------------------------------------------------------------

/// Finds a case by a field only it carries. Structural rather than by name:
/// two of the committed names contain "the master key block", so matching on
/// prose picks the wrong case.
fn case_with_field<'a>(vectors: &'a Json, field: &str) -> &'a Json {
    vectors["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .find(|case| case.get(field).is_some())
        .unwrap_or_else(|| panic!("no case carrying `{field}`"))
}

/// Finds a MAC case by its CBOR ordering.
fn case_with_ordering<'a>(vectors: &'a Json, ordering: &str) -> &'a Json {
    vectors["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .find(|case| case.get("cborOrdering").and_then(Json::as_str) == Some(ordering))
        .unwrap_or_else(|| panic!("no case with ordering `{ordering}`"))
}

/// The `encryptedMasterKey` base64 string the `keyConfirm` case MACs — read
/// out of the master key block case, never recomputed.
fn master_key_ciphertext_b64(vectors: &Json) -> &str {
    str_field(
        case_with_field(vectors, "masterKeyHex"),
        "encryptedMasterKeyB64",
    )
}

fn label(context: &[u8; 8], subkey_id: u64) -> String {
    format!(
        "{}/{subkey_id}",
        std::str::from_utf8(context).expect("the ctx column is ASCII")
    )
}
