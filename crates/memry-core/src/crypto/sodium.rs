//! The libsodium seam.
//!
//! Every call into `libsodium-sys-stable` in this crate goes through this file,
//! so there is exactly one `unsafe` block per primitive and exactly one place
//! that knows libsodium's calling conventions. Chapter 01 and chapter 04 name
//! the primitives; this module is their safe surface and adds no policy.
//!
//! Two rules the rest of the crate depends on:
//!
//! - `init()` runs `sodium_init` behind a `Once`. libsodium is not thread-safe
//!   until it has run, and it is legal to call more than once, so the `Once` is
//!   about ordering rather than about avoiding a second call.
//! - Every Rust-owned secret buffer this module hands back is wrapped so that
//!   `zeroize` runs on drop. `sodium_memzero` is used for buffers libsodium
//!   itself filled, because the compiler is not allowed to elide it.

use std::sync::Once;

use zeroize::Zeroizing;

use crate::api::errors::CryptoError;

static INIT: Once = Once::new();

/// Runs `sodium_init` exactly once per process.
///
/// `sodium_init` returns 0 on first success and 1 when the library was already
/// initialised; only a negative return is a failure, and that is unrecoverable,
/// so it panics rather than threading an error through every caller.
pub fn init() {
    INIT.call_once(|| {
        // SAFETY: no arguments, and the `Once` guarantees this is the first
        // libsodium call on any thread.
        let rc = unsafe { libsodium_sys::sodium_init() };
        assert!(rc >= 0, "sodium_init failed with {rc}");
    });
}

/// Overwrites `buf` through libsodium, which the optimiser may not elide.
pub fn memzero(buf: &mut [u8]) {
    if buf.is_empty() {
        return;
    }
    // SAFETY: `buf` is a live, exclusively borrowed slice of exactly `len` bytes.
    unsafe { libsodium_sys::sodium_memzero(buf.as_mut_ptr().cast(), buf.len()) }
}

/// Constant-time equality. Chapter 01 §1.4.1 compares verifiers with this.
///
/// libsodium's `sodium_memcmp` requires both sides to be the same length, so an
/// unequal length is answered before the call rather than by it.
pub fn memcmp(a: &[u8], b: &[u8]) -> bool {
    init();
    if a.len() != b.len() {
        return false;
    }
    if a.is_empty() {
        return true;
    }
    // SAFETY: both pointers are live for `a.len()` bytes, checked equal above.
    unsafe { libsodium_sys::sodium_memcmp(a.as_ptr().cast(), b.as_ptr().cast(), a.len()) == 0 }
}

/// Fills `buf` with cryptographically secure random bytes.
pub fn random_bytes(len: usize) -> Vec<u8> {
    init();
    let mut buf = vec![0u8; len];
    if len > 0 {
        // SAFETY: `buf` is a live allocation of exactly `len` bytes.
        unsafe { libsodium_sys::randombytes_buf(buf.as_mut_ptr().cast(), len) }
    }
    buf
}

/// Argon2id password hashing, chapter 01 §1.1.
///
/// `crypto_pwhash` returns -1 for two very different reasons: the parameters
/// were rejected, or the allocation of `memlimit` bytes failed. At 64 MiB on a
/// memory-pressured phone the second is real, and reporting it as "wrong
/// recovery phrase" tells the user to re-type a phrase that was correct
/// (research R3, spike S4). The two are separated here by checking the
/// parameters before the call, so a -1 that survives the check is an allocation
/// failure.
pub fn pwhash_argon2id(
    out_len: usize,
    password: &[u8],
    salt: &[u8],
    ops_limit: u64,
    mem_limit: usize,
) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    init();

    let salt_len = unsafe { libsodium_sys::crypto_pwhash_saltbytes() };
    if salt.len() != salt_len {
        return Err(CryptoError::InvalidLength {
            what: "argon2id salt".into(),
            expected: salt_len as u64,
            actual: salt.len() as u64,
        });
    }
    // SAFETY: all four are argument-less constant accessors.
    let (min_out, min_ops, min_mem) = unsafe {
        (
            libsodium_sys::crypto_pwhash_bytes_min(),
            libsodium_sys::crypto_pwhash_opslimit_min() as u64,
            libsodium_sys::crypto_pwhash_memlimit_min(),
        )
    };
    if out_len < min_out || ops_limit < min_ops || mem_limit < min_mem {
        return Err(CryptoError::InvalidParameter {
            what: "argon2id parameters below libsodium minimums".into(),
        });
    }

    let mut out = Zeroizing::new(vec![0u8; out_len]);
    // SAFETY: `out` holds `out_len` bytes, `password` and `salt` are live for
    // their lengths, and the algorithm constant is libsodium's own.
    let rc = unsafe {
        libsodium_sys::crypto_pwhash(
            out.as_mut_ptr(),
            out_len as u64,
            password.as_ptr().cast(),
            password.len() as u64,
            salt.as_ptr(),
            ops_limit,
            mem_limit,
            libsodium_sys::crypto_pwhash_ALG_ARGON2ID13 as i32,
        )
    };
    if rc != 0 {
        // Parameters were validated above, so the only remaining documented
        // cause is a failed allocation of `mem_limit` bytes.
        return Err(CryptoError::OutOfMemory {
            requested_bytes: mem_limit as u64,
        });
    }
    Ok(out)
}

