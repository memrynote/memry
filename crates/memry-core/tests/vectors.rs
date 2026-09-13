//! The conformance vector tier, SC-001.
//!
//! One test function per committed class. A failure here is a **protocol
//! question** until proved otherwise: the committed JSON came out of a
//! production TypeScript path, so "the vector is wrong" is the last hypothesis
//! to reach for, not the first.

mod support;

use std::collections::BTreeMap;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use ciborium::value::Value;
use memry_core::api::errors::{CborError, CompressError, RecoveryError, StorageError};
use memry_core::crypto::{cbor, keys, recovery, sodium};
use memry_core::protocol::envelope::EnvelopeError;
use memry_core::protocol::{compress, envelope, types};
use memry_core::storage::migrations;
use memry_core::storage::repositories::{ApplyOutcome, InboundRecord, projectors, sync_items};
use serde_json::Value as Json;
use support::*;
use zeroize::Zeroizing;

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

/// `record-envelope.json` — chapter 04, the signed record envelope.
///
/// The file carries its intermediates on purpose: when a second implementation
/// fails the final signature, the useful question is which of the three stages
/// diverged, so the compression frame and the ciphertext size are asserted
/// before the envelope is.
#[test]
fn record_envelope_vectors() {
    let file = vector_file("record-envelope");
    let mut checked = 0;

    // Chapter 04 §4.14 and §4.10, asserted against the file's own meta: a
    // constant that moves under either side fails here rather than as a 400.
    let ceiling = &file["meta"]["sizeCeiling"];
    assert_eq!(
        ceiling["SYNC_ITEM_MAX_ENCRYPT_BYTES"].as_u64().unwrap(),
        envelope::SYNC_ITEM_MAX_ENCRYPT_BYTES as u64
    );
    assert_eq!(
        ceiling["SYNC_ITEM_ENCRYPT_OVERHEAD"].as_f64().unwrap(),
        envelope::SYNC_ITEM_ENCRYPT_OVERHEAD
    );
    assert_eq!(
        ceiling["NOTE_SYNC_MAX_BYTES"].as_u64().unwrap(),
        envelope::NOTE_SYNC_MAX_BYTES as u64
    );
    assert_eq!(
        file["meta"]["cryptoVersion"].as_u64().unwrap(),
        envelope::CRYPTO_VERSION
    );

    let vault_key = hex_field(&file["cases"][0]["input"], "vaultKeyHex");

    for case in file["cases"].as_array().unwrap() {
        check_record_envelope_case(case);
        checked += 1;
    }

    for case in file["tamperCases"].as_array().unwrap() {
        let name = str_field(case, "name");
        let item = envelope::from_json(&case["pushItem"]).unwrap();
        let signer = hex_field(case, "signerPublicKeyHex");

        assert_eq!(str_field(case, "expectFailure"), "signature");
        assert_eq!(
            envelope::verify(&item, &signer),
            Err(EnvelopeError::SignatureInvalid),
            "{name}"
        );
        // §4.12: the signature is checked before the file key is unwrapped, so
        // a tampered item never reaches the cipher at all.
        assert_eq!(
            envelope::decrypt(&item, &vault_key, &signer),
            Err(EnvelopeError::SignatureInvalid),
            "{name}"
        );
        checked += 1;
    }

    for case in file["sizeCeilingCases"].as_array().unwrap() {
        check_size_ceiling_case(case);
        checked += 1;
    }

    assert_eq!(checked, file["meta"]["caseCount"].as_u64().unwrap());
}

