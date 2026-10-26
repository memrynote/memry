//! `yDocToMarkdown` and `restoreFileSpelling` (`blocknote-converter.ts`): the
//! bytes the vault file should hold for a document. The document alone
//! serializes to house style; when it was seeded from a file spelled
//! differently, the author's bytes ride beside it and come back for every
//! region the document has not changed since, proven by re-parsing the merged
//! text and demanding it canonicalize to what the document says now.

use yrs::ReadTxn;

use super::Env;
use super::canonical::{canonical_markdown, serialize_canonical};
use super::roots::{read_critic_marks, read_markdown_source_record};
use crate::markdown::shared::critic_markup::parse_critic_markup;
use crate::markdown::shared::markdown_source::restore_markdown_source;
use crate::markdown::shared::writing_tools::{decode_writing_markers, without_writing_sentinels};

/// What became of the author's bytes on one serialization. `NoRecord` is by
/// design: the file was already in house style, or predates the record.
/// `FileUnreadable` and `RestoreThrew` resolve the call to `None`: the caller
/// keeps the file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceRestoreOutcome {
    NoRecord,
    CriticMarks,
    WritingMarks,
    Source,
    Merged,
    File,
    FileMerged,
    FileUnreadable,
    HouseStyleFallback,
    RestoreThrew,
}

impl SourceRestoreOutcome {
    /// The name the TypeScript reports (`SourceRestoreOutcome`).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NoRecord => "no-record",
            Self::CriticMarks => "critic-marks",
            Self::WritingMarks => "writing-marks",
            Self::Source => "source",
            Self::Merged => "merged",
            Self::File => "file",
            Self::FileMerged => "file-merged",
            Self::FileUnreadable => "file-unreadable",
            Self::HouseStyleFallback => "house-style-fallback",
            Self::RestoreThrew => "restore-threw",
        }
    }
}

/// `readFileBody`: the body the note's file holds now. `Ok(None)` is no file;
/// `Err` is a read that failed, which keeps the file.
pub type ReadFileBody<'a> = &'a dyn Fn() -> Result<Option<String>, String>;

/// `YDocToMarkdownOptions`.
#[derive(Clone, Copy, Default)]
pub struct SerializeOptions<'a> {
    /// The note's vault-relative path, so the proof parse resolves embeds the
    /// way the seed did.
    pub note_path: Option<&'a str>,
    /// Read only when the record cannot be restored, to restore the author's
    /// spelling from the file instead.
    pub read_file_body: Option<ReadFileBody<'a>>,
    /// Vault embed lookup for the proof parses; none resolves nothing.
    pub embeds: Option<&'a dyn super::EmbedResolver>,
    /// `onSourceRestore`: told the outcome of a serialization that resolves to
    /// `None` because the file could not be read, which `SerializedBody` cannot carry.
    pub on_unreadable: Option<&'a dyn Fn(SourceRestoreOutcome)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SerializedBody {
    pub markdown: String,
    pub outcome: SourceRestoreOutcome,
    /// Node names in the document the schema cannot build (`findUnrepresentableNodes`).
    /// Writing `markdown` to the vault file drops those nodes' content, so a
    /// caller that must not lose content refuses when this is not empty.
    /// `Converter::doc_to_markdown` fills it; the inner function leaves it empty.
    pub unrepresentable: Vec<String>,
    /// Elements y-prosemirror would delete because the schema cannot build them
    /// (a childless table row, a node in the wrong place): their content is not
    /// in `markdown` either. `Converter` fills it.
    pub dropped_elements: usize,
}

fn done(markdown: String, outcome: SourceRestoreOutcome) -> Option<SerializedBody> {
    Some(SerializedBody {
        markdown,
        outcome,
        unrepresentable: Vec::new(),
        dropped_elements: 0,
    })
}

/// `withLfLineEndings`.
fn with_lf_line_endings(markdown: &str) -> String {
    markdown.replace("\r\n", "\n").replace('\r', "\n")
}

enum FromFile {
    Restored(String, SourceRestoreOutcome),
    Unreadable,
}

/// `restoreFileSpelling`. `None` when there is no file or its spelling cannot
/// be kept either.
fn restore_file_spelling(
    canonical: &str,
    read_file_body: Option<ReadFileBody>,
    canonicalize: &mut dyn FnMut(&str) -> Option<String>,
) -> Option<FromFile> {
    let read = read_file_body?;
    let body = match read() {
        Ok(Some(body)) => body,
        Ok(None) => return None,
        Err(_) => return Some(FromFile::Unreadable),
    };
    let decoded = decode_writing_markers(&with_lf_line_endings(&body));
    let file = without_writing_sentinels(&parse_critic_markup(&decoded.text), &decoded.sentinels)
        .plain_text;
    let restored = restore_markdown_source(canonical, Some(&file), canonicalize);
    if restored == canonical {
        return None;
    }
    let outcome = if restored == file {
        SourceRestoreOutcome::File
    } else {
        SourceRestoreOutcome::FileMerged
    };
    Some(FromFile::Restored(restored, outcome))
}

/// `yDocToMarkdown`: `None` is the fail-closed answer, and the caller keeps the file.
pub fn doc_to_markdown<T: ReadTxn>(
    env: &Env,
    txn: &T,
    fragment: &str,
    options: &SerializeOptions,
) -> Option<SerializedBody> {
    let canonical = serialize_canonical(txn, fragment, None)?;
    let Some(record) = read_markdown_source_record(txn) else {
        return done(canonical, SourceRestoreOutcome::NoRecord);
    };
    if !read_critic_marks(txn).is_empty() {
        return done(canonical, SourceRestoreOutcome::CriticMarks);
    }
    let source = record.source.clone();
    // A record from before #2741 sits beside a document whose parse dropped
    // every comment, so the source is read the same way.
    let mut canonicalize =
        |markdown: &str| canonical_markdown(env, markdown, options.note_path, record.html_comments);
    let restored = restore_markdown_source(&canonical, Some(&source), &mut canonicalize);
    if restored == source {
        return done(restored, SourceRestoreOutcome::Source);
    }
    if restored != canonical {
        return done(restored, SourceRestoreOutcome::Merged);
    }
    match restore_file_spelling(&canonical, options.read_file_body, &mut canonicalize) {
        Some(FromFile::Unreadable) => {
            if let Some(report) = options.on_unreadable {
                report(SourceRestoreOutcome::FileUnreadable);
            }
            None
        }
        Some(FromFile::Restored(markdown, outcome)) => done(markdown, outcome),
        // A record was there and the merge could not be proven: house style.
        None => done(canonical, SourceRestoreOutcome::HouseStyleFallback),
    }
}