/// `crypto_kdf_derive_from_key`, chapter 01 §1.2.
///
/// `context` is the eight-byte `ctx` column of the KDF table, not the logical
/// name. BLAKE2b-based, not HKDF-SHA256 (§1.2).
pub fn kdf_derive_from_key(
    out_len: usize,
    subkey_id: u64,
    context: &[u8; 8],
    key: &[u8],
) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    init();
    let key_len = unsafe { libsodium_sys::crypto_kdf_keybytes() };
    if key.len() != key_len {
        return Err(CryptoError::InvalidLength {
            what: "kdf master key".into(),
            expected: key_len as u64,
            actual: key.len() as u64,
        });
    }
    let mut out = Zeroizing::new(vec![0u8; out_len]);
    // SAFETY: `out` holds `out_len` bytes; `context` is exactly 8 bytes by type;
    // `key` length was checked against libsodium's own constant.
    let rc = unsafe {
        libsodium_sys::crypto_kdf_derive_from_key(
            out.as_mut_ptr(),
            out_len,
            subkey_id,
            context.as_ptr().cast(),
            key.as_ptr(),
        )
    };
    if rc != 0 {
        return Err(CryptoError::InvalidParameter {
            what: "crypto_kdf_derive_from_key rejected its arguments".into(),
        });
    }
    Ok(out)
}

/// Keyed or unkeyed BLAKE2b. `key = None` is the unkeyed form used for the
/// locally derived device id (chapter 01 §1.5).
pub fn generichash(
    out_len: usize,
    message: &[u8],
    key: Option<&[u8]>,
) -> Result<Vec<u8>, CryptoError> {
    init();
    let mut out = vec![0u8; out_len];
    let (key_ptr, key_len) = match key {
        Some(k) => (k.as_ptr(), k.len()),
        None => (std::ptr::null(), 0usize),
    };
    // SAFETY: `out` holds `out_len` bytes, `message` is live for its length, and
    // a null key pointer with length 0 is libsodium's documented unkeyed form.
    let rc = unsafe {
        libsodium_sys::crypto_generichash(
            out.as_mut_ptr(),
            out_len,
            message.as_ptr(),
            message.len() as u64,
            key_ptr,
            key_len,
        )
    };
    if rc != 0 {
        return Err(CryptoError::InvalidParameter {
            what: "crypto_generichash rejected its arguments".into(),
        });
    }
    Ok(out)
}

/// XChaCha20-Poly1305-IETF encryption, chapter 04 §4.3.
///
/// The tag is appended to the ciphertext, so the result is `plaintext.len() + 16`.
/// `associated_data` is `None` for every call this protocol makes.
pub fn aead_encrypt(
    plaintext: &[u8],
    associated_data: Option<&[u8]>,
    nonce: &[u8],
    key: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    init();
    check_aead_lengths(nonce, key)?;
    let abytes = unsafe { libsodium_sys::crypto_aead_xchacha20poly1305_ietf_abytes() };
    let mut out = vec![0u8; plaintext.len() + abytes];
    let mut out_len: u64 = 0;
    let (ad_ptr, ad_len) = optional_slice(associated_data);
    // SAFETY: `out` is sized for plaintext plus tag; nonce and key lengths were
    // checked against libsodium's constants; a null AD pointer with length 0 is
    // the documented "no associated data" form.
    let rc = unsafe {
        libsodium_sys::crypto_aead_xchacha20poly1305_ietf_encrypt(
            out.as_mut_ptr(),
            &mut out_len,
            plaintext.as_ptr(),
            plaintext.len() as u64,
            ad_ptr,
            ad_len,
            std::ptr::null(),
            nonce.as_ptr(),
            key.as_ptr(),
        )
    };
    if rc != 0 {
        return Err(CryptoError::EncryptionFailed);
    }
    out.truncate(out_len as usize);
    Ok(out)
}

