//! Note folding (Electron's `main/note-fold/`): Full is the note as written, Brief keeps the
//! sentences of each paragraph that best carry it, and Key, Takeaway and Topic are lines a model
//! writes. A note of 150 words or fewer (300 characters in Chinese, Japanese and Korean) does
//! not fold. [`text`] reads a note's language, sentences and words; [`tokens`] turns its date
//! and link pills into the text a reader sees; [`engine`] turns a note's Markdown into the
//! snapshot the renderer shows; [`model`] is the contract with the model and [`morph`] maps its
//! words onto the source; [`service::FoldService`] reads the note or day, folds it, and queues
//! the chunks no model has written yet.
//!
//! The layered-summary idea follows github.com/chenxiachan/textfold (Apache-2.0); the code is
//! original.

pub mod agent;
pub mod engine;
pub mod inline;
pub mod model;
pub mod morph;
pub mod queue;
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
    Key,
    Takeaway,
    Topic,
}

/// What the settings row shows for a note (`FoldLayers.status`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum FoldStatus {
    Off,
    Short,
    NoAgent,
    Writing,
    Ready,
    Failed,
}

/// A note folded (`FoldLayers` of `@memry/contracts/note-fold`).
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
    /// The model levels written for every chunk of the current text.
    pub ready: Vec<FoldLevel>,
    pub status: FoldStatus,
    /// The agent's label, for "Written by <agent>"; `None` when no agent runs.
    pub agent: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LevelWords {
    pub full: u32,
    pub brief: u32,
    pub key: u32,
    pub takeaway: u32,
    pub topic: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FoldSection {
    pub hash: String,
    pub heading: Option<String>,
    /// The model's section lines joined, once every chunk has them; the first paragraph's
    /// Takeaway until then.
    pub takeaway: Option<String>,
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
    /// Word maps of the model lines onto `src_tokens`, for the slide morph.
    pub morph: FoldMorph,
    /// Indices into `sentences` that make Brief: the model's, else the local pick.
    pub brief_idx: Vec<u32>,
    /// `None` until the model has written it.
    pub key: Option<FoldKey>,
    /// The model's line, else the first sentence cut to 12 words.
    pub takeaway: String,
    /// The model's line, else the first sentence cut to 4 words.
    pub topic: String,
    /// Sentence indices the model lines rest on.
    pub evidence: Vec<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FoldKey {
    pub takeaway: String,
    pub reason: String,
}

/// A word of a model line; `src` indexes the paragraph's `src_tokens` when the word occurs there.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FoldToken {
    pub text: String,
    pub src: Option<u32>,
}

/// Word maps per model line; a line is `None` until the model has written it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FoldMorph {
    pub key_takeaway: Option<Vec<FoldToken>>,
    pub key_reason: Option<Vec<FoldToken>>,
    pub takeaway: Option<Vec<FoldToken>>,
    pub topic: Option<Vec<FoldToken>>,
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
