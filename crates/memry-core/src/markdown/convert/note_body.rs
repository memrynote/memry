//! `yDocToMarkdownWithWritingRanges` and `serializeNoteBody`: the body with its
//! CriticMarkup and, when the doc has alternatives or ghosts, the writing
//! tools markers; plus the `writing` frontmatter beside it.

use yrs::ReadTxn;

use super::Env;
use super::canonical::serialize_canonical;
use super::restore::{SerializeOptions, SourceRestoreOutcome, doc_to_markdown};
use super::roots::read_critic_marks;
use super::writing::{EncodedWritingRanges, insert_writing_sentinels, writing_frontmatter_for};
use super::writing_roots::{
    WritingAlternative, read_writing_alternatives, read_writing_ghosts, read_writing_overflow,
};
use crate::markdown::shared::critic_markup::{CriticMarkupMark, serialize_critic_markup};
use crate::markdown::shared::writing_tools::{WritingFrontmatter, encode_writing_body};

/// What the vault file gets for a doc.
#[derive(Debug, Clone, PartialEq)]
pub struct NoteBody {
    pub markdown: String,
    pub writing: WritingFrontmatter,
    pub outcome: SourceRestoreOutcome,
}

/// `yDocToMarkdownWithWritingRanges`' three answers.
pub enum WritingRanged {
    /// `undefined`: no range resolves, serialize as usual.
    NotApplicable,
    /// `null`: conversion failed.
    Failed,
    Body {
        markdown: String,
        alternatives: Vec<(WritingAlternative, String)>,
    },
}

/// The file body of a doc that holds alternatives or ghosts: house style with
/// the writing tools markers in place and `critic_marks` applied around them.
pub fn doc_to_markdown_with_writing_ranges<T: ReadTxn>(
    txn: &T,
    fragment: &str,
    critic_marks: &[CriticMarkupMark],
) -> WritingRanged {
    let alternatives = read_writing_alternatives(txn);
    let ghosts = read_writing_ghosts(txn);
    if alternatives.is_empty() && ghosts.is_empty() {
        return WritingRanged::NotApplicable;
    }
    let mut encoded: Option<EncodedWritingRanges> = None;
    let mut prepare = |snapshot: &yrs::Doc| {
        encoded = Some(insert_writing_sentinels(
            snapshot,
            fragment,
            &alternatives,
            &ghosts,
        ));
    };
    let Some(text) = serialize_canonical(txn, fragment, Some(&mut prepare)) else {
        return WritingRanged::Failed;
    };
    match encoded {
        Some(ranges) if !ranges.sentinels.is_empty() => WritingRanged::Body {
            markdown: encode_writing_body(&text, &ranges.sentinels, critic_marks),
            alternatives: ranges.alternatives,
        },
        _ => WritingRanged::NotApplicable,
    }
}

/// `serializeNoteBody`: `None` is the fail-closed answer.
pub fn serialize_note_body<T: ReadTxn>(
    env: &Env,
    txn: &T,
    fragment: &str,
    options: &SerializeOptions,
) -> Option<NoteBody> {
    let critic_marks = read_critic_marks(txn);
    let overflow = read_writing_overflow(txn);
    match doc_to_markdown_with_writing_ranges(txn, fragment, &critic_marks) {
        WritingRanged::Failed => return None,
        WritingRanged::Body {
            markdown,
            alternatives,
        } => {
            return Some(NoteBody {
                markdown,
                writing: writing_frontmatter_for(&alternatives, &overflow),
                outcome: SourceRestoreOutcome::WritingMarks,
            });
        }
        WritingRanged::NotApplicable => {}
    }
    let plain = doc_to_markdown(env, txn, fragment, options)?;
    Some(NoteBody {
        markdown: serialize_critic_markup(&plain.markdown, &critic_marks),
        writing: writing_frontmatter_for(&[], &overflow),
        outcome: plain.outcome,
    })
}