/// XChaCha20-Poly1305-IETF decryption, chapter 04 §4.3.
///
/// A failure here is authentication failure and carries no detail, because the
/// only information a caller could act on is "these bytes are not ours".
pub fn aead_decrypt(
    ciphertext: &[u8],
    associated_data: Option<&[u8]>,
    nonce: &[u8],
    key: &[u8],
) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    init();
    check_aead_lengths(nonce, key)?;
    let abytes = unsafe { libsodium_sys::crypto_aead_xchacha20poly1305_ietf_abytes() };
    if ciphertext.len() < abytes {
        return Err(CryptoError::DecryptionFailed);
    }
    let mut out = Zeroizing::new(vec![0u8; ciphertext.len() - abytes]);
    let mut out_len: u64 = 0;
    let (ad_ptr, ad_len) = optional_slice(associated_data);
    // SAFETY: `out` is sized for ciphertext minus tag, checked non-negative
    // above; nonce and key lengths were checked against libsodium's constants.
    let rc = unsafe {
        libsodium_sys::crypto_aead_xchacha20poly1305_ietf_decrypt(
            out.as_mut_ptr(),
            &mut out_len,
            std::ptr::null_mut(),
            ciphertext.as_ptr(),
            ciphertext.len() as u64,
            ad_ptr,
            ad_len,
            nonce.as_ptr(),
            key.as_ptr(),
        )
    };
    if rc != 0 {
        return Err(CryptoError::DecryptionFailed);
    }
    out.truncate(out_len as usize);
    Ok(out)
}

fn optional_slice(value: Option<&[u8]>) -> (*const u8, u64) {
    match value {
        Some(v) if !v.is_empty() => (v.as_ptr(), v.len() as u64),
        _ => (std::ptr::null(), 0),
    }
}

fn check_aead_lengths(nonce: &[u8], key: &[u8]) -> Result<(), CryptoError> {
    // SAFETY: both are argument-less constant accessors.
    let (npub, keybytes) = unsafe {
        (
            libsodium_sys::crypto_aead_xchacha20poly1305_ietf_npubbytes(),
            libsodium_sys::crypto_aead_xchacha20poly1305_ietf_keybytes(),
        )
    };
    if nonce.len() != npub {
        return Err(CryptoError::InvalidLength {
            what: "aead nonce".into(),
            expected: npub as u64,
            actual: nonce.len() as u64,
        });
    }
    if key.len() != keybytes {
        return Err(CryptoError::InvalidLength {
            what: "aead key".into(),
            expected: keybytes as u64,
            actual: key.len() as u64,
        });
    }
    Ok(())
}

/// Ed25519 keypair from a 32-byte seed. Used only by vectors and tests: a real
/// device signing key is random, not seeded (chapter 01 §1.5).
pub fn sign_seed_keypair(seed: &[u8]) -> Result<(Vec<u8>, Zeroizing<Vec<u8>>), CryptoError> {
    init();
    let seed_len = unsafe { libsodium_sys::crypto_sign_seedbytes() };
    if seed.len() != seed_len {
        return Err(CryptoError::InvalidLength {
            what: "ed25519 seed".into(),
            expected: seed_len as u64,
            actual: seed.len() as u64,
        });
    }
    let pk_len = unsafe { libsodium_sys::crypto_sign_publickeybytes() };
    let sk_len = unsafe { libsodium_sys::crypto_sign_secretkeybytes() };
    let mut pk = vec![0u8; pk_len];
    let mut sk = Zeroizing::new(vec![0u8; sk_len]);
    // SAFETY: all three buffers are sized from libsodium's own constants.
    let rc = unsafe {
        libsodium_sys::crypto_sign_seed_keypair(pk.as_mut_ptr(), sk.as_mut_ptr(), seed.as_ptr())
    };
    if rc != 0 {
        return Err(CryptoError::InvalidParameter {
            what: "crypto_sign_seed_keypair failed".into(),
        });
    }
    Ok((pk, sk))
}

