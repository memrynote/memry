//! The local fold (`engine.ts`): a note's Markdown to the snapshot the renderer shows. Pure;
//! [`super::service`] owns the cache and the reads.

use crate::web::extract::utils::js::is_js_whitespace;

use super::sections::{ParsedChunk, ParsedParagraph, ParsedSection, build_sections};
use super::text::{count_words, detect_language, is_cjk, is_foldable, sha256, step, word_segments};
use super::tokens::{Zone, expand_inline_tokens, without_inline_tokens};
use super::{FoldLayers, FoldParagraph, FoldSection, LevelWords};

/// A note read and cut up, before any level is resolved.
pub struct Prepared {
    pub language: String,
    /// The note with its inline date and link tokens replaced by the text a reader sees.
    pub source: String,
    /// Empty when the note does not fold.
    pub sections: Vec<ParsedSection>,
}

/// What `fold-service.ts` `get` does before any level: the language (tokens blanked so their
/// payload never skews it), the tokens expanded, and sections only for a note past the
/// threshold.
pub fn prepare(markdown: &str, zone: Zone) -> Prepared {
    let language = detect_language(&without_inline_tokens(markdown));
    let source = expand_inline_tokens(markdown, &language, zone);
    let sections = if is_foldable(&source, &language) {
        build_sections(&source, &language)
    } else {
        Vec::new()
    };
    Prepared {
        language,
        source,
        sections,
    }
}

/// The first or most claim-like sentence (`localBriefIdx`). Deterministic, language-neutral.
pub fn local_brief_idx(sentences: &[String], language: &str) -> Vec<u32> {
    if sentences.is_empty() {
        return Vec::new();
    }
    let (lo, hi) = if is_cjk(language) { (8, 60) } else { (6, 30) };
    let mut best = 0;
    let mut best_score = f64::NEG_INFINITY;
    for (i, s) in sentences.iter().enumerate() {
        let words = count_words(s, language);
        let question = s.trim_end_matches(is_js_whitespace).ends_with(['?', '？']);
        let score = if i == 0 { 2.0 } else { 0.0 }
            + if question { -2.0 } else { 0.0 }
            + if (lo..=hi).contains(&words) { 1.0 } else { 0.0 }
            + if s.bytes().any(|b| b.is_ascii_digit()) {
                0.5
            } else {
                0.0
            };
        if score > best_score {
            best = i;
            best_score = score;
        }
    }
    vec![best as u32]
}

/// The local Brief of a chunk: one pick per paragraph.
pub fn local_brief(chunk: &ParsedChunk, language: &str) -> Vec<Vec<u32>> {
    chunk
        .paragraphs
        .iter()
        .map(|p| local_brief_idx(&p.sentences, language))
        .collect()
}

/// The word segments of a paragraph and where each sentence starts among them
/// (`buildMorph`'s `srcTokens` and `srcSentenceStart`).
fn source_tokens(text: &str, sentences: &[String]) -> (Vec<String>, Vec<u32>) {
    let src = word_segments(text);
    let mut starts = Vec::with_capacity(sentences.len());
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
        starts.push(token as u32);
        // A sentence that is not in the text (never, as both come from it) moves nothing: past
        // its length the cursor could leave the text or split a character.
        if found.is_some() {
            cursor = offset + s.len();
        }
    }
    (src.iter().map(|s| s.text.to_owned()).collect(), starts)
}

fn paragraph(p: &ParsedParagraph, brief_idx: Vec<u32>) -> FoldParagraph {
    let (src_tokens, src_sentence_start) = source_tokens(&p.text, &p.sentences);
    FoldParagraph {
        hash: p.hash.clone(),
        text: p.text.clone(),
        sentences: p.sentences.clone(),
        sentences_md: p.sentences_md.clone(),
        src_tokens,
        src_sentence_start,
        brief_idx,
    }
}

/// Words Brief shows: the picked sentences of every paragraph.
fn brief_words(sections: &[FoldSection], language: &str) -> u32 {
    let mut total = 0;
    for p in sections.iter().flat_map(|s| &s.paragraphs) {
        for &i in &p.brief_idx {
            total += p
                .sentences
                .get(i as usize)
                .map_or(0, |s| count_words(s, language));
        }
    }
    total
}

/// The snapshot (`assemble`), each chunk's Brief from `brief`.
pub fn assemble(
    note_id: &str,
    prepared: &Prepared,
    mut brief: impl FnMut(&ParsedChunk) -> Vec<Vec<u32>>,
) -> FoldLayers {
    let language = &prepared.language;
    let sections: Vec<FoldSection> = prepared
        .sections
        .iter()
        .map(|section| {
            let mut paragraphs = Vec::new();
            for chunk in &section.chunks {
                let picks = brief(chunk);
                for (i, p) in chunk.paragraphs.iter().enumerate() {
                    paragraphs.push(paragraph(p, picks.get(i).cloned().unwrap_or_default()));
                }
            }
            let mut parts = vec![section.heading.as_deref().unwrap_or("")];
            parts.extend(section.chunks.iter().map(|c| c.hash.as_str()));
            FoldSection {
                hash: sha256(&parts.join("\u{0}")),
                heading: section.heading.clone(),
                paragraphs,
                skipped: section.skipped.clone(),
            }
        })
        .collect();
    let total_words = count_words(&prepared.source, language);
    FoldLayers {
        note_id: note_id.to_owned(),
        source_hash: sha256(&prepared.source),
        language: language.clone(),
        total_words,
        words_by_level: LevelWords {
            full: total_words,
            brief: brief_words(&sections, language),
        },
        foldable: !sections.is_empty(),
        sections,
    }
}
