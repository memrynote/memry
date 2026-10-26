//! Chromium OSCrypt v10/v11 decryption, the layouts of Electron 43.1.1's synchronous
//! `safeStorage` (see `apps/docs/src/contribute/electron-profile-format.md`).

use aes::cipher::{BlockModeDecrypt, KeyIvInit, block_padding::Pkcs7};
use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use sha1::Sha1;
use zeroize::Zeroizing;

use crate::electron_import::profile::HostOs;

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

/// A derived AES-128 key; wiped on drop.
pub type CbcKey = Zeroizing<[u8; 16]>;

type Aes128CbcDec = cbc::Decryptor<aes::Aes128>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecryptFailure {
    /// Wrong prefix or impossible length: not a ciphertext this layout can produce.
    Corrupt,
    /// Structurally fine but the key does not fit (bad padding, bad tag, non-printable result).
    WrongKey,
}

fn derive(password: &[u8], iterations: u32) -> CbcKey {
    let mut key = Zeroizing::new([0_u8; 16]);
    pbkdf2::pbkdf2_hmac::<Sha1>(password, SALT, iterations, key.as_mut());
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

/// AES-128-CBC keys to try for `ciphertext`, in Chromium's order. macOS: PBKDF2 of the Keychain
/// password (1003 iterations), so `password` is required. Linux `v11`: PBKDF2 of the secret (1
/// iteration) then the empty-password key; `v10`: the fixed key then the empty-password key.
/// Windows ciphertexts are GCM and have no CBC keys.
pub fn cbc_keys(
    host: HostOs,
    password: Option<&[u8]>,
    ciphertext: &[u8],
) -> Result<Vec<CbcKey>, DecryptFailure> {
    match host {
        HostOs::MacOs => {
            split_prefix(ciphertext, &[b"v10"])?;
            Ok(password.map(|p| derive(p, 1003)).into_iter().collect())
        }
        HostOs::Linux => {
            let (prefix, _) = split_prefix(ciphertext, &[b"v10", b"v11"])?;
            let mut keys = Vec::new();
            if prefix == b"v10" {
                keys.push(Zeroizing::new(LINUX_V10_KEY));
            } else if let Some(password) = password {
                keys.push(derive(password, 1));
            }
            if prefix == b"v10" || password.is_some() {
                keys.push(Zeroizing::new(LINUX_EMPTY_KEY));
            }
            Ok(keys)
        }
        HostOs::Windows => Err(DecryptFailure::Corrupt),
    }
}

/// Linux `v10` needs no key material; `v11` does.
pub fn linux_needs_password(ciphertext: &[u8]) -> bool {
    ciphertext.starts_with(b"v11")
}

/// Decrypts one CBC ciphertext with `key`. A valid PKCS7 padding and UTF-8 text is all this
/// checks: unauthenticated CBC decrypts under a wrong key about once in 256 tries, so the caller
/// must establish that the key is right ([`is_printable`] on some entry) before it believes a
/// plaintext that is not printable. Electron accepts any decrypt in `decryptValue`; only
/// `probeSecretStoreIdentity` applies the printable test.
pub fn decrypt_cbc(key: &CbcKey, ciphertext: &[u8]) -> Result<Zeroizing<String>, DecryptFailure> {
    let (_, body) = split_prefix(ciphertext, &[b"v10", b"v11"])?;
    if body.is_empty() || !body.len().is_multiple_of(16) {
        return Err(DecryptFailure::Corrupt);
    }
    let plain = Aes128CbcDec::new((&**key).into(), (&CBC_IV).into())
        .decrypt_padded_vec::<Pkcs7>(body)
        .map(Zeroizing::new)
        .map_err(|_| DecryptFailure::WrongKey)?;
    if plain.is_empty() {
        return Err(DecryptFailure::WrongKey);
    }
    String::from_utf8(plain.to_vec())
        .map(Zeroizing::new)
        .map_err(|_| DecryptFailure::WrongKey)
}

/// `looksLikePlaintextSecret` in `secret-storage.ts`: every secret the app stores is base64 or
/// hex text, so printable ASCII marks a decrypt as made with the right key.
pub fn is_printable(plain: &str) -> bool {
    !plain.is_empty() && plain.bytes().all(|b| (0x20..=0x7e).contains(&b))
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
