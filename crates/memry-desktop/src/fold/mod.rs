//! Note folding, the local levels (Electron's `main/note-fold/`): Full is the note as written,
//! Brief keeps the sentences of each paragraph that best carry it, picked from the note's own
//! text. A note of 150 words or fewer (300 characters in Chinese, Japanese and Korean) does not
//! fold. [`text`] reads a note's language, sentences and words; [`tokens`] turns its date and
//! link pills into the text a reader sees.
//!
//! The layered-summary idea follows github.com/chenxiachan/textfold (Apache-2.0); the code is
//! original.

pub mod text;
pub mod tokens;

/// Notes at or under this many words never fold (`FOLD_MIN_WORDS`).
pub const FOLD_MIN_WORDS: u32 = 150;
