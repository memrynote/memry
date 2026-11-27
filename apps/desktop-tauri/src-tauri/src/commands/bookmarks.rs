//! The bookmark commands (`bookmarks:*` of `ipc/bookmarks-handlers.ts`), each one call of
//! `memry_desktop::bookmarks`. Every write announces what it changed after it committed:
//! [`BookmarkCreatedEvent`] per row made, [`BookmarkDeletedEvent`] per row removed,
//! [`BookmarksReorderedEvent`] for a reorder.

use std::sync::Arc;

use memry_desktop::bookmarks::{
    self, BookmarkItemInput, BookmarkListInput, BookmarkListView, BookmarkView, BookmarkWrites,
    ToggleOutcome,
};
use memry_desktop::i18n::{self, Args};
use memry_desktop::locale::LocaleService;
use memry_desktop::seams::secure_store::DeviceIdentityStore;
use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};

use super::blocking;
use super::error::{CommandError, ErrorKind};
use super::tags::open_vault;
use crate::events::{
    BookmarkCreatedEvent, BookmarkDeletedEvent, BookmarksReorderedEvent, broadcast,
};

/// `bookmarks:toggle`'s answer.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkToggleView {
    pub is_bookmarked: bool,
    /// The row made; `null` when the toggle removed the bookmark.
    pub bookmark: Option<BookmarkView>,
}

fn writes<R: Runtime>(app: &AppHandle<R>) -> Result<BookmarkWrites, CommandError> {
    let open = open_vault(app)?;
    let store = app.state::<Arc<DeviceIdentityStore>>().inner().clone();
    BookmarkWrites::open(&open, store).map_err(|error| CommandError::from_core(&error))
}

/// Electron's localized refusal under `key` (`errors:bookmark.*`).
fn refused<R: Runtime>(app: &AppHandle<R>, kind: ErrorKind, code: &str, key: &str) -> CommandError {
    let locale = app.state::<Arc<LocaleService>>().get();
    CommandError::new(kind, code, i18n::t(locale, key, &Args::new()))
}

fn created<R: Runtime>(app: &AppHandle<R>, bookmark: BookmarkView) {
    broadcast(app, BookmarkCreatedEvent { bookmark });
}

fn deleted<R: Runtime>(app: &AppHandle<R>, row: BookmarkView) {
    broadcast(
        app,
        BookmarkDeletedEvent {
            id: row.id,
            item_type: row.item_type,
            item_id: row.item_id,
        },
    );
}

/// One page of bookmarks, each with what it points at.
#[tauri::command]
#[specta::specta]
pub async fn bookmarks_list<R: Runtime>(
    app: AppHandle<R>,
    input: BookmarkListInput,
) -> Result<BookmarkListView, CommandError> {
    blocking("bookmarks_list", move || {
        bookmarks::list(&open_vault(&app)?, input).map_err(|error| CommandError::from_core(&error))
    })
    .await
}

