//! Note folding, the local levels (Electron's `main/note-fold/`): Full is the note as written,
//! Brief keeps the sentences of each paragraph that best carry it, picked from the note's own
//! text. A note of 150 words or fewer (300 characters in Chinese, Japanese and Korean) does not
//! fold. [`text`] reads a note's language, sentences and words; [`tokens`] turns its date and
//! link pills into the text a reader sees; [`engine`] turns a note's Markdown into the
//! snapshot the renderer shows; [`service::FoldService`] reads the note or day and folds it,
//! picking the Brief again on every run (no cache, as in Electron).
//!
//! The layered-summary idea follows github.com/chenxiachan/textfold (Apache-2.0); the code is
//! original.

pub mod engine;
pub mod inline;
pub mod sections;
pub mod service;
pub mod text;
pub mod tokens;

use serde::{Deserialize, Serialize};

/// Notes at or under this many words never fold (`FOLD_MIN_WORDS`).
pub const FOLD_MIN_WORDS: u32 = 150;

/// A level the reader can ask for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum FoldLevel {
    Full,
    Brief,
}

/// A note folded (`FoldLayers` of `@memry/contracts/note-fold`, its local levels).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FoldLayers {
    pub note_id: String,
    /// sha256 of the text this snapshot was built from.
    pub source_hash: String,
    /// Script-based tag (`en`, `ja`, `zh`, `ko`, `ru`, `ar`, `und`).
    pub language: String,
    pub total_words: u32,
    pub words_by_level: LevelWords,
    /// Empty when the note does not fold.
    pub sections: Vec<FoldSection>,
    /// Long enough to fold, with at least one paragraph.
    pub foldable: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LevelWords {
    pub full: u32,
    pub brief: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FoldSection {
    pub hash: String,
    pub heading: Option<String>,
    pub paragraphs: Vec<FoldParagraph>,
    /// Blocks left out of the paragraphs, in the order of the paragraph each follows.
    pub skipped: Vec<FoldSkipped>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FoldParagraph {
    /// sha256 of the NFC paragraph text.
    pub hash: String,
    pub text: String,
    pub sentences: Vec<String>,
    /// Inline Markdown per sentence, aligned 1:1 with `sentences`.
    pub sentences_md: Vec<String>,
    /// Word segments of `text`, spaces and punctuation included: their concatenation is `text`.
    pub src_tokens: Vec<String>,
    /// Index in the word segments where each sentence starts.
    pub src_sentence_start: Vec<u32>,
    /// Indices into `sentences` that make Brief.
    pub brief_idx: Vec<u32>,
}

/// A non-prose block the fold leaves out, for the one-line marker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FoldSkipped {
    /// Index in the section's paragraphs of the one it follows; -1 when it opens the section.
    pub after_paragraph: i32,
    pub kind: SkippedKind,
    pub count: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum SkippedKind {
    Code,
    Table,
    Image,
    Callout,
    Embed,
    Other,
}
