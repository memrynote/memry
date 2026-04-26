use dryoc::classic::crypto_generichash::crypto_generichash;

use memry_desktop_tauri_lib::crypto::sign_verify::{
    device_id_from_public_key, generate_keypair, keypair_from_seed, sign_detached, verify_detached,
    DEVICE_ID_HASH_LENGTH, PUBLIC_KEY_LENGTH, SECRET_KEY_LENGTH, SEED_LENGTH, SIGNATURE_LENGTH,
};
use memry_desktop_tauri_lib::error::AppError;

fn hex_decode(s: &str) -> Vec<u8> {
    let cleaned: String = s.chars().filter(|c| !c.is_whitespace()).collect();
    let bytes = cleaned.as_bytes();
    assert!(bytes.len() % 2 == 0, "hex string must have even length");
    let mut out = Vec::with_capacity(bytes.len() / 2);
    for pair in bytes.chunks(2) {
        out.push((nibble(pair[0]) << 4) | nibble(pair[1]));
    }
    out
}

fn nibble(b: u8) -> u8 {
    match b {
        b'0'..=b'9' => b - b'0',
        b'a'..=b'f' => b - b'a' + 10,
        b'A'..=b'F' => b - b'A' + 10,
        _ => panic!("invalid hex nibble: {b}"),
    }
}

fn seed_from_hex(s: &str) -> [u8; SEED_LENGTH] {
    let bytes = hex_decode(s);
    assert_eq!(bytes.len(), SEED_LENGTH);
    let mut seed = [0u8; SEED_LENGTH];
    seed.copy_from_slice(&bytes);
    seed
}

#[test]
fn generate_keypair_returns_32_byte_public_and_64_byte_secret() {
    let pair = generate_keypair();
    assert_eq!(pair.public_key.len(), PUBLIC_KEY_LENGTH);
    assert_eq!(pair.public_key.len(), 32);
    assert_eq!(pair.secret_key.len(), SECRET_KEY_LENGTH);
    assert_eq!(pair.secret_key.len(), 64);
}

#[test]
fn sign_detached_returns_64_byte_signature() {
    let pair = generate_keypair();
    let signature = sign_detached(b"a message", &pair.secret_key).unwrap();
    assert_eq!(signature.len(), SIGNATURE_LENGTH);
    assert_eq!(signature.len(), 64);
}

#[test]
fn verify_detached_succeeds_for_original_message() {
    let pair = generate_keypair();
    let message = b"sign me";
    let signature = sign_detached(message, &pair.secret_key).unwrap();
    verify_detached(message, &signature, &pair.public_key).unwrap();
}

#[test]
fn verify_detached_fails_for_tampered_message() {
    let pair = generate_keypair();
    let message = b"sign me";
    let signature = sign_detached(message, &pair.secret_key).unwrap();

    let err = verify_detached(b"sign me!", &signature, &pair.public_key).unwrap_err();
    assert!(
        matches!(err, AppError::Crypto(_)),
        "expected AppError::Crypto, got {err:?}"
    );
}

#[test]
fn verify_detached_fails_for_wrong_public_key() {
    let pair = generate_keypair();
    let other = generate_keypair();
    let message = b"sign me";
    let signature = sign_detached(message, &pair.secret_key).unwrap();

    let err = verify_detached(message, &signature, &other.public_key).unwrap_err();
    assert!(
        matches!(err, AppError::Crypto(_)),
        "expected AppError::Crypto, got {err:?}"
    );
}

#[test]
fn sign_detached_rejects_secret_key_with_wrong_length() {
    let too_short = vec![0u8; SECRET_KEY_LENGTH - 1];
    let err = sign_detached(b"msg", &too_short).unwrap_err();
    assert!(
        matches!(err, AppError::Crypto(_)),
        "expected AppError::Crypto, got {err:?}"
    );
}

#[test]
fn verify_detached_rejects_signature_with_wrong_length() {
    let pair = generate_keypair();
    let bogus_signature = vec![0u8; SIGNATURE_LENGTH - 1];
    let err = verify_detached(b"msg", &bogus_signature, &pair.public_key).unwrap_err();
    assert!(
        matches!(err, AppError::Crypto(_)),
        "expected AppError::Crypto, got {err:?}"
    );
}

#[test]
fn keypair_from_seed_matches_rfc8032_test_1_empty_message() {
    let seed = seed_from_hex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");
    let expected_public =
        hex_decode("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
    let expected_signature = hex_decode(concat!(
        "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155",
        "5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
    ));

    let pair = keypair_from_seed(&seed);
    assert_eq!(pair.public_key.to_vec(), expected_public);

    let signature = sign_detached(b"", &pair.secret_key).unwrap();
    assert_eq!(signature.to_vec(), expected_signature);

    verify_detached(b"", &signature, &pair.public_key).unwrap();
}

#[test]
fn keypair_from_seed_matches_rfc8032_test_2_single_byte() {
    let seed = seed_from_hex("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb");
    let expected_public =
        hex_decode("3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c");
    let expected_signature = hex_decode(concat!(
        "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da",
        "085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00",
    ));

    let pair = keypair_from_seed(&seed);
    assert_eq!(pair.public_key.to_vec(), expected_public);

    let message = [0x72u8];
    let signature = sign_detached(&message, &pair.secret_key).unwrap();
    assert_eq!(signature.to_vec(), expected_signature);

    verify_detached(&message, &signature, &pair.public_key).unwrap();
}

#[test]
fn device_id_from_public_key_is_16_byte_blake2b_hex() {
    let public_key = hex_decode("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");

    let device_id = device_id_from_public_key(&public_key).unwrap();

    let mut expected_bytes = [0u8; DEVICE_ID_HASH_LENGTH];
    crypto_generichash(&mut expected_bytes, &public_key, None).unwrap();
    assert_eq!(device_id, hex::encode(expected_bytes));
    assert_eq!(device_id.len(), 32, "16 bytes -> 32 hex chars");
}

#[test]
fn device_id_from_public_key_rejects_wrong_length() {
    let too_short = vec![0u8; PUBLIC_KEY_LENGTH - 1];
    let err = device_id_from_public_key(&too_short).unwrap_err();
    assert!(
        matches!(err, AppError::Crypto(_)),
        "expected AppError::Crypto, got {err:?}"
    );
}