/// A fresh random Ed25519 pair. This is what a device registration uses
/// (chapter 01 §1.5): the signing key is random, never derived.
pub fn sign_keypair() -> Result<(Vec<u8>, Zeroizing<Vec<u8>>), CryptoError> {
    init();
    let pk_len = unsafe { libsodium_sys::crypto_sign_publickeybytes() };
    let sk_len = unsafe { libsodium_sys::crypto_sign_secretkeybytes() };
    let mut pk = vec![0u8; pk_len];
    let mut sk = Zeroizing::new(vec![0u8; sk_len]);
    // SAFETY: both buffers are sized from libsodium's own constants.
    let rc = unsafe { libsodium_sys::crypto_sign_keypair(pk.as_mut_ptr(), sk.as_mut_ptr()) };
    if rc != 0 {
        return Err(CryptoError::InvalidParameter {
            what: "crypto_sign_keypair failed".into(),
        });
    }
    Ok((pk, sk))
}

/// Detached Ed25519 signature, 64 bytes (chapter 01 §1.5).
pub fn sign_detached(message: &[u8], secret_key: &[u8]) -> Result<Vec<u8>, CryptoError> {
    init();
    let sk_len = unsafe { libsodium_sys::crypto_sign_secretkeybytes() };
    if secret_key.len() != sk_len {
        return Err(CryptoError::InvalidLength {
            what: "ed25519 secret key".into(),
            expected: sk_len as u64,
            actual: secret_key.len() as u64,
        });
    }
    let sig_len = unsafe { libsodium_sys::crypto_sign_bytes() };
    let mut sig = vec![0u8; sig_len];
    let mut written: u64 = 0;
    // SAFETY: `sig` is sized from libsodium's constant and the key length was
    // checked against it.
    let rc = unsafe {
        libsodium_sys::crypto_sign_detached(
            sig.as_mut_ptr(),
            &mut written,
            message.as_ptr(),
            message.len() as u64,
            secret_key.as_ptr(),
        )
    };
    if rc != 0 {
        return Err(CryptoError::InvalidParameter {
            what: "crypto_sign_detached failed".into(),
        });
    }
    sig.truncate(written as usize);
    Ok(sig)
}

/// Verifies a detached Ed25519 signature. A wrong length is `false`, never an
/// error, because a caller can do nothing different with the distinction.
pub fn sign_verify_detached(signature: &[u8], message: &[u8], public_key: &[u8]) -> bool {
    init();
    // SAFETY: both are argument-less constant accessors.
    let (sig_len, pk_len) = unsafe {
        (
            libsodium_sys::crypto_sign_bytes(),
            libsodium_sys::crypto_sign_publickeybytes(),
        )
    };
    if signature.len() != sig_len || public_key.len() != pk_len {
        return false;
    }
    // SAFETY: both lengths were checked against libsodium's constants and
    // `message` is live for its length.
    unsafe {
        libsodium_sys::crypto_sign_verify_detached(
            signature.as_ptr(),
            message.as_ptr(),
            message.len() as u64,
            public_key.as_ptr(),
        ) == 0
    }
}

/// `crypto_auth`, HMAC-SHA512-256. The linking MAC families (chapter 03).
pub fn auth(message: &[u8], key: &[u8]) -> Result<Vec<u8>, CryptoError> {
    init();
    let key_len = unsafe { libsodium_sys::crypto_auth_keybytes() };
    if key.len() != key_len {
        return Err(CryptoError::InvalidLength {
            what: "crypto_auth key".into(),
            expected: key_len as u64,
            actual: key.len() as u64,
        });
    }
    let out_len = unsafe { libsodium_sys::crypto_auth_bytes() };
    let mut out = vec![0u8; out_len];
    // SAFETY: `out` is sized from libsodium's constant and the key length was
    // checked against it.
    let rc = unsafe {
        libsodium_sys::crypto_auth(
            out.as_mut_ptr(),
            message.as_ptr(),
            message.len() as u64,
            key.as_ptr(),
        )
    };
    if rc != 0 {
        return Err(CryptoError::InvalidParameter {
            what: "crypto_auth failed".into(),
        });
    }
    Ok(out)
}

