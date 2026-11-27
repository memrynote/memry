//! Bookmarks as the renderer sees them (`bookmarks-api.ts`, Electron
//! `ipc/bookmarks-handlers.ts`). The rules are the core's ([`memry_core::domain::bookmarks`]):
//! ids, positions, revival of a tombstone, which items resolve. This module checks the input at
//! the boundary and shapes the answers. Instants travel as ISO strings, as Electron's rows hold
//! them.

use std::sync::Arc;

use memry_core::api::auth::ensure_device_identity;
use memry_core::api::errors::{AuthError, StorageError};
use memry_core::api::notes_write::NotesWriter;
use memry_core::domain::bookmarks::{
    Bookmark, Created, Page, PageQuery, Resolved, SortBy, Toggled,
};
use memry_core::seams::secure_store::SecureStore;
use memry_core::storage::repositories::instants::to_iso8601;
use serde::{Deserialize, Serialize};

use crate::notes::view::SortOrder;
use crate::session::OpenVault;

/// `BookmarkListSchema.limit`'s bounds.
const LIST_LIMIT: std::ops::RangeInclusive<u32> = 1..=1000;

/// `Bookmark`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkView {
    pub id: String,
    pub item_type: String,
    pub item_id: String,
    pub position: i64,
    /// Empty for a row a peer wrote without one.
    pub created_at: String,
}

impl From<Bookmark> for BookmarkView {
    fn from(row: Bookmark) -> Self {
        Self {
            id: row.id,
            item_type: row.item_type,
            item_id: row.item_id,
            position: row.position,
            created_at: row.created_at.and_then(to_iso8601).unwrap_or_default(),
        }
    }
}

/// `BookmarkItemMeta`: only what the item has.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkItemMetaView {
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub emoji: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub tags: Option<Vec<String>>,
}

/// `BookmarkWithItem`: a row and what it points at. An item that is gone, or of a type nothing
/// resolves, has no title and `itemExists: false`, and the list shows it as an orphan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkWithItemView {
    pub id: String,
    pub item_type: String,
    pub item_id: String,
    pub position: i64,
    pub created_at: String,
    pub item_title: Option<String>,
    pub item_exists: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub item_meta: Option<BookmarkItemMetaView>,
}

impl BookmarkWithItemView {
    fn new(row: Bookmark, resolved: Option<Resolved>) -> Self {
        let row = BookmarkView::from(row);
        let item_exists = resolved.is_some();
        let (item_title, item_meta) = match resolved {
            None => (None, None),
            Some(item) => {
                let tags = (!item.tags.is_empty()).then_some(item.tags);
                let meta = (item.path.is_some() || item.emoji.is_some() || tags.is_some())
                    .then_some(BookmarkItemMetaView {
                        path: item.path,
                        emoji: item.emoji,
                        tags,
                    });
                (Some(item.title), meta)
            }
        };
        Self {
            id: row.id,
            item_type: row.item_type,
            item_id: row.item_id,
            position: row.position,
            created_at: row.created_at,
            item_title,
            item_exists,
            item_meta,
        }
    }
}

/// `BookmarkListResponse`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkListView {
    pub bookmarks: Vec<BookmarkWithItemView>,
    pub total: u32,
    pub has_more: bool,
}

impl BookmarkListView {
    fn new(page: Page, offset: u32) -> Self {
        let shown = u32::try_from(page.bookmarks.len()).unwrap_or(u32::MAX);
        Self {
            has_more: offset.saturating_add(shown) < page.total,
            total: page.total,
            bookmarks: page
                .bookmarks
                .into_iter()
                .map(|(row, resolved)| BookmarkWithItemView::new(row, resolved))
                .collect(),
        }
    }
}

/// `BookmarkListSchema.sortBy`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum BookmarkSortBy {
    Position,
    CreatedAt,
}

/// `BookmarkListSchema`: by position, ascending, 100 from the first when a field is absent.
#[derive(Debug, Clone, Default, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkListInput {
    #[serde(default)]
    #[specta(optional)]
    pub item_type: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub sort_by: Option<BookmarkSortBy>,
    #[serde(default)]
    #[specta(optional)]
    pub sort_order: Option<SortOrder>,
    #[serde(default)]
    #[specta(optional)]
    pub limit: Option<u32>,
    #[serde(default)]
    #[specta(optional)]
    pub offset: Option<u32>,
}

/// `BookmarkCheckSchema`, `BookmarkCreateSchema`, `BookmarkToggleSchema` and one item of
/// `BookmarkBulkCreateSchema`.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkItemInput {
    pub item_type: String,
    pub item_id: String,
}

/// `bookmarks:list`. A limit outside 1 to 1000 is refused, as `BookmarkListSchema` refuses it.
pub fn list(open: &OpenVault, input: BookmarkListInput) -> Result<BookmarkListView, StorageError> {
    let limit = input.limit.unwrap_or(100);
    if !LIST_LIMIT.contains(&limit) {
        return Err(StorageError::Invalid {
            what: format!("a bookmark page holds 1 to 1000 rows, not {limit}"),
        });
    }
    let offset = input.offset.unwrap_or(0);
    let page = open.vault.bookmarks().page(PageQuery {
        item_type: input.item_type,
        sort_by: match input.sort_by.unwrap_or(BookmarkSortBy::Position) {
            BookmarkSortBy::Position => SortBy::Position,
            BookmarkSortBy::CreatedAt => SortBy::CreatedAt,
        },
        descending: input.sort_order == Some(SortOrder::Desc),
        limit,
        offset,
    })?;
    Ok(BookmarkListView::new(with_file_tags(open, page)?, offset))
}

