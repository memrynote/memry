//! The word every placeholder of the seed's text masks carries, drawn once per
//! process (`packages/shared/src/mask-word.ts`).
//!
//! A mask hides a construct behind a placeholder before the parse and swaps it
//! back after, so a note whose own text spells a placeholder would have that
//! text eaten or swapped for a construct. With a word the note cannot know,
//! no text spells one. A placeholder never leaves the process that made it.

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher as _, Hasher as _};
use std::sync::OnceLock;

/// Twelve capital letters, as desktop's word is.
pub(super) fn mask_word() -> &'static str {
    static WORD: OnceLock<String> = OnceLock::new();
    WORD.get_or_init(|| {
        let mut bits = RandomState::new().build_hasher().finish();
        (0..12)
            .map(|_| {
                let letter = char::from(b'A' + (bits % 26) as u8);
                bits /= 26;
                letter
            })
            .collect()
    })
}

#[cfg(test)]
mod tests {
    use super::mask_word;

    #[test]
    fn the_word_is_twelve_capitals_and_stays_the_same() {
        let word = mask_word();
        assert_eq!(word.len(), 12);
        assert!(word.bytes().all(|b| b.is_ascii_uppercase()));
        assert_eq!(word, mask_word());
    }
}
