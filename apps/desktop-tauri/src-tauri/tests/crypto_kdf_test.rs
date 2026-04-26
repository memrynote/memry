use base64::{engine::general_purpose::STANDARD, Engine as _};
use dryoc::classic::crypto_kdf::crypto_kdf_derive_from_key;

use memry_desktop_tauri_lib::crypto::kdf::{
    derive_key, derive_master_key, generate_key_verifier, ARGON2_MEM_LIMIT, ARGON2_OPS_LIMIT,
    ARGON2_SALT_LENGTH,
};
use memry_desktop_tauri_lib::crypto::vectors::{KdfContextEntry, KDF_CONTEXTS};
use memry_desktop_tauri_lib::error::AppError;

const MASTER_KEY: [u8; 32] = [
    0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f,
    0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x2d, 0x2e, 0x2f,
];

#[test]
fn argon2id_constants_match_electron() {
    assert_eq!(ARGON2_OPS_LIMIT, 3);
    assert_eq!(ARGON2_MEM_LIMIT, 67_108_864);
    assert_eq!(ARGON2_SALT_LENGTH, 16);
}

#[test]
fn kdf_context_table_matches_electron() {
    let expected: &[(&str, u64, &[u8; 8])] = &[
        ("memry-vault-key-v1", 1, b"memryvlt"),
        ("memry-signing-key-v1", 2, b"memrysgn"),
        ("memry-verify-key-v1", 3, b"memryvrf"),
        ("memry-key-verifier-v1", 4, b"memrykve"),
        ("memry-linking-enc-v1", 5, b"memrylnk"),
        ("memry-linking-mac-v1", 6, b"memrymac"),
        ("memry-linking-sas-v1", 7, b"memrysas"),
    ];
    assert_eq!(KDF_CONTEXTS.len(), expected.len());
    for (entry, exp) in KDF_CONTEXTS.iter().zip(expected.iter()) {
        let entry_ref: &KdfContextEntry = entry;
        assert_eq!(entry_ref.label, exp.0);
        assert_eq!(entry_ref.subkey_id, exp.1);
        assert_eq!(&entry_ref.context_bytes, exp.2);
        assert_eq!(entry_ref.context_bytes.len(), 8);
    }
}

#[test]
fn derive_key_returns_requested_length_for_vault_key() {
    let derived = derive_key(&MASTER_KEY, "memry-vault-key-v1", 32).unwrap();
    assert_eq!(derived.len(), 32);
}

#[test]
fn derive_key_matches_direct_dryoc_for_vault_context() {
    let derived = derive_key(&MASTER_KEY, "memry-vault-key-v1", 32).unwrap();

    let mut expected = [0u8; 32];
    crypto_kdf_derive_from_key(&mut expected, 1, b"memryvlt", &MASTER_KEY).unwrap();

    assert_eq!(derived, expected.to_vec());
}

#[test]
fn derive_key_unknown_context_errors() {
    let err = derive_key(&MASTER_KEY, "memry-not-a-real-context", 32).unwrap_err();
    assert!(
        matches!(err, AppError::Crypto(_) | AppError::Validation(_)),
        "expected AppError::Crypto or Validation, got {err:?}"
    );
}

#[test]
fn derive_key_rejects_master_key_with_wrong_length() {
    let too_short = [0u8; 31];
    let err = derive_key(&too_short, "memry-vault-key-v1", 32).unwrap_err();
    assert!(
        matches!(err, AppError::Crypto(_)),
        "expected AppError::Crypto, got {err:?}"
    );
}

#[test]
fn generate_key_verifier_uses_kve_context_and_base64() {
    let verifier = generate_key_verifier(&MASTER_KEY).unwrap();
    let bytes = STANDARD.decode(&verifier).unwrap();
    assert_eq!(bytes.len(), 32);

    let mut expected = [0u8; 32];
    crypto_kdf_derive_from_key(&mut expected, 4, b"memrykve", &MASTER_KEY).unwrap();
    assert_eq!(bytes, expected.to_vec());
}

#[tokio::test]
async fn derive_master_key_returns_32_byte_master_and_base64_metadata() {
    let seed = b"correct horse battery staple".to_vec();
    let salt: [u8; ARGON2_SALT_LENGTH] = [
        0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42,
        0x42,
    ];

    let material = derive_master_key(seed, salt).await.unwrap();
    assert_eq!(material.master_key.len(), 32);

    let salt_decoded = STANDARD.decode(&material.kdf_salt).unwrap();
    assert_eq!(salt_decoded, salt.to_vec());

    let verifier_decoded = STANDARD.decode(&material.key_verifier).unwrap();
    assert_eq!(verifier_decoded.len(), 32);

    let master_array: [u8; 32] = material.master_key.as_slice().try_into().unwrap();
    let mut expected_verifier = [0u8; 32];
    crypto_kdf_derive_from_key(&mut expected_verifier, 4, b"memrykve", &master_array).unwrap();
    assert_eq!(verifier_decoded, expected_verifier.to_vec());
}

#[tokio::test]
async fn derive_master_key_is_deterministic_for_same_inputs() {
    let seed = b"same seed".to_vec();
    let salt: [u8; ARGON2_SALT_LENGTH] = [0u8; ARGON2_SALT_LENGTH];

    let first = derive_master_key(seed.clone(), salt).await.unwrap();
    let second = derive_master_key(seed, salt).await.unwrap();

    assert_eq!(first.master_key, second.master_key);
    assert_eq!(first.key_verifier, second.key_verifier);
    assert_eq!(first.kdf_salt, second.kdf_salt);
}
