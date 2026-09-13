//! The recovery phrase, chapter 01 §1.3.
//!
//! Five normalisation steps, then validation, then derivation — and derivation
//! never runs on a phrase that failed validation. The five steps change nothing
//! for a phrase Memry issued, which is the point: they exist so that a phrase a
//! user re-typed by hand reaches the same master key.

use bip39::{Language, Mnemonic};
use zeroize::Zeroizing;

use crate::api::errors::RecoveryError;

/// The product issues 24-word phrases and accepts nothing else.
///
/// A 12-word phrase is valid BIP-39 and MUST still be rejected: accepting it
/// halves the entropy silently, which is worse than refusing it loudly.
pub const REQUIRED_WORD_COUNT: usize = 24;

/// The five normalisation steps of chapter 01 §1.3, in order.
///
/// Two traps this handles, both named in the chapter:
///
/// - JavaScript's `\s` is Unicode `White_Space` **plus U+FEFF**, while Rust's
///   `char::is_whitespace` is `White_Space` without it. The whitespace class
///   here is "`White_Space` or U+FEFF", so a pasted phrase carrying a byte-order
///   mark normalises the same way it does on desktop.
/// - Lowercasing is **ASCII only**. A Unicode lowercase pass invites locale
///   surprises and buys nothing, because no non-ASCII phrase survives
///   validation anyway.
///
/// NFKD normalisation is step one and is supplied by the BIP-39 layer's own
/// `parse_normalized` contract; this function performs steps two through four
/// and leaves the input otherwise untouched.
pub fn normalize_phrase(input: &str) -> String {
    let is_space = |c: char| c.is_whitespace() || c == '\u{FEFF}';
    input
        .split(is_space)
        .filter(|part| !part.is_empty())
        .map(|part| part.to_ascii_lowercase())
        .collect::<Vec<_>>()
        .join(" ")
}

/// Normalises and validates a phrase, returning the canonical form.
///
/// Step five of §1.3: reject unless the result is a valid 24-word English BIP-39
/// mnemonic with a correct checksum. "Not in the wordlist" and "checksum failed"
/// stay distinct, because they call for different instructions to the user.
pub fn validate_phrase(input: &str) -> Result<String, RecoveryError> {
    let normalized = normalize_phrase(input);

    if !normalized.is_ascii() {
        return Err(RecoveryError::NonAscii);
    }

    let words: Vec<&str> = normalized.split(' ').filter(|w| !w.is_empty()).collect();
    if words.len() != REQUIRED_WORD_COUNT {
        return Err(RecoveryError::WrongWordCount {
            actual: words.len() as u64,
        });
    }

    match Mnemonic::parse_in_normalized(Language::English, &normalized) {
        Ok(_) => Ok(normalized),
        Err(bip39::Error::UnknownWord(index)) => Err(RecoveryError::UnknownWord {
            word: words.get(index).copied().unwrap_or_default().to_string(),
        }),
        Err(bip39::Error::InvalidChecksum) => Err(RecoveryError::BadChecksum),
        Err(bip39::Error::BadWordCount(count)) => Err(RecoveryError::WrongWordCount {
            actual: count as u64,
        }),
        Err(_) => Err(RecoveryError::BadChecksum),
    }
}

/// Phrase to 64-byte seed, chapter 01 §1.1 step one.
///
/// PBKDF2-HMAC-SHA512, 2048 iterations, the literal ASCII salt `mnemonic`, and
/// an **empty** passphrase — Memry has never used a BIP-39 passphrase, so
/// nothing appends to the salt. The seed is `Zeroizing` because it is the only
/// input to the Argon2id pass that produces the master key.
pub fn phrase_to_seed(input: &str) -> Result<Zeroizing<[u8; 64]>, RecoveryError> {
    let normalized = validate_phrase(input)?;
    // `validate_phrase` already proved this parses; the chapter's rule is that
    // derivation never runs on an unvalidated phrase, and this ordering is how
    // that rule is enforced rather than asserted.
    let mnemonic = Mnemonic::parse_in_normalized(Language::English, &normalized)
        .map_err(|_| RecoveryError::BadChecksum)?;
    Ok(Zeroizing::new(mnemonic.to_seed_normalized("")))
}
