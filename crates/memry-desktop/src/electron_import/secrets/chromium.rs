//! Chromium OSCrypt v10/v11 decryption, the layouts of Electron 43.1.1's synchronous
//! `safeStorage` (see `apps/docs/src/contribute/electron-profile-format.md`).

use aes::cipher::{BlockModeDecrypt, KeyIvInit, block_padding::Pkcs7};
use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use sha1::Sha1;
use zeroize::Zeroizing;

const SALT: &[u8] = b"saltysalt";
const CBC_IV: [u8; 16] = [0x20; 16];
const GCM_NONCE_LEN: usize = 12;
const GCM_TAG_LEN: usize = 16;
/// `pbkdf2("peanuts", "saltysalt", 1, 16)`: the key of Linux `v10` ciphertexts.
const LINUX_V10_KEY: [u8; 16] = [
    0xfd, 0x62, 0x1f, 0xe5, 0xa2, 0xb4, 0x02, 0x53, 0x9d, 0xfa, 0x14, 0x7c, 0xa9, 0x27, 0x27, 0x78,
];
/// `pbkdf2("", "saltysalt", 1, 16)`: Chromium's retry key on Linux.
const LINUX_EMPTY_KEY: [u8; 16] = [
    0xd0, 0xd0, 0xec, 0x9c, 0x7d, 0x77, 0xd4, 0x3a, 0xc5, 0x41, 0x87, 0xfa, 0x48, 0x18, 0xd1, 0x7f,
];

type Aes128CbcDec = cbc::Decryptor<aes::Aes128>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecryptFailure {
    /// Wrong prefix or impossible length: not a ciphertext this layout can produce.
    Corrupt,
    /// Structurally fine but the key does not fit (bad padding, bad tag, non-printable result).
    WrongKey,
}

fn derive(password: &[u8], iterations: u32) -> [u8; 16] {
    let mut key = [0_u8; 16];
    pbkdf2::pbkdf2_hmac::<Sha1>(password, SALT, iterations, &mut key);
    key
}

fn split_prefix<'a>(
    ciphertext: &'a [u8],
    prefixes: &[&'static [u8; 3]],
) -> Result<(&'static [u8; 3], &'a [u8]), DecryptFailure> {
    let (head, body) = ciphertext
        .split_at_checked(3)
        .ok_or(DecryptFailure::Corrupt)?;
    prefixes
        .iter()
        .find(|p| head == p.as_slice())
        .map(|p| (*p, body))
        .ok_or(DecryptFailure::Corrupt)
}

fn decrypt_cbc(key: &[u8; 16], body: &[u8]) -> Result<Zeroizing<String>, DecryptFailure> {
    if body.is_empty() || !body.len().is_multiple_of(16) {
        return Err(DecryptFailure::Corrupt);
    }
    let plain = Aes128CbcDec::new(key.into(), (&CBC_IV).into())
        .decrypt_padded_vec::<Pkcs7>(body)
        .map(Zeroizing::new)
        .map_err(|_| DecryptFailure::WrongKey)?;
    printable(plain)
}

/// Unauthenticated CBC decrypts with a wrong key about once in 256 tries, so a result counts
/// only when it is printable ASCII (`looksLikePlaintextSecret` in `secret-storage.ts`).
fn printable(plain: Zeroizing<Vec<u8>>) -> Result<Zeroizing<String>, DecryptFailure> {
    if plain.is_empty() || !plain.iter().all(|b| (0x20..=0x7e).contains(b)) {
        return Err(DecryptFailure::WrongKey);
    }
    String::from_utf8(plain.to_vec())
        .map(Zeroizing::new)
        .map_err(|_| DecryptFailure::WrongKey)
}

/// macOS: `v10` + AES-128-CBC, key = PBKDF2-HMAC-SHA1(keychain password, `saltysalt`, 1003).
pub fn decrypt_macos(
    password: &[u8],
    ciphertext: &[u8],
) -> Result<Zeroizing<String>, DecryptFailure> {
    let (_, body) = split_prefix(ciphertext, &[b"v10"])?;
    decrypt_cbc(&derive(password, 1003), body)
}

/// Linux: `v11` uses PBKDF2(secret, 1 iteration), `v10` the fixed key; any failure retries with
/// the empty-password key.
pub fn decrypt_linux(
    password: Option<&[u8]>,
    ciphertext: &[u8],
) -> Result<Zeroizing<String>, DecryptFailure> {
    let (prefix, body) = split_prefix(ciphertext, &[b"v10", b"v11"])?;
    let mut keys = Vec::with_capacity(2);
    if prefix == b"v10" {
        keys.push(LINUX_V10_KEY);
    } else if let Some(password) = password {
        keys.push(derive(password, 1));
    } else {
        return Err(DecryptFailure::WrongKey);
    }
    keys.push(LINUX_EMPTY_KEY);
    let mut last = DecryptFailure::WrongKey;
    for key in keys {
        match decrypt_cbc(&key, body) {
            Ok(plain) => return Ok(plain),
            Err(DecryptFailure::Corrupt) => return Err(DecryptFailure::Corrupt),
            Err(e) => last = e,
        }
    }
    Err(last)
}

/// Linux `v10` needs no key material; `v11` does.
pub fn linux_needs_password(ciphertext: &[u8]) -> bool {
    ciphertext.starts_with(b"v11")
}

/// Windows: `v10` + 12-byte nonce + AES-256-GCM ciphertext + 16-byte tag, no AAD. The tag
/// authenticates the key, so the plaintext only has to be UTF-8.
pub fn decrypt_windows(
    key: &[u8; 32],
    ciphertext: &[u8],
) -> Result<Zeroizing<String>, DecryptFailure> {
    let (_, body) = split_prefix(ciphertext, &[b"v10"])?;
    if body.len() < GCM_NONCE_LEN + GCM_TAG_LEN {
        return Err(DecryptFailure::Corrupt);
    }
    let (nonce, sealed) = body.split_at(GCM_NONCE_LEN);
    let cipher = Aes256Gcm::new(key.into());
    let plain = cipher
        .decrypt(
            &Nonce::try_from(nonce).map_err(|_| DecryptFailure::Corrupt)?,
            sealed,
        )
        .map(Zeroizing::new)
        .map_err(|_| DecryptFailure::WrongKey)?;
    String::from_utf8(plain.to_vec())
        .map(Zeroizing::new)
        .map_err(|_| DecryptFailure::WrongKey)
}

#[cfg(test)]
mod tests;
