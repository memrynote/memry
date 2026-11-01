//! The tag commands' inputs and answers as the renderer sees them (`tags-api.ts`). Instants
//! travel as ISO strings here, as Electron's tag answers carry its index's text columns.

use memry_core::domain::note_list::NoteSort;
use memry_core::domain::tag_reads::{TagCount, TagNotes, TaggedNote};
use memry_core::storage::repositories::instants::to_iso8601;
use serde::{Deserialize, Serialize};

use crate::notes::view::SortOrder;

/// `TagWithCount`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TagWithCountView {
    pub name: String,
    pub count: u32,
    pub color: String,
    pub icon: Option<String>,
    pub category_id: Option<String>,
    pub sort_order: i64,
}

impl From<TagCount> for TagWithCountView {
    fn from(tag: TagCount) -> Self {
        Self {
            name: tag.name,
            count: tag.count,
            color: tag.color,
            icon: tag.icon,
            category_id: tag.category_id,
            sort_order: tag.sort_order,
        }
    }
}

/// `GetNotesByTagSchema.sortBy`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum TagSortBy {
    Modified,
    Created,
    Title,
}

/// `GetNotesByTagSchema`: `modified`, descending, the tag alone when a field is absent.
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NotesByTagInput {
    pub tag: String,
    #[serde(default)]
    pub sort_by: Option<TagSortBy>,
    #[serde(default)]
    pub sort_order: Option<SortOrder>,
    #[serde(default)]
    pub include_descendants: Option<bool>,
}

impl NotesByTagInput {
    pub(crate) fn sort(&self) -> NoteSort {
        match self.sort_by {
            Some(TagSortBy::Title) => NoteSort::Title,
            Some(TagSortBy::Created) => NoteSort::Created,
            Some(TagSortBy::Modified) | None => NoteSort::Modified,
        }
    }

    pub(crate) fn ascending(&self) -> bool {
        self.sort_order == Some(SortOrder::Asc)
    }
}

/// `TagNoteItem`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TagNoteItemView {
    pub id: String,
    pub path: String,
    pub title: String,
    pub created: String,
    pub modified: String,
    pub tags: Vec<String>,
    pub word_count: u32,
    pub is_pinned: bool,
    pub pinned_at: Option<String>,
    pub emoji: Option<String>,
}

fn iso(ms: Option<i64>) -> Option<String> {
    ms.and_then(to_iso8601)
}

impl From<TaggedNote> for TagNoteItemView {
    fn from(note: TaggedNote) -> Self {
        // An instant the record lacks reads as the other, as the note reads do.
        let created = note.created_at.or(note.modified_at);
        let modified = note.modified_at.or(created);
        Self {
            created: iso(created).unwrap_or_default(),
            modified: iso(modified).unwrap_or_default(),
            is_pinned: note.pinned_at.is_some(),
            pinned_at: iso(note.pinned_at),
            id: note.id,
            path: note.path,
            title: note.title,
            tags: note.tags,
            word_count: note.word_count,
            emoji: note.emoji,
        }
    }
}

/// `GetNotesByTagResponse`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NotesByTagView {
    pub tag: String,
    pub color: String,
    pub count: u32,
    pub pinned_notes: Vec<TagNoteItemView>,
    pub unpinned_notes: Vec<TagNoteItemView>,
}

impl NotesByTagView {
    pub(crate) fn of(tag: String, tagged: TagNotes) -> Self {
        let count = u32::try_from(tagged.notes.len()).unwrap_or(u32::MAX);
        let (pinned, unpinned): (Vec<_>, Vec<_>) = tagged
            .notes
            .into_iter()
            .map(TagNoteItemView::from)
            .partition(|note| note.is_pinned);
        Self {
            tag,
            color: tagged.color,
            count,
            pinned_notes: pinned,
            unpinned_notes: unpinned,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(id: &str, created_at: Option<i64>, pinned_at: Option<i64>) -> TaggedNote {
        TaggedNote {
            id: id.to_owned(),
            path: format!("{id}.md"),
            title: id.to_owned(),
            emoji: None,
            created_at,
            modified_at: Some(0),
            tags: vec!["work".to_owned()],
            word_count: 0,
            pinned_at,
        }
    }

    /// The renderer shows the two lists apart; `count` covers both.
    #[test]
    fn a_tags_notes_answer_pinned_and_unpinned_apart_in_their_order() {
        let tagged = TagNotes {
            color: "teal".to_owned(),
            notes: vec![
                note("a", Some(1), Some(1_000)),
                note("b", None, None),
                note("c", Some(1), None),
            ],
        };
        let view = NotesByTagView::of("work".to_owned(), tagged);
        assert_eq!((view.count, view.color.as_str()), (3, "teal"));
        let ids =
            |notes: &[TagNoteItemView]| notes.iter().map(|n| n.id.clone()).collect::<Vec<_>>();
        assert_eq!(ids(&view.pinned_notes), ["a"]);
        assert_eq!(ids(&view.unpinned_notes), ["b", "c"]);
        let pinned = &view.pinned_notes[0];
        assert!(pinned.is_pinned);
        assert_eq!(
            pinned.pinned_at.as_deref(),
            Some("1970-01-01T00:00:01.000Z")
        );
        assert_eq!(view.unpinned_notes[0].pinned_at, None);
        // A record without its creation instant reads as modified then, as the note reads do.
        assert_eq!(view.unpinned_notes[0].created, "1970-01-01T00:00:00.000Z");
    }
}
