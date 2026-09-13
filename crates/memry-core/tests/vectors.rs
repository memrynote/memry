//! The conformance vector tier, SC-001.
//!
//! One test function per committed class. A failure here is a **protocol
//! question** until proved otherwise: the committed JSON came out of a
//! production TypeScript path, so "the vector is wrong" is the last hypothesis
//! to reach for, not the first.

mod support;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use ciborium::value::Value;
use memry_core::api::errors::{CborError, CompressError, RecoveryError};
use memry_core::crypto::{cbor, keys, recovery, sodium};
use memry_core::protocol::compress;
use serde_json::Value as Json;
use support::*;

/// `crypto-vectors.json` — the frozen primitive set.
///
/// Frozen means byte-for-byte as committed: no change in this feature touches
/// it, and three suites consume it without any of them seeing a diff.
#[test]
fn crypto_vectors() {
    let file = vector_file("crypto-vectors");
    let mut checked = 0;

    for case in file["argon2id"].as_array().unwrap() {
        assert_eq!(str_field(case, "algorithm"), "ARGON2ID13");
        let derived = sodium::pwhash_argon2id(
            case["outLength"].as_u64().unwrap() as usize,
            str_field(case, "passwordUtf8").as_bytes(),
            &hex_field(case, "saltHex"),
            case["opsLimit"].as_u64().unwrap(),
            case["memLimit"].as_u64().unwrap() as usize,
        )
        .unwrap();
        assert_eq!(
            hex::encode(derived.as_slice()),
            str_field(case, "derivedHex"),
            "argon2id: {}",
            str_field(case, "description")
        );
        checked += 1;
    }

    for case in file["xchacha20poly1305Ietf"].as_array().unwrap() {
        let key = hex_field(case, "keyHex");
        let nonce = hex_field(case, "nonceHex");
        let ad = optional_hex_field(case, "adHex");
        let plain = plaintext(case);

        let ciphertext = sodium::aead_encrypt(&plain, ad.as_deref(), &nonce, &key).unwrap();
        assert_eq!(
            hex::encode(&ciphertext),
            str_field(case, "ciphertextHex"),
            "aead encrypt: {}",
            str_field(case, "description")
        );

        let round = sodium::aead_decrypt(&ciphertext, ad.as_deref(), &nonce, &key).unwrap();
        assert_eq!(round.as_slice(), plain.as_slice());

        // The negative control. Without it the positive assertion only proves
        // that the function returns something, not that it authenticates.
        let mut tampered = ciphertext.clone();
        tampered[0] ^= 0x01;
        assert!(sodium::aead_decrypt(&tampered, ad.as_deref(), &nonce, &key).is_err());
        checked += 1;
    }

    let ed = &file["ed25519"];
    let (public_key, secret_key) = sodium::sign_seed_keypair(&hex_field(ed, "seedHex")).unwrap();
    assert_eq!(hex::encode(&public_key), str_field(ed, "publicKeyHex"));
    assert_eq!(
        hex::encode(secret_key.as_slice()),
        str_field(ed, "secretKeyHex")
    );
    let message = str_field(ed, "messageUtf8").as_bytes();
    let signature = sodium::sign_detached(message, secret_key.as_slice()).unwrap();
    assert_eq!(
        hex::encode(&signature),
        str_field(ed, "detachedSignatureHex")
    );
    assert!(sodium::sign_verify_detached(
        &signature,
        message,
        &public_key
    ));
    assert!(!sodium::sign_verify_detached(
        &signature,
        b"other message",
        &public_key
    ));
    // Chapter 01 §1.5: the locally derived device id is 32 lowercase hex chars.
    assert_eq!(
        keys::local_device_id_hex(&public_key).unwrap(),
        str_field(ed, "deviceIdHex")
    );
    checked += 1;

    for case in file["kdfDeriveFromKey"].as_array().unwrap() {
        let ctx = str_field(case, "ctx").as_bytes();
        let row = keys::kdf_context(str_field(case, "contextName"))
            .expect("every vector row is in the chapter 01 §1.2 table");
        assert_eq!(
            row.ctx.as_slice(),
            ctx,
            "the ctx column must match the table"
        );
        assert_eq!(row.subkey_id, case["subkeyId"].as_u64().unwrap());

        let derived = sodium::kdf_derive_from_key(
            case["length"].as_u64().unwrap() as usize,
            row.subkey_id,
            row.ctx,
            &hex_field(case, "masterKeyHex"),
        )
        .unwrap();
        assert_eq!(
            hex::encode(derived.as_slice()),
            str_field(case, "derivedHex"),
            "kdf: {}",
            row.logical
        );
        checked += 1;
    }

    for case in file["generichash"].as_array().unwrap() {
        let message = match case.get("messageUtf8").and_then(Json::as_str) {
            Some(text) => text.as_bytes().to_vec(),
            None => hex_field(case, "messageHex"),
        };
        let key = optional_hex_field(case, "keyHex");
        let hash = sodium::generichash(
            case["outLength"].as_u64().unwrap() as usize,
            &message,
            key.as_deref(),
        )
        .unwrap();
        assert_eq!(
            hex::encode(hash),
            str_field(case, "hashHex"),
            "generichash: {}",
            str_field(case, "description")
        );
        checked += 1;
    }

    for case in file["auth"].as_array().unwrap() {
        let mac = sodium::auth(
            str_field(case, "messageUtf8").as_bytes(),
            &hex_field(case, "keyHex"),
        )
        .unwrap();
        assert_eq!(hex::encode(mac), str_field(case, "macHex"));
        checked += 1;
    }

    for case in file["scalarmult"]["base"].as_array().unwrap() {
        let public = sodium::scalarmult_base(&hex_field(case, "scalarHex")).unwrap();
        assert_eq!(hex::encode(public), str_field(case, "publicKeyHex"));
        checked += 1;
    }

    for case in file["scalarmult"]["shared"].as_array().unwrap() {
        let shared =
            sodium::scalarmult(&hex_field(case, "scalarHex"), &hex_field(case, "pointHex"))
                .unwrap();
        assert_eq!(
            hex::encode(shared.as_slice()),
            str_field(case, "sharedSecretHex")
        );
        checked += 1;
    }

    let box_pair = &file["boxKeypair"];
    assert_eq!(
        hex::encode(sodium::scalarmult_base(&hex_field(box_pair, "secretKeyHex")).unwrap()),
        str_field(box_pair, "publicKeyHex")
    );
    checked += 1;

    check_vault_unlock_flow(&file["vaultUnlockFlow"]);
    checked += 1;

    // The vectors README counts 21 primitive groups (2 + 2 + 1 + 7 + 3 + 1 + 2
    // + 2 + 1), correcting the design record's totals table, which was one
    // short. `vaultUnlockFlow` is the composite on top of them, so the number of
    // things this test walks is 22.
    assert_eq!(
        checked, 22,
        "every group in crypto-vectors.json must be exercised"
    );
}

