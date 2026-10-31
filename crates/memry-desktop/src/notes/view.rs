//! The note reads' inputs and answers as the renderer sees them (`notes-api.ts`,
//! `@memry/rpc/notes`). Dates travel as epoch milliseconds; the renderer's service makes them
//! `Date`s.

use memry_core::domain::note_list::{ListedNote, NoteSort};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::vault::file_types::FileType;

/// `NoteSizeClass`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum SizeClass {
    Note,
    LargeFile,
}

/// `NoteLargeFileReason`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum LargeFileReasonView {
    FileBytes,
    BlockBytes,
}

/// `NoteLargeFileInfo`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LargeFileInfo {
    pub reason: LargeFileReasonView,
    pub file_bytes: u32,
    /// `None` when the file was classified on its size alone and never read.
    pub largest_block_bytes: Option<u32>,
}

/// `Note`.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteView {
    pub id: String,
    pub path: String,
    pub title: String,
    /// The body without the frontmatter block; empty when `content_omitted`.
    pub content: String,
    pub frontmatter: Map<String, Value>,
    pub created: i64,
    pub modified: i64,
    /// The frontmatter's tags and the body's together.
    pub tags: Vec<String>,
    /// The frontmatter `tags:` list alone.
    pub header_tags: Vec<String>,
    pub aliases: Vec<String>,
    pub word_count: u32,
    pub properties: Map<String, Value>,
    pub emoji: Option<String>,
    pub size_class: SizeClass,
    pub large_file: Option<LargeFileInfo>,
    pub content_omitted: bool,
}

/// `NoteListItem`. `word_count` is `None` until the note index (Step 13e) measured the file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteListItemView {
    pub id: String,
    pub path: String,
    pub title: String,
    pub created: i64,
    pub modified: i64,
    pub tags: Vec<String>,
    pub word_count: Option<u32>,
    pub emoji: Option<String>,
    pub local_only: bool,
    /// `None` for a type a newer build stored.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional, type = FileType)]
    pub file_type: Option<FileType>,
    /// Left out of the sidebar's `tree` shape, as `listNotes` leaves them.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional, type = Vec<String>)]
    pub aliases: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional, type = String)]
    pub mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional, type = i64)]
    pub file_size: Option<i64>,
}

impl NoteListItemView {
    pub fn of(note: ListedNote, tree: bool) -> Self {
        let (created, modified) = dates(&note);
        Self {
            id: note.id,
            path: note.path,
            title: note.title,
            created,
            modified,
            tags: note.tags,
            word_count: None,
            emoji: note.emoji,
            local_only: note.local_only,
            file_type: FileType::of_stored(&note.file_type),
            aliases: (!tree).then_some(note.aliases),
            mime_type: if tree { None } else { note.mime_type },
            file_size: if tree { None } else { note.file_size },
        }
    }
}

/// `(created, modified)` in epoch milliseconds; an instant the record lacks reads as the other.
pub(crate) fn dates(note: &ListedNote) -> (i64, i64) {
    let created = note.created_at.or(note.modified_at).unwrap_or(0);
    (created, note.modified_at.unwrap_or(created))
}

/// `NoteListSchema`'s options this slice reads; a value the schema does not name is refused,
/// as zod refuses it. `includeJournals` is not read: journal entries are not listed until Step
/// 13m.
#[derive(Debug, Clone, Default, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteListOptions {
    #[serde(default)]
    pub folder: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub sort_by: Option<NoteListSortBy>,
    #[serde(default)]
    pub sort_order: Option<SortOrder>,
    /// 1 to 10000, 100 when absent.
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub offset: Option<u32>,
    #[serde(default)]
    pub fields: Option<NoteListFields>,
}

/// `NoteListSchema.sortBy`. `position` sorts as `modified`, as in `listNotesFromCache`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum NoteListSortBy {
    Modified,
    Created,
    Title,
    Position,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum SortOrder {
    Asc,
    Desc,
}

/// `NoteListSchema.fields`: `tree` drops the fields the sidebar never reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum NoteListFields {
    Full,
    Tree,
}

impl NoteListOptions {
    pub(crate) fn sort(&self) -> NoteSort {
        match self.sort_by {
            Some(NoteListSortBy::Created) => NoteSort::Created,
            Some(NoteListSortBy::Title) => NoteSort::Title,
            Some(NoteListSortBy::Modified | NoteListSortBy::Position) | None => NoteSort::Modified,
        }
    }
}

/// `NoteListResponse`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteListPageView {
    pub notes: Vec<NoteListItemView>,
    pub total: u32,
    pub has_more: bool,
}

/// The kinds of a note whose file is not markdown.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum AttachedFileType {
    Pdf,
    Image,
    Audio,
    Video,
}

impl AttachedFileType {
    /// `None` for markdown.
    pub fn of(file_type: FileType) -> Option<Self> {
        match file_type {
            FileType::Markdown => None,
            FileType::Pdf => Some(Self::Pdf),
            FileType::Image => Some(Self::Image),
            FileType::Audio => Some(Self::Audio),
            FileType::Video => Some(Self::Video),
        }
    }
}

/// `FileMetadata`: a note whose file is not markdown.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FileView {
    pub id: String,
    pub path: String,
    pub absolute_path: String,
    pub title: String,
    pub file_type: AttachedFileType,
    pub mime_type: Option<String>,
    pub file_size: Option<i64>,
    pub created: i64,
    pub modified: i64,
    /// The text of the voice capture filed as this file, when one was.
    pub transcription: Option<String>,
    pub transcription_status: Option<TranscriptionStatus>,
}

/// `FileMetadata.transcriptionStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum TranscriptionStatus {
    Pending,
    Processing,
    Complete,
    Failed,
}

impl TranscriptionStatus {
    /// The stored status; `None` for a value no build writes.
    pub fn parse(stored: &str) -> Option<Self> {
        match stored {
            "pending" => Some(Self::Pending),
            "processing" => Some(Self::Processing),
            "complete" => Some(Self::Complete),
            "failed" => Some(Self::Failed),
            _ => None,
        }
    }
}
