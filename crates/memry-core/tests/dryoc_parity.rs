//! A second, independent Rust implementation over the same vectors (research R3).
//!
//! `crates/memry-core` reaches libsodium through `libsodium-sys-stable`, which
//! compiles libsodium from source. A build quirk there — a misdetected CPU
//! feature, a patched constant, a stale vendored tree — would produce a library
//! that is self-consistent and wrong, and `tests/vectors.rs` would pass because
//! both sides of every assertion came from the same broken build.
//!
//! `dryoc` is a pure-Rust reimplementation with no shared code and no shared
//! build system. Running the primitive vectors through it a second time is what
//! makes the first run mean something.

mod support;

use dryoc::classic::crypto_aead_xchacha20poly1305_ietf::{
    crypto_aead_xchacha20poly1305_ietf_decrypt, crypto_aead_xchacha20poly1305_ietf_encrypt,
};
use dryoc::classic::crypto_auth::crypto_auth;
use dryoc::classic::crypto_core::{crypto_scalarmult, crypto_scalarmult_base};
use dryoc::classic::crypto_generichash::crypto_generichash;
use dryoc::classic::crypto_kdf::crypto_kdf_derive_from_key;
use dryoc::classic::crypto_pwhash::{PasswordHashAlgorithm, crypto_pwhash};
use dryoc::classic::crypto_sign::{crypto_sign_detached, crypto_sign_seed_keypair};
use serde_json::Value as Json;
use support::*;

fn fixed<const N: usize>(bytes: &[u8], what: &str) -> [u8; N] {
    bytes
        .try_into()
        .unwrap_or_else(|_| panic!("{what} must be {N} bytes, got {}", bytes.len()))
}

#[test]
fn argon2id_matches_dryoc() {
    for case in vector_file("crypto-vectors")["argon2id"]
        .as_array()
        .unwrap()
    {
        let mut out = vec![0u8; case["outLength"].as_u64().unwrap() as usize];
        crypto_pwhash(
            &mut out,
            str_field(case, "passwordUtf8").as_bytes(),
            &hex_field(case, "saltHex"),
            case["opsLimit"].as_u64().unwrap(),
            case["memLimit"].as_u64().unwrap() as usize,
            PasswordHashAlgorithm::Argon2id13,
        )
        .unwrap();
        assert_eq!(
            hex::encode(out),
            str_field(case, "derivedHex"),
            "argon2id: {}",
            str_field(case, "description")
        );
    }
}

#[test]
fn aead_matches_dryoc() {
    for case in vector_file("crypto-vectors")["xchacha20poly1305Ietf"]
        .as_array()
        .unwrap()
    {
        let key: [u8; 32] = fixed(&hex_field(case, "keyHex"), "aead key");
        let nonce: [u8; 24] = fixed(&hex_field(case, "nonceHex"), "aead nonce");
        let ad = optional_hex_field(case, "adHex");
        let plain = plaintext(case);

        let mut ciphertext = vec![0u8; plain.len() + 16];
        crypto_aead_xchacha20poly1305_ietf_encrypt(
            &mut ciphertext,
            &plain,
            ad.as_deref(),
            &nonce,
            &key,
        )
        .unwrap();
        assert_eq!(
            hex::encode(&ciphertext),
            str_field(case, "ciphertextHex"),
            "aead: {}",
            str_field(case, "description")
        );

        let mut round = vec![0u8; plain.len()];
        crypto_aead_xchacha20poly1305_ietf_decrypt(
            &mut round,
            &ciphertext,
            ad.as_deref(),
            &nonce,
            &key,
        )
        .unwrap();
        assert_eq!(round, plain);
    }
}

#[test]
fn kdf_matches_dryoc() {
    for case in vector_file("crypto-vectors")["kdfDeriveFromKey"]
        .as_array()
        .unwrap()
    {
        let context: [u8; 8] = fixed(str_field(case, "ctx").as_bytes(), "kdf context");
        let main_key: [u8; 32] = fixed(&hex_field(case, "masterKeyHex"), "kdf master key");
        let mut out = vec![0u8; case["length"].as_u64().unwrap() as usize];
        crypto_kdf_derive_from_key(
            &mut out,
            case["subkeyId"].as_u64().unwrap(),
            &context,
            &main_key,
        )
        .unwrap();
        assert_eq!(
            hex::encode(out),
            str_field(case, "derivedHex"),
            "kdf: {}",
            str_field(case, "contextName")
        );
    }
}

