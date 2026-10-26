use aes::cipher::{BlockModeEncrypt, KeyIvInit};
use aes_gcm::aead::Aead;

use super::*;

type Aes128CbcEnc = cbc::Encryptor<aes::Aes128>;

fn encrypt_cbc(key: &[u8; 16], prefix: &[u8], plain: &[u8]) -> Vec<u8> {
    let body = Aes128CbcEnc::new(key.into(), (&CBC_IV).into()).encrypt_padded_vec::<Pkcs7>(plain);
    [prefix, &body].concat()
}

#[test]
fn linux_constants_are_the_documented_derivations() {
    assert_eq!(derive(b"peanuts", 1), LINUX_V10_KEY);
    assert_eq!(derive(b"", 1), LINUX_EMPTY_KEY);
}

#[test]
fn macos_round_trip() {
    let ct = encrypt_cbc(&derive(b"pw", 1003), b"v10", b"secret-value");
    assert_eq!(&*decrypt_macos(b"pw", &ct).unwrap(), "secret-value");
    assert_eq!(
        decrypt_macos(b"other", &ct).unwrap_err(),
        DecryptFailure::WrongKey
    );
}

#[test]
fn non_printable_plaintext_is_a_wrong_key() {
    let ct = encrypt_cbc(&derive(b"pw", 1003), b"v10", &[0x01, 0x02, 0x03]);
    assert_eq!(
        decrypt_macos(b"pw", &ct).unwrap_err(),
        DecryptFailure::WrongKey
    );
    let empty = encrypt_cbc(&derive(b"pw", 1003), b"v10", b"");
    assert_eq!(
        decrypt_macos(b"pw", &empty).unwrap_err(),
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
        assert_eq!(
            decrypt_macos(b"pw", ct).unwrap_err(),
            DecryptFailure::Corrupt,
            "{ct:?}"
        );
    }
    assert_eq!(
        decrypt_windows(&[0; 32], b"v10short").unwrap_err(),
        DecryptFailure::Corrupt
    );
    assert_eq!(
        decrypt_linux(None, b"zzz").unwrap_err(),
        DecryptFailure::Corrupt
    );
}

#[test]
fn linux_v11_v10_and_empty_key_retry() {
    let v11 = encrypt_cbc(&derive(b"libsecret-pw", 1), b"v11", b"abc");
    assert_eq!(&*decrypt_linux(Some(b"libsecret-pw"), &v11).unwrap(), "abc");
    assert!(linux_needs_password(&v11));
    assert_eq!(
        decrypt_linux(None, &v11).unwrap_err(),
        DecryptFailure::WrongKey
    );
    let v10 = encrypt_cbc(&LINUX_V10_KEY, b"v10", b"fixed");
    assert_eq!(&*decrypt_linux(None, &v10).unwrap(), "fixed");
    assert!(!linux_needs_password(&v10));
    // Chromium wrote it under the empty password (no keyring) but the real secret is now known.
    let empty = encrypt_cbc(&LINUX_EMPTY_KEY, b"v11", b"fallback");
    assert_eq!(
        &*decrypt_linux(Some(b"libsecret-pw"), &empty).unwrap(),
        "fallback"
    );
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
