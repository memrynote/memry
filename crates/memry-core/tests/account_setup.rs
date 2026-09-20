//! First-device setup: the phrase a phone generates, and the key it derives.
//!
//! What these hold is the one property the whole flow rests on: the phrase
//! shown to a user and the phrase that user types back a week later must reach
//! the same master key, or the account is unrecoverable and nobody finds out
//! until it matters.

use memry_core::api::crypto::{
    account_key_verifier, account_key_verifier_matches, derive_master_key, generate_kdf_salt,
    generate_recovery_phrase, validate_recovery_phrase,
};

#[test]
fn a_generated_phrase_is_twenty_four_valid_words() {
    let phrase = generate_recovery_phrase();
    let words: Vec<&str> = phrase.split(' ').collect();

    assert_eq!(words.len(), 24, "the product issues 24-word phrases: {phrase}");
    // The canonical form: nothing to normalise, because it is already
    // normalised. A phrase that needed trimming would reach a different seed
    // than the one the user types back.
    assert_eq!(
        validate_recovery_phrase(phrase.clone()).expect("a generated phrase validates"),
        phrase
    );
}

#[test]
fn two_generated_phrases_differ() {
    // A generator wired to a constant would pass every other test in this file
    // and hand every account the same key.
    assert_ne!(generate_recovery_phrase(), generate_recovery_phrase());
}

#[test]
fn the_salt_is_the_length_derivation_requires() {
    let salt = generate_kdf_salt();
    assert_eq!(salt.len(), 16, "chapter 01 §1.1 fixes the salt at 16 bytes");
    assert_ne!(salt, generate_kdf_salt(), "a salt is generated, not fixed");
}

#[test]
fn the_phrase_and_salt_round_trip_to_one_master_key() {
    let phrase = generate_recovery_phrase();
    let salt = generate_kdf_salt();

    let first = derive_master_key(phrase.clone(), salt.clone()).expect("derive");
    // The same phrase typed back, the way a user types it: different case, and
    // whitespace that is not a single space.
    let retyped = format!("  {}  ", phrase.to_uppercase().replace(' ', "\n"));
    let second = derive_master_key(retyped, salt.clone()).expect("derive from a retyped phrase");

    assert_eq!(first, second, "normalisation is what makes recovery possible");

    let verifier = account_key_verifier(first).expect("verifier");
    let from_second = account_key_verifier(second).expect("verifier");
    assert!(
        account_key_verifier_matches(verifier, from_second),
        "the verifier published at setup is the one unlock compares against"
    );
}

#[test]
fn a_different_salt_is_a_different_key() {
    // The salt is published with the account precisely because it must be the
    // account's; deriving under a fresh one would strand every existing record.
    let phrase = generate_recovery_phrase();
    let first = derive_master_key(phrase.clone(), generate_kdf_salt()).expect("derive");
    let second = derive_master_key(phrase, generate_kdf_salt()).expect("derive");
    assert_ne!(first, second);
}
