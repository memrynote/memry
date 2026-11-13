//! The fold engine (`engine.ts`): a note's Markdown to the snapshot the renderer shows, with
//! the model lines a lookup finds and the local fallback where it finds none. Pure;
//! [`super::service`] owns the reads, the cache and the model runs.

use crate::web::extract::utils::js::is_js_whitespace;

use super::model::{ChunkAi, ChunkParagraphAi, level_words, truncate_units};
use super::morph::{MorphLines, build_morph};
use super::sections::{ParsedChunk, ParsedParagraph, ParsedSection, build_sections};
use super::text::{count_words, detect_language, is_cjk, is_foldable, sha256};
use super::tokens::{Zone, expand_inline_tokens, without_inline_tokens};
use super::{FoldLayers, FoldLevel, FoldParagraph, FoldSection, FoldStatus, LevelWords};

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

fn paragraph(p: &ParsedParagraph, ai: Option<&ChunkParagraphAi>, language: &str) -> FoldParagraph {
    let first = p.sentences.first().unwrap_or(&p.text);
    let key = ai.map(|ai| ai.key.clone());
    let takeaway = ai.map_or_else(
        || truncate_units(first, language, 12),
        |ai| ai.takeaway.clone(),
    );
    let topic = ai.map_or_else(|| truncate_units(first, language, 4), |ai| ai.topic.clone());
    // Derived from the cached model lines on every assemble: not stored, so an old cache row
    // needs no rewrite.
    let lines = MorphLines {
        key_takeaway: key.as_ref().map(|k| k.takeaway.as_str()),
        key_reason: key.as_ref().map(|k| k.reason.as_str()),
        takeaway: Some(&takeaway),
        topic: Some(&topic),
    };
    let morph = build_morph(&p.text, &p.sentences, &lines, language);
    FoldParagraph {
        hash: p.hash.clone(),
        text: p.text.clone(),
        sentences: p.sentences.clone(),
        sentences_md: p.sentences_md.clone(),
        src_tokens: morph.src_tokens,
        src_sentence_start: morph.src_sentence_start,
        morph: morph.morph,
        brief_idx: ai.map_or_else(
            || local_brief_idx(&p.sentences, language),
            |ai| ai.brief.clone(),
        ),
        key,
        takeaway,
        topic,
        evidence: ai.map(|ai| ai.evidence.clone()).unwrap_or_default(),
    }
}

/// The snapshot and the chunks no model has written for this text yet (`Assembled`).
pub struct Assembled<'a> {
    /// `status` reads `Short` and `agent` `None`: the service sets both.
    pub layers: FoldLayers,
    pub missing: Vec<&'a ParsedChunk>,
}

/// `assemble`: each chunk's model lines from `lookup`, the local fallback where it has none.
pub fn assemble<'a>(
    note_id: &str,
    prepared: &'a Prepared,
    mut lookup: impl FnMut(&ParsedChunk) -> Option<ChunkAi>,
) -> Assembled<'a> {
    let language = &prepared.language;
    let mut missing = Vec::new();
    let sections: Vec<FoldSection> = prepared
        .sections
        .iter()
        .map(|section| {
            let mut paragraphs = Vec::new();
            let mut takeaways = Vec::new();
            for chunk in &section.chunks {
                let ai = lookup(chunk);
                if ai.is_none() {
                    missing.push(chunk);
                }
                for (i, p) in chunk.paragraphs.iter().enumerate() {
                    let line = ai.as_ref().and_then(|ai| ai.paragraphs.get(i));
                    paragraphs.push(paragraph(p, line, language));
                }
                if let Some(ai) = ai {
                    takeaways.push(ai.section_takeaway);
                }
            }
            let fallback = paragraphs.first().map(|p| p.takeaway.clone());
            let mut parts = vec![section.heading.as_deref().unwrap_or("")];
            parts.extend(section.chunks.iter().map(|c| c.hash.as_str()));
            FoldSection {
                hash: sha256(&parts.join("\u{0}")),
                heading: section.heading.clone(),
                takeaway: if takeaways.len() == section.chunks.len() {
                    Some(takeaways.join(" "))
                } else {
                    fallback
                },
                paragraphs,
                skipped: section.skipped.clone(),
            }
        })
        .collect();
    let total_words = count_words(&prepared.source, language);
    let ready = if missing.is_empty() && !sections.is_empty() {
        vec![FoldLevel::Key, FoldLevel::Takeaway, FoldLevel::Topic]
    } else {
        Vec::new()
    };
    let words = |level| level_words(&sections, level, language);
    let words_by_level = LevelWords {
        full: total_words,
        brief: words(FoldLevel::Brief),
        key: words(FoldLevel::Key),
        takeaway: words(FoldLevel::Takeaway),
        topic: words(FoldLevel::Topic),
    };
    Assembled {
        layers: FoldLayers {
            note_id: note_id.to_owned(),
            source_hash: sha256(&prepared.source),
            language: language.clone(),
            total_words,
            words_by_level,
            sections,
            ready,
            status: FoldStatus::Short,
            agent: None,
        },
        missing,
    }
}