/// `crypto_auth_hmacsha256`, the scan channel's MAC (chapter 03 §3.7).
///
/// A separate function from [`auth`] rather than a parameter, because the two
/// are different primitives serving different channels: `crypto_auth` is
/// HMAC-SHA512-256 and this is HMAC-SHA-256. Conflating them would let a
/// caller reach the wrong channel's tag by passing the wrong flag.
///
/// Unlike `crypto_auth`, libsodium's HMAC-SHA-256 accepts a key of any length
/// and folds it per RFC 2104, so there is no length to check here.
pub fn auth_hmacsha256(message: &[u8], key: &[u8]) -> Result<Vec<u8>, CryptoError> {
    init();
    let out_len = unsafe { libsodium_sys::crypto_auth_hmacsha256_bytes() };
    let mut out = vec![0u8; out_len];
    let mut state = std::mem::MaybeUninit::<libsodium_sys::crypto_auth_hmacsha256_state>::uninit();
    // SAFETY: `out` is sized from libsodium's own constant, and the state is
    // initialised by `_init` before either later call reads it. The keyed-init
    // form is used rather than the one-shot `crypto_auth_hmacsha256`, because
    // only this one accepts a key that is not exactly `KEYBYTES`.
    let rc = unsafe {
        let init_rc =
            libsodium_sys::crypto_auth_hmacsha256_init(state.as_mut_ptr(), key.as_ptr(), key.len());
        if init_rc != 0 {
            init_rc
        } else {
            let mut state = state.assume_init();
            let update_rc = libsodium_sys::crypto_auth_hmacsha256_update(
                &mut state,
                message.as_ptr(),
                message.len() as u64,
            );
            if update_rc != 0 {
                update_rc
            } else {
                libsodium_sys::crypto_auth_hmacsha256_final(&mut state, out.as_mut_ptr())
            }
        }
    };
    if rc != 0 {
        return Err(CryptoError::InvalidParameter {
            what: "crypto_auth_hmacsha256 failed".into(),
        });
    }
    Ok(out)
}

/// X25519 public key from a scalar (chapter 03).
pub fn scalarmult_base(scalar: &[u8]) -> Result<Vec<u8>, CryptoError> {
    init();
    let n = unsafe { libsodium_sys::crypto_scalarmult_scalarbytes() };
    if scalar.len() != n {
        return Err(CryptoError::InvalidLength {
            what: "x25519 scalar".into(),
            expected: n as u64,
            actual: scalar.len() as u64,
        });
    }
    let out_len = unsafe { libsodium_sys::crypto_scalarmult_bytes() };
    let mut out = vec![0u8; out_len];
    // SAFETY: `out` is sized from libsodium's constant, scalar length checked.
    let rc = unsafe { libsodium_sys::crypto_scalarmult_base(out.as_mut_ptr(), scalar.as_ptr()) };
    if rc != 0 {
        return Err(CryptoError::InvalidParameter {
            what: "crypto_scalarmult_base failed".into(),
        });
    }
    Ok(out)
}

/// X25519 shared secret (chapter 03). A non-zero return is an all-zero output
/// point, which libsodium refuses and which a caller must not use.
pub fn scalarmult(scalar: &[u8], point: &[u8]) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    init();
    let out_len = unsafe { libsodium_sys::crypto_scalarmult_bytes() };
    let mut out = Zeroizing::new(vec![0u8; out_len]);
    // SAFETY: `out` is sized from libsodium's constant; libsodium validates the
    // scalar and point lengths implicitly by consuming fixed-size buffers, so
    // both are checked here first.
    let n = unsafe { libsodium_sys::crypto_scalarmult_scalarbytes() };
    if scalar.len() != n || point.len() != out_len {
        return Err(CryptoError::InvalidParameter {
            what: "x25519 scalar or point length".into(),
        });
    }
    let rc = unsafe {
        libsodium_sys::crypto_scalarmult(out.as_mut_ptr(), scalar.as_ptr(), point.as_ptr())
    };
    if rc != 0 {
        return Err(CryptoError::InvalidParameter {
            what: "crypto_scalarmult rejected a low-order point".into(),
        });
    }
    Ok(out)
}