fn check_record_envelope_case(case: &Json) {
    let name = str_field(case, "name");
    let input = &case["input"];
    let expected = &case["expected"];

    let content = str_field(input, "contentUtf8").as_bytes().to_vec();
    // Stage one: the compression frame, which sits inside the ciphertext.
    assert_eq!(
        hex::encode(compress::compress(&content)),
        str_field(expected, "compressedHex"),
        "{name}"
    );

    let (public_key, secret_key) =
        sodium::sign_seed_keypair(&hex_field(input, "signingSeedHex")).unwrap();
    let vault_key = hex_field(input, "vaultKeyHex");
    let material = envelope::RecordMaterial {
        file_key: Zeroizing::new(hex_field(input, "fileKeyHex")),
        data_nonce: hex_field(input, "dataNonceHex"),
        key_nonce: hex_field(input, "keyNonceHex"),
    };

    let sealed = envelope::encrypt(
        &envelope::RecordRequest {
            id: str_field(input, "id"),
            item_type: str_field(input, "type"),
            operation: envelope::SyncOperation::from_wire(Some(str_field(input, "operation")))
                .unwrap(),
            content: &content,
            vault_key: &vault_key,
            signing_secret_key: secret_key.as_slice(),
            signer_device_id: str_field(&expected["pushItem"], "signerDeviceId"),
            clock: clock_field(input),
            state_vector: input["stateVector"].as_str().map(str::to_owned),
            deleted_at: input["deletedAt"].as_i64(),
        },
        &material,
    )
    .unwrap_or_else(|error| panic!("{name}: {error}"));

    // Stage two and three in one assertion: every base64 field and the
    // signature over them, including which optional keys are present at all.
    assert_eq!(
        envelope::to_json(&sealed.envelope),
        expected["pushItem"],
        "{name}"
    );
    assert_eq!(
        sealed.size_bytes,
        expected["sizeBytes"].as_u64().unwrap(),
        "{name}"
    );

    // The reader reproduces the writer's own struct from the wire object,
    // which is what makes the §4.9 operation default testable at all.
    assert_eq!(
        envelope::from_json(&expected["pushItem"]).unwrap(),
        sealed.envelope,
        "{name}"
    );

    // §4.6: the record push omits `stateVector` even though the general
    // PushItem shape and the signature payload both carry it.
    let push_body = envelope::to_record_push_json(&sealed.envelope);
    assert!(push_body.get("stateVector").is_none(), "{name}");
    if input["stateVector"].is_string() {
        assert!(
            expected["pushItem"].get("stateVector").is_some(),
            "{name}: the omission assertion above would otherwise be vacuous"
        );
    }

    assert_eq!(
        envelope::decrypt(&sealed.envelope, &vault_key, &public_key).unwrap(),
        str_field(expected, "roundTripUtf8").as_bytes(),
        "{name}"
    );

    check_dual_canonicalisation(&sealed.envelope, name);
}

/// Chapter 05 §5.9: the same four blob fields, canonicalised two different
/// ways, and a client may assume neither.
fn check_dual_canonicalisation(item: &memry_core::protocol::envelope::RecordEnvelope, name: &str) {
    // A: plain JSON key sort, which is the R2 object byte for byte.
    let blob = envelope::canonical_blob_json(item);
    let json_order = ["dataNonce", "encryptedData", "encryptedKey", "keyNonce"];
    let offsets: Vec<usize> = json_order
        .iter()
        .map(|key| {
            blob.find(&format!("\"{key}\":"))
                .unwrap_or_else(|| panic!("{name}: the blob has no `{key}`"))
        })
        .collect();
    let mut sorted = offsets.clone();
    sorted.sort_unstable();
    assert_eq!(
        offsets, sorted,
        "{name}: the four blob keys are not in JSON sort order"
    );
    // Parseable JSON, and the values really are the envelope's own.
    assert_eq!(
        serde_json::from_str::<Json>(&blob).unwrap()["encryptedData"],
        Json::String(item.encrypted_data.clone()),
        "{name}"
    );

    // B: length-first CBOR, a different order over the same four fields.
    let signed: Value = ciborium::from_reader(envelope::signing_bytes(item).unwrap().as_slice())
        .expect("the signed payload is valid CBOR");
    let cbor_order: Vec<String> = signed
        .as_map()
        .unwrap()
        .iter()
        .map(|(key, _)| key.as_text().unwrap().to_string())
        .filter(|key| json_order.contains(&key.as_str()))
        .collect();
    assert_eq!(
        cbor_order,
        ["keyNonce", "dataNonce", "encryptedKey", "encryptedData"],
        "{name}"
    );

    // `contentHash` is lowercase hex SHA-256 over A's bytes. No vector pins
    // it, so the negative control is what makes the assertion mean anything.
    let hash = envelope::content_hash(item);
    assert_eq!(hash.len(), 64, "{name}");
    assert!(
        hash.chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
    );
    let mut moved = item.clone();
    moved.data_nonce = format!("{}=", &item.data_nonce[..item.data_nonce.len() - 1]);
    assert_ne!(envelope::content_hash(&moved), hash, "{name}");
}