/// `bookmarks:list-by-type`: every bookmark of the type, by position.
pub fn list_by_type(open: &OpenVault, item_type: String) -> Result<BookmarkListView, StorageError> {
    let page = open.vault.bookmarks().page(PageQuery {
        item_type: Some(item_type),
        sort_by: SortBy::Position,
        descending: false,
        limit: u32::MAX,
        offset: 0,
    })?;
    Ok(BookmarkListView::new(with_file_tags(open, page)?, 0))
}

/// A note's or journal day's tags as the tag list counts them, header tags of its file included
/// ([`memry_core::api::search::Search::tags_of_notes`]), as Electron reads them from its note
/// cache (`bookmarks-handlers.ts:76`). The core's resolve reads the record's tags alone, which a
/// filed note's header tags never reach.
fn with_file_tags(open: &OpenVault, mut page: Page) -> Result<Page, StorageError> {
    let ids: Vec<String> = page
        .bookmarks
        .iter()
        .filter(|(row, resolved)| {
            resolved.is_some() && matches!(row.item_type.as_str(), "note" | "journal")
        })
        .map(|(row, _)| row.item_id.clone())
        .collect();
    if ids.is_empty() {
        return Ok(page);
    }
    let mut tags = open.search.tags_of_notes(ids)?;
    for (row, resolved) in &mut page.bookmarks {
        if let Some(item) = resolved
            && matches!(row.item_type.as_str(), "note" | "journal")
        {
            item.tags = tags.remove(&row.item_id).unwrap_or_default();
        }
    }
    Ok(page)
}

/// `bookmarks:get`.
pub fn get(open: &OpenVault, id: String) -> Result<Option<BookmarkView>, StorageError> {
    Ok(open.vault.bookmarks().get(id)?.map(BookmarkView::from))
}

/// `bookmarks:get-by-item`.
pub fn get_by_item(
    open: &OpenVault,
    item: BookmarkItemInput,
) -> Result<Option<BookmarkView>, StorageError> {
    Ok(open
        .vault
        .bookmarks()
        .get_by_item(item.item_type, item.item_id)?
        .map(BookmarkView::from))
}

/// `bookmarks:is-bookmarked`.
pub fn is_bookmarked(open: &OpenVault, item: BookmarkItemInput) -> Result<bool, StorageError> {
    open.vault
        .bookmarks()
        .is_bookmarked(item.item_type, item.item_id)
}

/// What [`BookmarkWrites::toggle`] did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToggleOutcome {
    Created(BookmarkView),
    /// Every live bookmark of the item, as it was before the tombstone.
    Removed(Vec<BookmarkView>),
}

/// The bookmark writes of the open vault, each one transaction that also queues its push.
pub struct BookmarkWrites {
    writer: Arc<NotesWriter>,
}

impl BookmarkWrites {
    /// Writes under the device identity in `store` (minted on the first synced write of a
    /// profile; sign-in reuses it).
    pub fn open(open: &OpenVault, store: Arc<dyn SecureStore>) -> Result<Self, AuthError> {
        ensure_device_identity(store.clone())?;
        Ok(Self {
            writer: open.vault.notes_writer(store)?,
        })
    }

    /// `bookmarks:create`: the new row, or `None` when a live bookmark already names the item.
    pub fn create(&self, item: BookmarkItemInput) -> Result<Option<BookmarkView>, StorageError> {
        Ok(
            match self.writer.create_bookmark(item.item_type, item.item_id)? {
                Created::Created(row) => Some(row.into()),
                Created::AlreadyBookmarked => None,
            },
        )
    }

    /// `bookmarks:toggle`.
    pub fn toggle(&self, item: BookmarkItemInput) -> Result<ToggleOutcome, StorageError> {
        Ok(
            match self
                .writer
                .toggle_bookmark_rows(item.item_type, item.item_id)?
            {
                Toggled::Created(row) => ToggleOutcome::Created(row.into()),
                Toggled::Removed(rows) => {
                    ToggleOutcome::Removed(rows.into_iter().map(BookmarkView::from).collect())
                }
            },
        )
    }

    /// `bookmarks:delete`: the removed row, or `None` when no live bookmark has the id.
    pub fn delete(&self, id: String) -> Result<Option<BookmarkView>, StorageError> {
        Ok(self.writer.delete_bookmark(id)?.map(BookmarkView::from))
    }

    /// `bookmarks:reorder`: `ids` in their new order.
    pub fn reorder(&self, ids: Vec<String>) -> Result<(), StorageError> {
        self.writer.reorder_bookmarks(ids)
    }

    /// `bookmarks:bulk-create`: the rows it created; an item bookmarked already is skipped.
    pub fn bulk_create(
        &self,
        items: Vec<BookmarkItemInput>,
    ) -> Result<Vec<BookmarkView>, StorageError> {
        let items = items
            .into_iter()
            .map(|item| (item.item_type, item.item_id))
            .collect();
        Ok(self
            .writer
            .bulk_create_bookmarks(items)?
            .into_iter()
            .map(BookmarkView::from)
            .collect())
    }

    /// `bookmarks:bulk-delete`: the rows it removed; an id with no live row is skipped.
    pub fn bulk_delete(&self, ids: Vec<String>) -> Result<Vec<BookmarkView>, StorageError> {
        Ok(self
            .writer
            .bulk_delete_bookmarks(ids)?
            .into_iter()
            .map(BookmarkView::from)
            .collect())
    }
}
