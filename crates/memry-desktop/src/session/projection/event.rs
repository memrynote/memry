//! The events the projectors consume. A port of `ProjectionEvent` in
//! `apps/desktop/src/main/projections/types.ts`, variant for variant. They stay in process
//! and never cross IPC, so there is no serde here.

use serde_json::{Map, Value};

/// A markdown note as the index sees it.
#[derive(Debug, Clone, PartialEq)]
pub struct MarkdownNoteProjection {
    pub note_id: String,
    pub path: String,
    pub title: String,
    pub local_only: bool,
    pub content_hash: Option<String>,
    pub word_count: Option<u32>,
    pub character_count: Option<u32>,
    pub snippet: Option<String>,
    pub date: Option<String>,
    pub emoji: Option<String>,
    /// Raw `cover` frontmatter. The outer `None` means "not read" (tier 0, large file): the
    /// indexed cover stays. `Some(None)` means the note has no cover.
    pub cover: Option<Option<String>>,
    pub created_at: String,
    pub modified_at: String,
    /// `None` when the body was not read (tier 0 builds a row from `stat` alone). A consumer
    /// that derives state from the body skips it rather than treat it as an empty note.
    pub parsed_content: Option<String>,
    /// Only set by tier 0.
    pub file_size: Option<u64>,
    /// Header and inline tags together, header spelling first.
    pub tags: Vec<String>,
    /// The subset of `tags` in the frontmatter `tags:` list.
    pub header_tags: Vec<String>,
    /// `None` when the frontmatter was not read. An empty map means "no properties", which
    /// unlinks the note from every project; `None` must never be read that way.
    pub properties: Option<Map<String, Value>>,
    pub aliases: Option<Vec<String>>,
    pub wiki_links: Vec<String>,
}

/// A non-markdown file tracked as a note.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileNoteProjection {
    pub note_id: String,
    pub path: String,
    pub title: String,
    /// Anything but `markdown`.
    pub file_type: String,
    pub mime_type: Option<String>,
    pub file_size: u64,
    pub created_at: String,
    pub modified_at: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum NoteProjectionRecord {
    Markdown(Box<MarkdownNoteProjection>),
    File(FileNoteProjection),
}

impl NoteProjectionRecord {
    pub fn note_id(&self) -> &str {
        match self {
            Self::Markdown(note) => &note.note_id,
            Self::File(note) => &note.note_id,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum ProjectionEvent {
    NoteUpserted(NoteProjectionRecord),
    NoteDeleted {
        note_id: String,
        path: Option<String>,
    },
    /// The note's `extracted_text` rows changed; search and embeddings re-read them.
    NoteTextExtracted {
        note_id: String,
    },
    /// The note's frontmatter `tags:` as read by the header-tag backfill, for tag rows an
    /// older build wrote without a header flag.
    NoteHeaderTagsResolved {
        note_id: String,
        header_tags: Vec<String>,
    },
    TaskUpserted {
        task_id: String,
    },
    TaskDeleted {
        task_id: String,
    },
    InboxUpserted {
        item_id: String,
    },
    InboxDeleted {
        item_id: String,
    },
    InboxFiled {
        item_id: String,
    },
    InboxUnfiled {
        item_id: String,
    },
    InboxArchived {
        item_id: String,
    },
    InboxUnarchived {
        item_id: String,
    },
}

/// The `type` discriminant of the TypeScript union.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EventKind {
    NoteUpserted,
    NoteDeleted,
    NoteTextExtracted,
    NoteHeaderTagsResolved,
    TaskUpserted,
    TaskDeleted,
    InboxUpserted,
    InboxDeleted,
    InboxFiled,
    InboxUnfiled,
    InboxArchived,
    InboxUnarchived,
}

impl ProjectionEvent {
    pub fn kind(&self) -> EventKind {
        match self {
            Self::NoteUpserted(_) => EventKind::NoteUpserted,
            Self::NoteDeleted { .. } => EventKind::NoteDeleted,
            Self::NoteTextExtracted { .. } => EventKind::NoteTextExtracted,
            Self::NoteHeaderTagsResolved { .. } => EventKind::NoteHeaderTagsResolved,
            Self::TaskUpserted { .. } => EventKind::TaskUpserted,
            Self::TaskDeleted { .. } => EventKind::TaskDeleted,
            Self::InboxUpserted { .. } => EventKind::InboxUpserted,
            Self::InboxDeleted { .. } => EventKind::InboxDeleted,
            Self::InboxFiled { .. } => EventKind::InboxFiled,
            Self::InboxUnfiled { .. } => EventKind::InboxUnfiled,
            Self::InboxArchived { .. } => EventKind::InboxArchived,
            Self::InboxUnarchived { .. } => EventKind::InboxUnarchived,
        }
    }

    /// The entity the event is about. Two events with the same entity and the same kind are
    /// redundant: the newer payload supersedes the older one.
    pub fn entity_key(&self) -> String {
        match self {
            Self::NoteUpserted(record) => format!("note:{}", record.note_id()),
            Self::NoteDeleted { note_id, .. }
            | Self::NoteTextExtracted { note_id }
            | Self::NoteHeaderTagsResolved { note_id, .. } => format!("note:{note_id}"),
            Self::TaskUpserted { task_id } | Self::TaskDeleted { task_id } => {
                format!("task:{task_id}")
            }
            Self::InboxUpserted { item_id }
            | Self::InboxDeleted { item_id }
            | Self::InboxFiled { item_id }
            | Self::InboxUnfiled { item_id }
            | Self::InboxArchived { item_id }
            | Self::InboxUnarchived { item_id } => format!("inbox:{item_id}"),
        }
    }
}