fn check_size_ceiling_case(case: &Json) {
    let name = str_field(case, "name");
    let bytes = case["contentBytes"].as_u64().unwrap() as usize;
    let result = envelope::check_size(bytes);

    if !case["expectThrows"].as_bool().unwrap() {
        assert!(result.is_ok(), "{name}");
        return;
    }

    assert_eq!(
        result,
        Err(EnvelopeError::ItemTooLarge {
            bytes: bytes as u64,
            max_bytes: envelope::NOTE_SYNC_MAX_BYTES as u64,
        }),
        "{name}"
    );
    assert_eq!(str_field(case, "expectErrorName"), "ItemTooLargeError");

    // §4.14: the check runs BEFORE any crypto. The key material here is
    // deliberately invalid, so a writer that sized after encrypting would
    // report a crypto failure instead and this assertion would catch it.
    let error = envelope::encrypt(
        &envelope::RecordRequest {
            id: "too-large",
            item_type: "note",
            operation: envelope::SyncOperation::Update,
            content: &vec![b'a'; bytes],
            vault_key: &[],
            signing_secret_key: &[],
            signer_device_id: "device-a",
            clock: None,
            state_vector: None,
            deleted_at: None,
        },
        &envelope::RecordMaterial {
            file_key: Zeroizing::new(Vec::new()),
            data_nonce: Vec::new(),
            key_nonce: Vec::new(),
        },
    )
    .expect_err(name);
    assert!(
        matches!(error, EnvelopeError::ItemTooLarge { .. }),
        "{name}"
    );
}

/// A vector's `clock`, which is either absent, `null`, or a map of ticks.
fn clock_field(input: &Json) -> Option<BTreeMap<String, u64>> {
    input["clock"].as_object().map(|ticks| {
        ticks
            .iter()
            .map(|(device, tick)| (device.clone(), tick.as_u64().unwrap()))
            .collect()
    })
}

