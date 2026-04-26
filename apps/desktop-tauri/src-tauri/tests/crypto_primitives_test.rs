use memry_desktop_tauri_lib::crypto::primitives::{
    decrypt_blob, encrypt_blob, EncryptedBlob, KEY_LENGTH, NONCE_LENGTH,
};
use memry_desktop_tauri_lib::crypto::{generate_nonce, NONCE_LENGTH as MOD_NONCE_LENGTH};
use memry_desktop_tauri_lib::error::AppError;

fn key_32(byte: u8) -> Vec<u8> {
    vec![byte; KEY_LENGTH]
}

#[test]
fn generate_nonce_returns_24_bytes_and_is_unique() {
    let a = generate_nonce();
    let b = generate_nonce();
    assert_eq!(a.len(), NONCE_LENGTH);
    assert_eq!(a.len(), MOD_NONCE_LENGTH);
    assert_eq!(NONCE_LENGTH, 24);
    assert_ne!(a, b, "two nonces must differ");
}

#[test]
fn encrypt_blob_returns_ciphertext_and_24_byte_nonce() {
    let plaintext = b"hello memry";
    let key = key_32(0x11);

    let blob: EncryptedBlob = encrypt_blob(plaintext, &key, None).unwrap();

    assert_eq!(blob.nonce.len(), NONCE_LENGTH);
    assert!(
        blob.ciphertext.len() > plaintext.len(),
        "ciphertext must be longer than plaintext (carries the auth tag)"
    );
}

#[test]
fn decrypt_blob_round_trips_without_associated_data() {
    let plaintext = b"round trip without aad";
    let key = key_32(0x22);

    let blob = encrypt_blob(plaintext, &key, None).unwrap();
    let recovered = decrypt_blob(&blob.ciphertext, &blob.nonce, &key, None).unwrap();

    assert_eq!(recovered, plaintext);
}

#[test]
fn decrypt_blob_round_trips_with_associated_data() {
    let plaintext = b"round trip with aad";
    let key = key_32(0x33);
    let aad = b"item-id:abc-123";

    let blob = encrypt_blob(plaintext, &key, Some(aad)).unwrap();
    let recovered = decrypt_blob(&blob.ciphertext, &blob.nonce, &key, Some(aad)).unwrap();

    assert_eq!(recovered, plaintext);
}

#[test]
fn decrypt_with_wrong_associated_data_returns_crypto_error() {
    let plaintext = b"bound to aad";
    let key = key_32(0x44);
    let aad = b"item-id:abc-123";
    let wrong_aad = b"item-id:xyz-999";

    let blob = encrypt_blob(plaintext, &key, Some(aad)).unwrap();
    let err = decrypt_blob(&blob.ciphertext, &blob.nonce, &key, Some(wrong_aad)).unwrap_err();

    assert!(
        matches!(err, AppError::Crypto(_)),
        "expected AppError::Crypto, got {err:?}"
    );
}

#[test]
fn decrypt_with_tampered_ciphertext_returns_crypto_error() {
    let plaintext = b"do not tamper";
    let key = key_32(0x55);

    let blob = encrypt_blob(plaintext, &key, None).unwrap();
    let mut tampered = blob.ciphertext.clone();
    tampered[0] ^= 0x01;

    let err = decrypt_blob(&tampered, &blob.nonce, &key, None).unwrap_err();
    assert!(
        matches!(err, AppError::Crypto(_)),
        "expected AppError::Crypto, got {err:?}"
    );
}

#[test]
fn encrypt_with_wrong_key_length_returns_crypto_error() {
    let plaintext = b"bad key";
    let too_short = vec![0u8; KEY_LENGTH - 1];

    let err = encrypt_blob(plaintext, &too_short, None).unwrap_err();
    assert!(
        matches!(err, AppError::Crypto(_)),
        "expected AppError::Crypto, got {err:?}"
    );
}