#[test]
fn generichash_matches_dryoc() {
    for case in vector_file("crypto-vectors")["generichash"]
        .as_array()
        .unwrap()
    {
        let message = match case.get("messageUtf8").and_then(Json::as_str) {
            Some(text) => text.as_bytes().to_vec(),
            None => hex_field(case, "messageHex"),
        };
        let key = optional_hex_field(case, "keyHex");
        let out_len = case["outLength"].as_u64().unwrap() as usize;
        let mut out = vec![0u8; out_len];
        let result = crypto_generichash(&mut out, &message, key.as_deref());

        if out_len < 16 {
            // `dryoc` enforces libsodium's *documented* 16-byte minimum at every
            // entry point, and its `blake2b::State` is `pub(crate)`, so there is
            // no lower-level door. libsodium's 1.0.21 implementation accepts any
            // length in 1..=64, which is what BLAKE2b itself defines, and the
            // 4-byte SAS hash of chapter 03 §3.6 depends on that.
            //
            // The cross-check is asserted rather than skipped: if a future dryoc
            // relaxes the bound, this fails and the case rejoins the parity set
            // instead of staying quietly uncovered.
            assert!(
                result.is_err(),
                "dryoc unexpectedly accepted a {out_len}-byte digest; \
                 move this case into the parity set"
            );
            continue;
        }

        result.unwrap();
        assert_eq!(
            hex::encode(out),
            str_field(case, "hashHex"),
            "generichash: {}",
            str_field(case, "description")
        );
    }
}

#[test]
fn auth_matches_dryoc() {
    for case in vector_file("crypto-vectors")["auth"].as_array().unwrap() {
        let key: [u8; 32] = fixed(&hex_field(case, "keyHex"), "auth key");
        let mut mac = [0u8; 32];
        crypto_auth(&mut mac, str_field(case, "messageUtf8").as_bytes(), &key);
        assert_eq!(hex::encode(mac), str_field(case, "macHex"));
    }
}

#[test]
fn ed25519_matches_dryoc() {
    let ed = &vector_file("crypto-vectors")["ed25519"];
    let seed: [u8; 32] = fixed(&hex_field(ed, "seedHex"), "ed25519 seed");
    let (public_key, secret_key) = crypto_sign_seed_keypair(&seed);
    assert_eq!(hex::encode(public_key), str_field(ed, "publicKeyHex"));
    assert_eq!(hex::encode(secret_key), str_field(ed, "secretKeyHex"));

    let mut signature = [0u8; 64];
    crypto_sign_detached(
        &mut signature,
        str_field(ed, "messageUtf8").as_bytes(),
        &secret_key,
    )
    .unwrap();
    assert_eq!(
        hex::encode(signature),
        str_field(ed, "detachedSignatureHex")
    );
}

#[test]
fn scalarmult_matches_dryoc() {
    let file = vector_file("crypto-vectors");
    for case in file["scalarmult"]["base"].as_array().unwrap() {
        let scalar: [u8; 32] = fixed(&hex_field(case, "scalarHex"), "x25519 scalar");
        let mut public = [0u8; 32];
        crypto_scalarmult_base(&mut public, &scalar);
        assert_eq!(hex::encode(public), str_field(case, "publicKeyHex"));
    }
    for case in file["scalarmult"]["shared"].as_array().unwrap() {
        let scalar: [u8; 32] = fixed(&hex_field(case, "scalarHex"), "x25519 scalar");
        let point: [u8; 32] = fixed(&hex_field(case, "pointHex"), "x25519 point");
        let mut shared = [0u8; 32];
        // A non-zero return is an all-zero output point, which libsodium and
        // dryoc both refuse and which a caller must never use.
        crypto_scalarmult(&mut shared, &scalar, &point).unwrap();
        assert_eq!(hex::encode(shared), str_field(case, "sharedSecretHex"));
    }
}