/// `payload-schemas.json` — the declared type set only (T106).
///
/// The file's 52 payload cases exercise the per-type projectors, which are not
/// this module's: chapter 13 §13.2 requires them to read a preserved string
/// rather than to be the storage shape, and they land with the repositories.
/// What is assertable here is the half the negotiation owns — that the thirteen
/// names this client declares are exactly the thirteen the vector was generated
/// for, in the same order, and that every group in the file is one of them.
#[test]
fn payload_schemas_subscribed_types() {
    let file = vector_file("payload-schemas");

    let declared: Vec<&str> = file["meta"]["subscribedTypes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap())
        .collect();
    assert_eq!(declared, types::SUBSCRIBED_ITEM_TYPES);

    let declaration = types::Declaration::subscribed();
    assert_eq!(declaration.header_value(), declared.join(","));

    for group in file["groups"].as_array().unwrap() {
        let item_type = str_field(group, "type");
        assert_eq!(
            declaration.classify(item_type),
            types::ArrivingItemType::Subscribed,
            "{item_type}"
        );
    }

    // The negative control: a record type the server serves and this client
    // deliberately does not ask for is not silently acceptable.
    assert_eq!(
        declaration.classify("canvas"),
        types::ArrivingItemType::Undeclared
    );
}

/// `payload-schemas.json` — chapter 13, all 52 payload cases (T089, T104).
///
/// Every group is four cases and the four are one argument:
///
/// 1. **valid** pins the reader's field list against the payload's;
/// 2. **boundary** pins that absent and empty stay distinct across the round
///    trip, which is §13.4's "`undefined` keeps the local value, `null` is an
///    explicit clear";
/// 3. **unknown field** — the SC-014 case — pins that the key is gone from the
///    *parsed* view, because a closed schema strips it;
/// 4. **verbatim round trip** pins that the same key is still in the *stored
///    string*, byte for byte, after the whole apply-and-push path.
///
/// Cases 3 and 4 together are FR-033: the parse is allowed to lose the key
/// precisely because the parse is not the storage. An implementation that
/// deserialises into a struct and re-serialises passes 3 and fails 4, which is
/// desktop today (#2183), so case 4 runs against a real SQLite database rather
/// than against a function's return value.
#[test]
fn payload_schemas_vectors() {
    let file = vector_file("payload-schemas");
    let mut checked = 0;

    for group in file["groups"].as_array().unwrap() {
        let item_type = str_field(group, "type");
        for case in group["cases"].as_array().unwrap() {
            let name = str_field(case, "name");
            match case.get("storedPayloadJson").and_then(Json::as_str) {
                Some(stored) => check_verbatim_round_trip(
                    item_type,
                    name,
                    stored,
                    str_field(case, "expectedPushedPayloadJson"),
                ),
                None => check_payload_reader(item_type, name, case),
            }
            checked += 1;
        }
    }

    assert_eq!(
        checked,
        file["meta"]["caseCount"].as_u64().unwrap() as usize
    );
}

/// Cases 1 to 3: the reader over a copy (§13.2 rule 2).
fn check_payload_reader(item_type: &str, name: &str, case: &Json) {
    let payload = case["payload"]
        .as_object()
        .unwrap_or_else(|| panic!("{name}: `payload` is not an object"));

    let view = projectors::read(item_type, payload)
        .unwrap_or_else(|error| panic!("{name}: the payload must read: {error}"));

    let expected = case["expectedParsed"]
        .as_object()
        .unwrap_or_else(|| panic!("{name}: `expectedParsed` is not an object"));
    assert_eq!(&view, expected, "{name}");

    // The read view is what a projection column caches, so every key the
    // schema strips has to be absent from it — including a nested one, which
    // the vector spells as a dotted path.
    let as_value = Json::Object(view);
    for path in case
        .get("strippedByParse")
        .and_then(Json::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
    {
        let path = path.as_str().expect("a stripped path is a string");
        assert!(
            value_at(&as_value, path).is_none(),
            "{name}: `{path}` must not survive the parse"
        );
    }
}

/// Case 4: the whole apply-and-push path, against a real database.
///
/// Chapter 06 §6.5.2 P2 is in here too — `push_payload` rebuilds from the live
/// row rather than from anything frozen at enqueue — because the two
/// obligations share one implementation: there is exactly one copy of the
/// bytes, and it is the column.
fn check_verbatim_round_trip(item_type: &str, name: &str, stored: &str, expected_pushed: &str) {
    // 2026-04-16T00:00:00Z, the day the vectors' payloads are dated. A
    // `task_activity` case has to be applied inside its 90-day retention
    // window (§13.12) or it is refused as expired rather than stored.
    const NOW_MS: i64 = 1_776_297_600_000;

    let item_id = match item_type {
        "settings" => "synced_settings",
        "folder_config" => "Notes",
        "tag_definition" => "protocol",
        other => other,
    };

    let db = memry_core::storage::Db::open_in_memory().expect("an in-memory database");
    db.call_blocking(|conn| migrations::run(conn, migrations::DATA_MIGRATIONS))
        .expect("migrate");

    let record = InboundRecord {
        item_type: item_type.to_owned(),
        item_id: item_id.to_owned(),
        payload_json: stored.to_owned(),
        server_cursor: Some(1),
        signer_device_id: Some("device-a".to_owned()),
        updated_at: NOW_MS,
        deleted_at: None,
    };

    let pushed = db
        .call_blocking(|conn| {
            let outcome = sync_items::apply_remote(conn, &record, NOW_MS)?;
            assert_eq!(outcome, ApplyOutcome::Applied, "{name}");
            sync_items::push_payload(conn, item_type, item_id)?.ok_or(StorageError::Failed {
                what: "the stored payload vanished".to_owned(),
            })
        })
        .unwrap_or_else(|error| panic!("{name}: {error}"));

    assert_eq!(pushed, expected_pushed, "{name}");

    // The negative control the README asks for. Without it the assertion above
    // only proves that *something* came back: a client that pushed its parsed
    // view instead would still be storing a note, just one missing the key a
    // newer build wrote.
    let parsed: Json = serde_json::from_str(stored).expect("the vector's own JSON");
    let view = projectors::read(item_type, parsed.as_object().unwrap()).expect("it reads");
    assert_ne!(
        serde_json::to_string(&Json::Object(view)).unwrap(),
        expected_pushed,
        "{name}: re-serialising the parsed view must NOT reproduce the payload, \
         or this case proves nothing"
    );
}

/// Walks a dotted path such as `settings.experimental`.
fn value_at<'a>(value: &'a Json, path: &str) -> Option<&'a Json> {
    let mut cursor = value;
    for segment in path.split('.') {
        cursor = cursor.get(segment)?;
    }
    Some(cursor)
}