/// The whole chain in one case: password to master key to vault key to verifier
/// to an unwrapped file key to a decrypted body.
fn check_vault_unlock_flow(flow: &Json) {
    let master_key = sodium::pwhash_argon2id(
        32,
        str_field(flow, "passwordUtf8").as_bytes(),
        &hex_field(flow, "kdfSaltHex"),
        flow["argon2"]["opsLimit"].as_u64().unwrap(),
        flow["argon2"]["memLimit"].as_u64().unwrap() as usize,
    )
    .unwrap();
    assert_eq!(
        hex::encode(master_key.as_slice()),
        str_field(flow, "masterKeyHex")
    );

    assert_eq!(
        keys::account_key_verifier(master_key.as_slice()).unwrap(),
        str_field(flow, "keyVerifierBase64")
    );

    let vault_key = keys::derive_vault_key(master_key.as_slice()).unwrap();
    assert_eq!(
        hex::encode(vault_key.as_slice()),
        str_field(flow, "vaultKeyHex")
    );

    // Chapter 04 §4.4: the file key is wrapped under the vault key with its own
    // nonce and no associated data, so the wrapped length is exactly 48.
    let wrapped = sodium::aead_encrypt(
        &hex_field(flow, "fileKeyHex"),
        None,
        &hex_field(flow, "keyNonceHex"),
        vault_key.as_slice(),
    )
    .unwrap();
    assert_eq!(wrapped.len(), 48);
    assert_eq!(hex::encode(&wrapped), str_field(flow, "encryptedKeyHex"));

    let file_key = sodium::aead_decrypt(
        &hex_field(flow, "encryptedKeyHex"),
        None,
        &hex_field(flow, "keyNonceHex"),
        vault_key.as_slice(),
    )
    .unwrap();
    assert_eq!(
        hex::encode(file_key.as_slice()),
        str_field(flow, "fileKeyHex")
    );

    let body = sodium::aead_decrypt(
        &hex_field(flow, "encryptedDataHex"),
        None,
        &hex_field(flow, "dataNonceHex"),
        file_key.as_slice(),
    )
    .unwrap();
    assert_eq!(
        body.as_slice(),
        str_field(flow, "plaintextMarkdownUtf8").as_bytes()
    );
}