#[test]
fn decrypt_with_wrong_key_length_returns_crypto_error() {
    let plaintext = b"bad key";
    let key = key_32(0x66);
    let blob = encrypt_blob(plaintext, &key, None).unwrap();

    let too_long = vec![0u8; KEY_LENGTH + 1];
    let err = decrypt_blob(&blob.ciphertext, &blob.nonce, &too_long, None).unwrap_err();
    assert!(
        matches!(err, AppError::Crypto(_)),
        "expected AppError::Crypto, got {err:?}"
    );
}

#[test]
fn decrypt_with_wrong_nonce_length_returns_crypto_error() {
    let plaintext = b"bad nonce";
    let key = key_32(0x77);
    let blob = encrypt_blob(plaintext, &key, None).unwrap();

    let short_nonce = vec![0u8; NONCE_LENGTH - 1];
    let err = decrypt_blob(&blob.ciphertext, &short_nonce, &key, None).unwrap_err();
    assert!(
        matches!(err, AppError::Crypto(_)),
        "expected AppError::Crypto, got {err:?}"
    );
}

/// Cross-implementation compatibility: decrypts the IETF
/// draft-irtf-cfrg-xchacha-03 §A.3.1 XChaCha20-Poly1305 vector that
/// `apps/desktop/src/main/crypto/__fixtures__/xchacha20-rfc8439.ts` pins for
/// the Electron implementation. If our wrapper produces a different AEAD
/// construction than libsodium / RustCrypto's XChaCha20Poly1305, this fails.
#[test]
fn decrypts_known_xchacha20_rfc8439_draft_vector() {
    let key = hex_decode(
        "808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f",
    );
    let nonce = hex_decode("404142434445464748494a4b4c4d4e4f5051525354555657");
    let aad = hex_decode("50515253c0c1c2c3c4c5c6c7");
    let plaintext_hex = concat!(
        "4c616469657320616e642047656e746c656d656e206f662074686520636c6173",
        "73206f66202739393a204966204920636f756c64206f6666657220796f75206f",
        "6e6c79206f6e652074697020666f7220746865206675747572652c2073756e73",
        "637265656e20776f756c642062652069742e",
    );
    let ciphertext_hex = concat!(
        "bd6d179d3e83d43b9576579493c0e939572a1700252bfaccbed2902c21396cbb",
        "731c7f1b0b4aa6440bf3a82f4eda7e39ae64c6708c54c216cb96b72e1213b452",
        "2f8c9ba40db5d945b11b69b982c1bb9e3f3fac2bc369488f76b2383565d3fff9",
        "21f9664c97637da9768812f615c68b13b52e",
    );
    let tag_hex = "c0875924c1c7987947deafd8780acf49";

    let mut combined = hex_decode(ciphertext_hex);
    combined.extend_from_slice(&hex_decode(tag_hex));

    assert_eq!(nonce.len(), NONCE_LENGTH);
    assert_eq!(key.len(), KEY_LENGTH);

    let recovered = decrypt_blob(&combined, &nonce, &key, Some(&aad)).unwrap();
    assert_eq!(recovered, hex_decode(plaintext_hex));
}

fn hex_decode(s: &str) -> Vec<u8> {
    let cleaned: String = s.chars().filter(|c| !c.is_whitespace()).collect();
    let bytes = cleaned.as_bytes();
    assert!(bytes.len() % 2 == 0, "hex string must have even length");
    let mut out = Vec::with_capacity(bytes.len() / 2);
    for pair in bytes.chunks(2) {
        let hi = hex_nibble(pair[0]);
        let lo = hex_nibble(pair[1]);
        out.push((hi << 4) | lo);
    }
    out
}

fn hex_nibble(b: u8) -> u8 {
    match b {
        b'0'..=b'9' => b - b'0',
        b'a'..=b'f' => b - b'a' + 10,
        b'A'..=b'F' => b - b'A' + 10,
        _ => panic!("invalid hex nibble: {b}"),
    }
}
