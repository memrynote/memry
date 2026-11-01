//! The tags of the open vault as the renderer sees them (`ipc/tags-handlers.ts`): the tag list
//! with counts, a tag's notes, and the tag hub's edits (colour, icon, categories, drag). None of
//! them touches a note file: the list and a tag's notes are reads, and the hub's edits change
//! the synced `tag_definition` and `tag_category` records only.
//!
//! The rules live in the core: which tags a note carries and how they count
//! ([`memry_core::domain::tag_reads`]), how a definition and a category are written
//! ([`memry_core::api::tag_hub`]). This module checks the input at the boundary and shapes the
//! answers.

pub mod view;

use std::sync::Arc;

use memry_core::api::auth::ensure_device_identity;
use memry_core::api::errors::{AuthError, StorageError};
use memry_core::api::tag_hub::TagHub;
use memry_core::domain::tag_categories::TagAssignment;
use memry_core::domain::tags::tag_key;
use memry_core::seams::secure_store::SecureStore;

use crate::error::{CoreError, FailureKind};
use crate::session::OpenVault;
use view::{NotesByTagInput, NotesByTagView, ReorderInput, TagCategoryView, TagWithCountView};

#[derive(Debug, thiserror::Error)]
pub enum TagsError {
    #[error(transparent)]
    Storage(#[from] StorageError),
    #[error(transparent)]
    Auth(#[from] AuthError),
}

impl CoreError for TagsError {
    fn kind_and_code(&self) -> (FailureKind, &'static str) {
        match self {
            Self::Storage(error) => error.kind_and_code(),
            Self::Auth(error) => error.kind_and_code(),
        }
    }
}

/// A name that is blank once trimmed names no tag (`z.string().min(1)`, then trimmed by every
/// writer): refused before it reaches a definition.
fn tag_name(tag: &str) -> Result<&str, TagsError> {
    if tag_key(tag).is_empty() {
        return Err(StorageError::Invalid {
            what: "a tag needs a name".to_owned(),
        }
        .into());
    }
    Ok(tag)
}

/// `tags:get-all-with-counts`.
pub fn all_with_counts(open: &OpenVault) -> Result<Vec<TagWithCountView>, StorageError> {
    Ok(open
        .search
        .tag_counts()?
        .into_iter()
        .map(TagWithCountView::from)
        .collect())
}

/// `tags:get-notes-by-tag`. An empty tag is refused (`GetNotesByTagSchema`: `min(1)`).
pub fn notes_by_tag(
    open: &OpenVault,
    input: &NotesByTagInput,
) -> Result<NotesByTagView, StorageError> {
    if input.tag.is_empty() {
        return Err(StorageError::Invalid {
            what: "a tag needs a name".to_owned(),
        });
    }
    let tagged = open.search.tagged_notes(
        &input.tag,
        input.descendants(),
        input.sort(),
        input.ascending(),
    )?;
    Ok(NotesByTagView::of(input.tag.clone(), tagged))
}

/// `tags:list-categories`: the hub's categories, each with how many tags sit in it.
pub fn categories(open: &OpenVault) -> Result<Vec<TagCategoryView>, TagsError> {
    Ok(open
        .vault
        .tag_categories()?
        .into_iter()
        .map(TagCategoryView::from)
        .collect())
}

/// The tag hub of `open`, written under the device identity in `store` (minted on the first
/// synced write of a profile).
pub struct Hub {
    hub: TagHub,
}

impl Hub {
    pub fn open(open: &OpenVault, store: Arc<dyn SecureStore>) -> Result<Self, TagsError> {
        ensure_device_identity(store.clone())?;
        Ok(Self {
            hub: open.vault.tag_hub(store)?,
        })
    }

    /// `tags:update-color`: a colour picked by a person, which makes the tag's definition when it
    /// has none (the hub's "New tag" is this call on a new name).
    pub fn set_color(&self, tag: &str, color: &str) -> Result<(), TagsError> {
        if color.is_empty() {
            return Err(StorageError::Invalid {
                what: "a tag colour cannot be empty".to_owned(),
            }
            .into());
        }
        Ok(self.hub.set_color(tag_name(tag)?, color)?)
    }

    /// `tags:update-icon`: an emoji or `icon:Name`; `None` clears it, and an empty one is
    /// refused (`z.string().min(1).nullable()`).
    pub fn set_icon(&self, tag: &str, icon: Option<&str>) -> Result<(), TagsError> {
        if icon == Some("") {
            return Err(StorageError::Invalid {
                what: "a tag icon cannot be empty".to_owned(),
            }
            .into());
        }
        Ok(self.hub.set_icon(tag_name(tag)?, icon)?)
    }

    pub fn create_category(&self, name: &str) -> Result<TagCategoryView, TagsError> {
        Ok(self.hub.create_category(name)?.into())
    }

    pub fn rename_category(&self, id: &str, name: &str) -> Result<(), TagsError> {
        Ok(self.hub.rename_category(id, name)?)
    }

    pub fn delete_category(&self, id: &str) -> Result<(), TagsError> {
        self.hub.delete_category(id)?;
        Ok(())
    }

    /// `tags:reorder`: tag assignments and category order, all or nothing (the core refuses a
    /// blank tag).
    pub fn reorder(&self, input: &ReorderInput) -> Result<(), TagsError> {
        let assignments: Vec<TagAssignment> = input
            .tags
            .iter()
            .flatten()
            .map(|assignment| TagAssignment {
                tag: assignment.tag.clone(),
                category_id: assignment.category_id.clone(),
                sort_order: assignment.sort_order,
            })
            .collect();
        let order: Vec<(String, i64)> = input
            .categories
            .iter()
            .flatten()
            .map(|category| (category.id.clone(), category.sort_order))
            .collect();
        Ok(self.hub.arrange(&assignments, &order)?)
    }
}