/// Every bookmark of `item_type`, by position.
#[tauri::command]
#[specta::specta]
pub async fn bookmarks_list_by_type<R: Runtime>(
    app: AppHandle<R>,
    item_type: String,
) -> Result<BookmarkListView, CommandError> {
    blocking("bookmarks_list_by_type", move || {
        bookmarks::list_by_type(&open_vault(&app)?, item_type)
            .map_err(|error| CommandError::from_core(&error))
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn bookmarks_get<R: Runtime>(
    app: AppHandle<R>,
    id: String,
) -> Result<Option<BookmarkView>, CommandError> {
    blocking("bookmarks_get", move || {
        bookmarks::get(&open_vault(&app)?, id).map_err(|error| CommandError::from_core(&error))
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn bookmarks_get_by_item<R: Runtime>(
    app: AppHandle<R>,
    input: BookmarkItemInput,
) -> Result<Option<BookmarkView>, CommandError> {
    blocking("bookmarks_get_by_item", move || {
        bookmarks::get_by_item(&open_vault(&app)?, input)
            .map_err(|error| CommandError::from_core(&error))
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn bookmarks_is_bookmarked<R: Runtime>(
    app: AppHandle<R>,
    input: BookmarkItemInput,
) -> Result<bool, CommandError> {
    blocking("bookmarks_is_bookmarked", move || {
        bookmarks::is_bookmarked(&open_vault(&app)?, input)
            .map_err(|error| CommandError::from_core(&error))
    })
    .await
}

/// Bookmarks the item at the end of the list; an item bookmarked already is refused with
/// Electron's "already bookmarked".
#[tauri::command]
#[specta::specta]
pub async fn bookmarks_create<R: Runtime>(
    app: AppHandle<R>,
    input: BookmarkItemInput,
) -> Result<BookmarkView, CommandError> {
    blocking("bookmarks_create", move || {
        let row = writes(&app)?
            .create(input)
            .map_err(|error| CommandError::from_core(&error))?
            .ok_or_else(|| {
                refused(
                    &app,
                    ErrorKind::Invalid,
                    "already_bookmarked",
                    "errors:bookmark.alreadyBookmarked",
                )
            })?;
        created(&app, row.clone());
        Ok(row)
    })
    .await
}

/// Bookmarks an unbookmarked item, or removes every bookmark of a bookmarked one.
#[tauri::command]
#[specta::specta]
pub async fn bookmarks_toggle<R: Runtime>(
    app: AppHandle<R>,
    input: BookmarkItemInput,
) -> Result<BookmarkToggleView, CommandError> {
    blocking("bookmarks_toggle", move || {
        let outcome = writes(&app)?
            .toggle(input)
            .map_err(|error| CommandError::from_core(&error))?;
        Ok(match outcome {
            ToggleOutcome::Created(row) => {
                created(&app, row.clone());
                BookmarkToggleView {
                    is_bookmarked: true,
                    bookmark: Some(row),
                }
            }
            ToggleOutcome::Removed(rows) => {
                for row in rows {
                    deleted(&app, row);
                }
                BookmarkToggleView {
                    is_bookmarked: false,
                    bookmark: None,
                }
            }
        })
    })
    .await
}

/// Removes the bookmark `id`; an id with no live bookmark is refused with Electron's "not found".
#[tauri::command]
#[specta::specta]
pub async fn bookmarks_delete<R: Runtime>(
    app: AppHandle<R>,
    id: String,
) -> Result<(), CommandError> {
    blocking("bookmarks_delete", move || {
        let row = writes(&app)?
            .delete(id)
            .map_err(|error| CommandError::from_core(&error))?
            .ok_or_else(|| {
                refused(
                    &app,
                    ErrorKind::NotFound,
                    "not_found",
                    "errors:bookmark.notFound",
                )
            })?;
        deleted(&app, row);
        Ok(())
    })
    .await
}

/// Puts `bookmark_ids` in this order.
#[tauri::command]
#[specta::specta]
pub async fn bookmarks_reorder<R: Runtime>(
    app: AppHandle<R>,
    bookmark_ids: Vec<String>,
) -> Result<(), CommandError> {
    blocking("bookmarks_reorder", move || {
        writes(&app)?
            .reorder(bookmark_ids.clone())
            .map_err(|error| CommandError::from_core(&error))?;
        broadcast(&app, BookmarksReorderedEvent { bookmark_ids });
        Ok(())
    })
    .await
}

/// Bookmarks each item not bookmarked yet and answers how many it made.
#[tauri::command]
#[specta::specta]
pub async fn bookmarks_bulk_create<R: Runtime>(
    app: AppHandle<R>,
    items: Vec<BookmarkItemInput>,
) -> Result<u32, CommandError> {
    blocking("bookmarks_bulk_create", move || {
        let rows = writes(&app)?
            .bulk_create(items)
            .map_err(|error| CommandError::from_core(&error))?;
        let count = u32::try_from(rows.len()).unwrap_or(u32::MAX);
        for row in rows {
            created(&app, row);
        }
        Ok(count)
    })
    .await
}

/// Removes each bookmark of `bookmark_ids` and answers how many it removed.
#[tauri::command]
#[specta::specta]
pub async fn bookmarks_bulk_delete<R: Runtime>(
    app: AppHandle<R>,
    bookmark_ids: Vec<String>,
) -> Result<u32, CommandError> {
    blocking("bookmarks_bulk_delete", move || {
        let rows = writes(&app)?
            .bulk_delete(bookmark_ids)
            .map_err(|error| CommandError::from_core(&error))?;
        let count = u32::try_from(rows.len()).unwrap_or(u32::MAX);
        for row in rows {
            deleted(&app, row);
        }
        Ok(count)
    })
    .await
}
