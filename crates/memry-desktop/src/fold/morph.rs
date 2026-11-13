//! Word maps for the Brief to Key to Takeaway to Topic morph (`engine-morph.ts`): every word of
//! a model line that also occurs in the source paragraph points at its source word, so the
//! renderer can slide that word from where it sat. Matching is the in-order longest common
//! subsequence over normalized words, after the word alignment in github.com/chenxiachan/textfold
//! (textfold/tokens.py `norm`, `lcs_pairs`; Apache-2.0).

use std::sync::LazyLock;

use regex::Regex;
use unicode_normalization::UnicodeNormalization as _;

use super::text::{Segment, step, word_segments};
use super::{FoldMorph, FoldToken};

/// Above this many dp cells a paragraph is not mapped; its lines then fade instead of slide
/// (`MAX_LCS_CELLS`). It bounds the work a long model line over a long paragraph costs.
pub const MAX_LCS_CELLS: usize = 4_000_000;

/// A fallback line of more word segments than this is not mapped either. A divergence from
/// `engine-morph.ts`, which caps the cells only: a fallback line is a prefix of its paragraph
/// (its first 12 whitespace-split words, which need not be short), so the vault's own text
/// decides its length, and a long paragraph with few spaces would cost up to
/// [`MAX_LCS_CELLS`] for every few kilobytes of the note. With this cap a fallback line costs
/// at most this many steps per source segment. A model line keeps Electron's cap only.
pub const MAX_LINE_TOKENS: usize = 128;

static NOT_LETTER_OR_NUMBER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[^\p{L}\p{N}]").expect("not letter or number"));

/// What two words must share to count as the same word; `""` never matches (`normalizeToken`).
pub fn normalize_token(text: &str, language: &str) -> String {
    let lower = text.nfc().collect::<String>().to_lowercase();
    let mut word = NOT_LETTER_OR_NUMBER.replace_all(&lower, "").into_owned();
    // `w.length > 3` counts UTF-16 units.
    if language == "en"
        && word.encode_utf16().count() > 3
        && word.ends_with('s')
        && !word.ends_with("ss")
    {
        word.pop();
    }
    word
}

fn normalized(segments: &[Segment<'_>], language: &str) -> Vec<String> {
    segments
        .iter()
        .map(|s| {
            if s.word_like {
                normalize_token(s.text, language)
            } else {
                String::new()
            }
        })
        .collect()
}

/// The in-order common subsequence of two normalized word lists as index pairs; `""` never
/// matches (`lcsPairs`). Nothing past [`MAX_LCS_CELLS`].
fn lcs_pairs(a: &[String], b: &[String]) -> Vec<(usize, usize)> {
    let (n, m) = (a.len(), b.len());
    if n == 0 || m == 0 || (n + 1).saturating_mul(m + 1) > MAX_LCS_CELLS {
        return Vec::new();
    }
    let same = |i: usize, j: usize| !a[i].is_empty() && a[i] == b[j];
    let w = m + 1;
    // `Uint16Array`: the cap keeps the shorter list, and so every cell, under 2,000.
    let mut dp = vec![0u16; (n + 1) * w];
    for i in (0..n).rev() {
        step(m);
        for j in (0..m).rev() {
            dp[i * w + j] = if same(i, j) {
                dp[(i + 1) * w + j + 1] + 1
            } else {
                dp[(i + 1) * w + j].max(dp[i * w + j + 1])
            };
        }
    }
    let mut out = Vec::new();
    let (mut i, mut j) = (0, 0);
    while i < n && j < m {
        step(1);
        if same(i, j) {
            out.push((i, j));
            i += 1;
            j += 1;
        } else if dp[(i + 1) * w + j] >= dp[i * w + j + 1] {
            i += 1;
        } else {
            j += 1;
        }
    }
    out
}

/// A paragraph's word segments, where each sentence starts among them, and its line maps.
pub struct MorphSource {
    pub src_tokens: Vec<String>,
    /// Segment index where each sentence starts; a sentence ends where the next starts.
    pub src_sentence_start: Vec<u32>,
    pub morph: FoldMorph,
}

/// The lines a paragraph shows at Key, Takeaway and Topic (`MorphLines`).
pub struct MorphLines<'a> {
    pub key_takeaway: Option<&'a str>,
    pub key_reason: Option<&'a str>,
    pub takeaway: Option<&'a str>,
    pub topic: Option<&'a str>,
    /// Takeaway and Topic are the local fallback, not a model's lines: [`MAX_LINE_TOKENS`]
    /// applies to them.
    pub fallback: bool,
}

/// `buildMorph`.
pub fn build_morph(
    text: &str,
    sentences: &[String],
    lines: &MorphLines<'_>,
    language: &str,
) -> MorphSource {
    let src = word_segments(text);
    let src_norm = normalized(&src, language);

    let mut src_sentence_start = Vec::with_capacity(sentences.len());
    let mut cursor = 0;
    let mut token = 0;
    for s in sentences {
        let found = text[cursor..].find(s.as_str()).map(|at| cursor + at);
        let offset = found.unwrap_or(cursor);
        step(offset - cursor + s.len());
        while token + 1 < src.len() && src[token].offset < offset {
            step(1);
            token += 1;
        }
        src_sentence_start.push(token as u32);
        // A sentence that is not in the text (never, as both come from it) moves nothing: past
        // its length the cursor could leave the text or split a character.
        if found.is_some() {
            cursor = offset + s.len();
        }
    }

    let map = |line: Option<&str>, capped: bool| -> Option<Vec<FoldToken>> {
        let line = line?;
        let tokens = word_segments(line);
        let norm = normalized(&tokens, language);
        let capped = capped && norm.len() > MAX_LINE_TOKENS;
        let mut out: Vec<FoldToken> = tokens
            .iter()
            .map(|t| FoldToken {
                text: t.text.to_owned(),
                src: None,
            })
            .collect();
        if !capped {
            for (li, si) in lcs_pairs(&norm, &src_norm) {
                out[li].src = Some(si as u32);
            }
        }
        Some(out)
    };

    MorphSource {
        src_tokens: src.iter().map(|s| s.text.to_owned()).collect(),
        src_sentence_start,
        morph: FoldMorph {
            key_takeaway: map(lines.key_takeaway, false),
            key_reason: map(lines.key_reason, false),
            takeaway: map(lines.takeaway, lines.fallback),
            topic: map(lines.topic, lines.fallback),
        },
    }
}
