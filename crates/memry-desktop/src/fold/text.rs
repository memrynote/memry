//! Language, sentences and words of a note (`engine.ts` `detectLanguage`, `splitSentences`,
//! `countWords`, `estimateTokens`, `isFoldable`). Electron segments with `Intl.Segmenter`;
//! here the UAX #29 boundaries of `unicode-segmentation` stand in, which agree on the
//! sentences and on the word count of the vectors (`tests/note_fold_text_vectors.rs`), but for
//! a Han run in a text read as neither Chinese, Japanese nor Korean: ICU splits it with its
//! dictionary, UAX #29 into single ideographs, so such a text counts more words here.

use std::sync::LazyLock;

use crate::web::extract::utils::js::{is_js_whitespace, trim as js_trim};
use regex::Regex;
use sha2::{Digest, Sha256};
use unicode_segmentation::UnicodeSegmentation;

use super::FOLD_MIN_WORDS;

/// CJK counts characters, not words: the fold threshold in that unit (`CJK_MIN_UNITS`).
pub const CJK_MIN_UNITS: u32 = FOLD_MIN_WORDS * 2;

static LETTER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\p{L}$").expect("letter"));
static PUNCTUATION_OR_SYMBOL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[\p{P}\p{S}]$").expect("punctuation"));

pub fn sha256(text: &str) -> String {
    hex::encode(Sha256::digest(text.as_bytes()))
}

fn is_letter(c: char) -> bool {
    if c.is_ascii() {
        return c.is_ascii_alphabetic();
    }
    LETTER.is_match(c.encode_utf8(&mut [0; 4]))
}

/// Script-based tag: enough to pick a word budget, not a locale.
pub fn detect_language(text: &str) -> String {
    let (mut han, mut kana, mut hangul, mut cyrillic, mut arabic, mut letters) =
        (0u32, 0u32, 0u32, 0u32, 0u32, 0u32);
    for c in text.chars() {
        match u32::from(c) {
            0x3040..=0x30ff => kana += 1,
            0x4e00..=0x9fff | 0x3400..=0x4dbf => han += 1,
            0xac00..=0xd7af => hangul += 1,
            0x0400..=0x04ff => cyrillic += 1,
            0x0600..=0x06ff => arabic += 1,
            _ if is_letter(c) => letters += 1,
            _ => {}
        }
    }
    let total = f64::from(han + kana + hangul + cyrillic + arabic + letters);
    let share = |n: u32| f64::from(n) / total;
    let tag = if total == 0.0 {
        "und"
    } else if share(kana) > 0.1 {
        "ja"
    } else if share(hangul) > 0.3 {
        "ko"
    } else if share(han) > 0.3 {
        "zh"
    } else if share(cyrillic) > 0.5 {
        "ru"
    } else if share(arabic) > 0.5 {
        "ar"
    } else {
        "en"
    };
    tag.to_owned()
}

pub fn is_cjk(language: &str) -> bool {
    matches!(language, "zh" | "ja" | "ko")
}

/// The sentences of `text`, trimmed, the empty ones dropped.
pub fn split_sentences(text: &str) -> Vec<String> {
    text.split_sentence_bounds()
        .map(js_trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}

/// One word segment: a word, or the spaces and punctuation between words.
pub struct Segment<'a> {
    pub text: &'a str,
    /// Byte offset in the segmented text.
    pub offset: usize,
    /// Holds a letter or a digit (`isWordLike`).
    pub word_like: bool,
}

pub fn word_segments(text: &str) -> Vec<Segment<'_>> {
    text.split_word_bound_indices()
        .map(|(offset, segment)| Segment {
            text: segment,
            offset,
            word_like: segment.chars().any(char::is_alphanumeric),
        })
        .collect()
}

/// Words for Latin-like scripts; characters that are neither space, punctuation nor symbol
/// for CJK.
pub fn count_words(text: &str, language: &str) -> u32 {
    let count = if is_cjk(language) {
        text.chars()
            .filter(|&c| {
                !is_js_whitespace(c) && !PUNCTUATION_OR_SYMBOL.is_match(c.encode_utf8(&mut [0; 4]))
            })
            .count()
    } else {
        word_segments(text).iter().filter(|s| s.word_like).count()
    };
    u32::try_from(count).unwrap_or(u32::MAX)
}

pub fn estimate_tokens(text: &str, language: &str) -> u32 {
    let words = count_words(text, language);
    if is_cjk(language) {
        words
    } else {
        (f64::from(words) * 1.4).ceil() as u32
    }
}

pub fn is_foldable(text: &str, language: &str) -> bool {
    let min = if is_cjk(language) {
        CJK_MIN_UNITS
    } else {
        FOLD_MIN_WORDS
    };
    count_words(text, language) > min
}