/// `bip39-unlock.json` — chapter 01's phrase path end to end.
#[test]
fn bip39_unlock_vectors() {
    let file = vector_file("bip39-unlock");
    let mut checked = 0;

    for case in file["bip39"].as_array().unwrap() {
        let mnemonic = str_field(case, "mnemonic");

        if let Some(canonical) = case.get("canonicalised").and_then(Json::as_str) {
            // The five normalisation steps of §1.3, and that they are the
            // identity on a phrase that was already canonical.
            assert_eq!(recovery::normalize_phrase(mnemonic), canonical);
            assert_eq!(recovery::normalize_phrase(canonical), canonical);
            assert!(recovery::validate_phrase(mnemonic).is_ok());
            assert_eq!(
                hex::encode(recovery::phrase_to_seed(mnemonic).unwrap().as_slice()),
                str_field(case, "expectedSeedHexAfterCanonicalisation")
            );
            checked += 1;
            continue;
        }

        let word_count = case.get("wordCount").and_then(Json::as_u64);
        let result = recovery::validate_phrase(mnemonic);

        match (case["expectedValid"].as_bool(), word_count) {
            // A 12-word phrase is valid BIP-39 and MUST still be rejected:
            // accepting it silently halves the entropy.
            (Some(true), Some(12)) => {
                assert_eq!(
                    result,
                    Err(RecoveryError::WrongWordCount { actual: 12 }),
                    "a 12-word phrase must be refused loudly"
                );
            }
            (Some(true), _) => {
                assert!(result.is_ok(), "{}: {result:?}", str_field(case, "name"));
                assert_eq!(
                    hex::encode(recovery::phrase_to_seed(mnemonic).unwrap().as_slice()),
                    str_field(case, "expectedSeedHex")
                );
            }
            (Some(false), _) => {
                // Validation gates derivation: no seed may exist for this input.
                assert_eq!(result, Err(RecoveryError::BadChecksum));
                assert!(recovery::phrase_to_seed(mnemonic).is_err());
            }
            _ => panic!("case has no expectedValid: {case}"),
        }
        checked += 1;
    }

    for case in file["verifiers"].as_array().unwrap() {
        check_verifier_case(case);
        checked += 1;
    }

    assert_eq!(
        checked,
        file["meta"]["caseCount"].as_u64().unwrap(),
        "every case the file declares must be exercised"
    );
}

