use aes::cipher::{BlockModeEncrypt, KeyIvInit};
use aes_gcm::aead::Aead;

use super::*;

type Aes128CbcEnc = cbc::Encryptor<aes::Aes128>;

fn encrypt_cbc(key: &[u8; 16], prefix: &[u8], plain: &[u8]) -> Vec<u8> {
    let body = Aes128CbcEnc::new(key.into(), (&CBC_IV).into()).encrypt_padded_vec::<Pkcs7>(plain);
    [prefix, &body].concat()
}

fn key(password: &[u8], iterations: u32) -> CbcKey {
    derive(password, iterations)
}

#[test]
fn linux_constants_are_the_documented_derivations() {
    assert_eq!(*derive(b"peanuts", 1), LINUX_V10_KEY);
    assert_eq!(*derive(b"", 1), LINUX_EMPTY_KEY);
}

#[test]
fn macos_round_trip() {
    let ct = encrypt_cbc(&key(b"pw", 1003), b"v10", b"secret-value");
    let keys = cbc_keys(HostOs::MacOs, Some(b"pw"), &ct).unwrap();
    assert_eq!(&*decrypt_cbc(&keys[0], &ct).unwrap(), "secret-value");
    let wrong = cbc_keys(HostOs::MacOs, Some(b"other"), &ct).unwrap();
    assert_eq!(
        decrypt_cbc(&wrong[0], &ct).unwrap_err(),
        DecryptFailure::WrongKey
    );
    assert!(cbc_keys(HostOs::MacOs, None, &ct).unwrap().is_empty());
}

#[test]
fn a_non_ascii_plaintext_decrypts_and_only_the_printable_test_rejects_it() {
    let ct = encrypt_cbc(&key(b"pw", 1003), b"v10", "şifre".as_bytes());
    let plain = decrypt_cbc(&key(b"pw", 1003), &ct).unwrap();
    assert_eq!(&*plain, "şifre");
    assert!(!is_printable(&plain));
    assert!(is_printable("abc=/+"));
    assert!(!is_printable(""));
}

#[test]
fn non_utf8_and_empty_plaintext_are_a_wrong_key() {
    let ct = encrypt_cbc(&key(b"pw", 1003), b"v10", &[0xff, 0xfe, 0xfd]);
    assert_eq!(
        decrypt_cbc(&key(b"pw", 1003), &ct).unwrap_err(),
        DecryptFailure::WrongKey
    );
    let empty = encrypt_cbc(&key(b"pw", 1003), b"v10", b"");
    assert_eq!(
        decrypt_cbc(&key(b"pw", 1003), &empty).unwrap_err(),
        DecryptFailure::WrongKey
    );
}

#[test]
fn structural_garbage_is_corrupt() {
    for ct in [
        &b""[..],
        b"v1",
        b"v10",
        b"v10abc",
        b"xx0aaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        b"v12aaaaaaaaaaaaaaaa",
    ] {
        assert!(
            cbc_keys(HostOs::MacOs, Some(b"pw"), ct).is_err()
                || decrypt_cbc(&key(b"pw", 1003), ct).is_err(),
            "{ct:?}"
        );
    }
    assert_eq!(
        decrypt_windows(&[0; 32], b"v10short").unwrap_err(),
        DecryptFailure::Corrupt
    );
    assert_eq!(
        cbc_keys(HostOs::Linux, None, b"zzz").unwrap_err(),
        DecryptFailure::Corrupt
    );
    assert_eq!(
        decrypt_cbc(&key(b"pw", 1003), b"v10abc").unwrap_err(),
        DecryptFailure::Corrupt
    );
}

#[test]
fn linux_key_order_v11_v10_and_empty_key_retry() {
    let v11 = encrypt_cbc(&key(b"libsecret-pw", 1), b"v11", b"abc");
    let keys = cbc_keys(HostOs::Linux, Some(b"libsecret-pw"), &v11).unwrap();
    assert_eq!(keys.len(), 2);
    assert_eq!(&*decrypt_cbc(&keys[0], &v11).unwrap(), "abc");
    assert!(linux_needs_password(&v11));
    assert!(cbc_keys(HostOs::Linux, None, &v11).unwrap().is_empty());
    let v10 = encrypt_cbc(&LINUX_V10_KEY, b"v10", b"fixed");
    let keys = cbc_keys(HostOs::Linux, None, &v10).unwrap();
    assert_eq!(&*decrypt_cbc(&keys[0], &v10).unwrap(), "fixed");
    assert!(!linux_needs_password(&v10));
    // Chromium wrote it under the empty password (no keyring) but the real secret is now known.
    let empty = encrypt_cbc(&LINUX_EMPTY_KEY, b"v11", b"fallback");
    let keys = cbc_keys(HostOs::Linux, Some(b"libsecret-pw"), &empty).unwrap();
    assert_eq!(&*decrypt_cbc(&keys[1], &empty).unwrap(), "fallback");
}

#[test]
fn windows_gcm_round_trip_and_tamper() {
    let key = [7_u8; 32];
    let nonce = [9_u8; 12];
    let sealed = Aes256Gcm::new((&key).into())
        .encrypt(&Nonce::try_from(&nonce[..]).unwrap(), &b"win-secret"[..])
        .unwrap();
    let ct = [&b"v10"[..], &nonce, &sealed].concat();
    assert_eq!(&*decrypt_windows(&key, &ct).unwrap(), "win-secret");
    assert_eq!(
        decrypt_windows(&[8; 32], &ct).unwrap_err(),
        DecryptFailure::WrongKey
    );
    let mut bad = ct.clone();
    *bad.last_mut().unwrap() ^= 1;
    assert_eq!(
        decrypt_windows(&key, &bad).unwrap_err(),
        DecryptFailure::WrongKey
    );
}