fn check_verifier_case(case: &Json) {
    let name = str_field(case, "name");

    if let Some(mnemonic) = case.get("mnemonic").and_then(Json::as_str) {
        let seed = recovery::phrase_to_seed(mnemonic).unwrap();
        if let Some(expected) = case.get("expectedSeedHex").and_then(Json::as_str) {
            assert_eq!(hex::encode(seed.as_slice()), expected);
        }
        let master_key =
            keys::derive_master_key(seed.as_slice(), &hex_field(case, "kdfSaltHex")).unwrap();
        if let Some(expected) = case.get("expectedMasterKeyHex").and_then(Json::as_str) {
            assert_eq!(hex::encode(master_key.as_slice()), expected);
        }
        if let Some(expected) = case.get("expectedVaultKeyHex").and_then(Json::as_str) {
            let vault_key = keys::derive_vault_key(master_key.as_slice()).unwrap();
            assert_eq!(hex::encode(vault_key.as_slice()), expected);
        }
        let verifier = keys::account_key_verifier(master_key.as_slice()).unwrap();
        assert_eq!(
            verifier,
            str_field(case, "expectedAccountKeyVerifierB64"),
            "{name}"
        );
        if let Some(server) = case.get("serverVerifierB64").and_then(Json::as_str) {
            // FR-027's failure path: a valid phrase for the wrong account.
            assert_eq!(
                keys::account_key_verifier_matches(&verifier, server),
                case["expectedMatch"].as_bool().unwrap()
            );
        }
        return;
    }

    if let Some(master_key_hex) = case.get("masterKeyHex").and_then(Json::as_str) {
        let master_key = hex::decode(master_key_hex).unwrap();
        let verifier = keys::account_key_verifier(&master_key).unwrap();
        assert_eq!(verifier, str_field(case, "expectedB64"), "{name}");
        // §1.4.1: the comparison is over the base64 STRINGS. Two distinct
        // spellings that decode to the same bytes must NOT compare equal, which
        // is the only thing separating this from a decoded-bytes comparison.
        let unpadded = verifier.trim_end_matches('=');
        assert_ne!(unpadded, verifier);
        assert!(!keys::account_key_verifier_matches(&verifier, unpadded));
        assert_eq!(
            base64::engine::general_purpose::STANDARD_NO_PAD
                .decode(unpadded)
                .unwrap(),
            BASE64_STANDARD.decode(&verifier).unwrap(),
            "the two spellings really do decode alike, so the assertion above is not vacuous"
        );
        return;
    }

    if let Some(vault_key_hex) = case.get("vaultKeyHex").and_then(Json::as_str) {
        let vault_key = hex::decode(vault_key_hex).unwrap();
        let vault_id = str_field(case, "vaultId");
        assert_eq!(
            format!("{}{vault_id}", keys::VAULT_KEY_VERIFIER_PREFIX),
            str_field(case, "messageUtf8")
        );
        assert_eq!(
            keys::local_vault_key_verifier(&vault_key, vault_id).unwrap(),
            str_field(case, "expectedB64"),
            "{name}"
        );
        return;
    }

    if let Some(public_key_hex) = case.get("ed25519PublicKeyHex").and_then(Json::as_str) {
        assert_eq!(
            keys::local_device_id_hex(&hex::decode(public_key_hex).unwrap()).unwrap(),
            str_field(case, "expectedDeviceIdHex"),
            "{name}"
        );
        return;
    }

    panic!("unrecognised verifier case shape: {case}");
}

/// `cbor-canonical.json` — chapter 04 §4.7.
#[test]
fn cbor_canonical_vectors() {
    let file = vector_file("cbor-canonical");
    let mut checked = 0;

    for case in file["cases"].as_array().unwrap() {
        let order: Vec<&str> = case["fieldOrder"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();

        // Where the vector names one of the chapter's allowlists, the constant
        // in the crate must be the same list. A vector that agreed with itself
        // but not with `field_order::SYNC_ITEM` would pass while the production
        // path encoded under a different set.
        if let Some(named) = cbor::field_order::by_name(str_field(case, "fieldOrderName")) {
            assert_eq!(named, order.as_slice(), "{}", str_field(case, "name"));
        }

        let input: cbor::CanonicalMap = case["input"]
            .as_object()
            .unwrap()
            .iter()
            .filter_map(|(key, value)| json_to_cbor(value).map(|v| (key.clone(), v)))
            .collect();

        let encoded = cbor::encode(&order, &input)
            .unwrap_or_else(|error| panic!("{}: {error}", str_field(case, "name")));
        assert_eq!(
            hex::encode(&encoded),
            str_field(case, "expectedHex"),
            "{}",
            str_field(case, "name")
        );

        // The encoded key order is an independent assertion, not a restatement
        // of the bytes: it fails with a readable diff when the sort is wrong,
        // where a hex mismatch only says "different".
        let decoded: Value = ciborium::from_reader(encoded.as_slice()).unwrap();
        let actual_order: Vec<String> = decoded
            .as_map()
            .unwrap()
            .iter()
            .map(|(key, _)| key.as_text().unwrap().to_string())
            .collect();
        let expected_order: Vec<String> = case["expectedDecodedKeyOrder"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect();
        assert_eq!(actual_order, expected_order, "{}", str_field(case, "name"));
        checked += 1;
    }

    for case in file["rejectCases"].as_array().unwrap() {
        let order = cbor::field_order::by_name(str_field(case, "fieldOrderName")).unwrap();
        let input: cbor::CanonicalMap = case["input"]
            .as_object()
            .unwrap()
            .iter()
            .filter_map(|(key, value)| json_to_cbor(value).map(|v| (key.clone(), v)))
            .collect();

        // A hard throw, never a silent exclusion: a quietly dropped field
        // produces a signature over a field set the sender never agreed to.
        match cbor::encode(order, &input) {
            Err(CborError::FieldNotInOrdering { .. }) => {}
            other => panic!(
                "{}: expected a rejection, got {other:?}",
                str_field(case, "name")
            ),
        }
        let rendered = cbor::encode(order, &input).unwrap_err().to_string();
        assert!(
            rendered.contains(str_field(case, "expectErrorContains")),
            "message was {rendered}"
        );
        checked += 1;
    }

    assert_eq!(checked, file["meta"]["caseCount"].as_u64().unwrap());
}

/// `compression.json` — chapter 04 §4.1.
#[test]
fn compression_vectors() {
    let file = vector_file("compression");
    let mut checked = 0;

    for case in file["cases"].as_array().unwrap() {
        let input = hex_field(case, "inputHex");
        assert_eq!(input.len() as u64, case["inputBytes"].as_u64().unwrap());

        let framed = compress::compress(&input);
        assert_eq!(
            hex::encode(&framed),
            str_field(case, "expectedFrameHex"),
            "{}",
            str_field(case, "name")
        );

        if let Some(flag) = case["expectedFlag"].as_u64() {
            assert_eq!(framed[0] as u64, flag, "{}", str_field(case, "name"));
            // Chapter 04 §4.1: a zlib frame is RFC 1950, beginning `78 9c` at
            // the default level. The gzip magic `1f 8b 08` is a different
            // format and produces a client that cannot read any note body.
            if flag == u64::from(compress::FLAG_ZLIB) {
                assert_eq!(&framed[1..3], &[0x78, 0x9c]);
            }
        }

        assert_eq!(
            hex::encode(compress::decompress(&framed).unwrap()),
            str_field(case, "expectedInflatedHex"),
            "{}",
            str_field(case, "name")
        );
        checked += 1;
    }

    for case in file["readerCases"].as_array().unwrap() {
        // Any flag other than 0x01 is stored. There is no unknown-flag
        // rejection, so a reader that added one would refuse valid frames.
        assert_eq!(
            hex::encode(compress::decompress(&hex_field(case, "frameHex")).unwrap()),
            str_field(case, "expectedInflatedHex"),
            "{}",
            str_field(case, "name")
        );
        checked += 1;
    }

    for case in file["errorCases"].as_array().unwrap() {
        let error =
            compress::decompress(&hex_field(case, "frameHex")).expect_err(str_field(case, "name"));
        assert!(
            error
                .to_string()
                .contains(str_field(case, "expectErrorContains")),
            "{}: message was {error}",
            str_field(case, "name")
        );
        // The truncation case is the one that must never degrade to an empty
        // buffer, because the applier writes an empty body as a content wipe.
        if str_field(case, "name").contains("truncated") {
            assert_eq!(error, CompressError::IncompleteDeflateStream);
        }
        checked += 1;
    }

    assert_eq!(checked, file["meta"]["caseCount"].as_u64().unwrap());
}
