//! `home_page`: Home boards (`HomePageSyncPayloadSchema`,
//! `packages/contracts/src/sync-payloads.ts`, migration `0027`).
//!
//! Eight fields under a whole-row clock. `widgets` is an opaque JSON string and
//! is stored as sent, never parsed into widgets: the merge
//! ([`crate::domain::home_page::merge`]) only checks it is array text. `cover`
//! is read as anything (`Kind::Any`), because a cover this build cannot read is
//! absent rather than a reason to refuse the board (the schema's
//! `.catch(undefined)`): the column holds a readable cover as JSON text and an
//! unreadable one as NULL, and the merge keeps the local cover over it. Electron pushes its
//! whole `home_pages` row, so `id` and `syncedAt` can arrive as unmodelled keys
//! and are preserved. An absent `name` is empty text, an absent `position` 0,
//! an absent `widgets` `[]`, and an absent instant the apply time.

use rusqlite::{Connection, params};
use serde_json::Value;

use crate::api::errors::StorageError;

use super::super::payload;
use super::super::schema::{Field, Kind, Object, ProjectionError, read_fields};
use super::{ItemContext, failed, instant, text, text_or_default};

const HOME_PAGE_FIELDS: &[Field] = &[
    Field::opt_null("name", Kind::Text),
    Field::opt_null("icon", Kind::Text),
    Field::opt_null("position", Kind::Number),
    Field::opt_null("widgets", Kind::Text),
    Field::opt_null("cover", Kind::Any),
    Field::opt_null("clock", Kind::Clock),
    Field::opt_null("createdAt", Kind::Text),
    Field::opt_null("updatedAt", Kind::Text),
];

pub fn read_home_page(parsed: &Object) -> Result<Object, ProjectionError> {
    read_fields("home_page", parsed, HOME_PAGE_FIELDS)
}

pub fn project_home_page(
    conn: &Connection,
    item: ItemContext<'_>,
    view: &Object,
) -> Result<(), StorageError> {
    conn.execute(
        "INSERT INTO home_pages (
             id, name, icon, position, widgets, cover, created_at, updated_at, deleted_at,
             synced_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             icon = excluded.icon,
             position = excluded.position,
             widgets = excluded.widgets,
             cover = excluded.cover,
             created_at = COALESCE(home_pages.created_at, excluded.created_at),
             updated_at = excluded.updated_at,
             deleted_at = excluded.deleted_at,
             synced_at = excluded.synced_at",
        params![
            item.item_id,
            text_or_default(view, "name", ""),
            text(view, "icon"),
            view.get("position").and_then(Value::as_f64).unwrap_or(0.0),
            text_or_default(view, "widgets", "[]"),
            view.get("cover")
                .filter(|cover| is_readable_cover(cover))
                .map(payload::json_text),
            instant(view, "createdAt").unwrap_or(item.synced_at),
            instant(view, "updatedAt").unwrap_or(item.synced_at),
            item.deleted_at,
            item.synced_at,
        ],
    )
    .map_err(failed)?;
    Ok(())
}

/// Whether `HomePageCoverSyncSchema` reads `cover`: an object with a non-empty
/// string `ref`, `focus` absent or a number in 0..=100, and `credit` and
/// `creditUrl` absent or strings. `focusX`, `zoom`, `height` and
/// `attachmentId` drop on their own (`.catch(undefined)`) and never fail it.
pub fn is_readable_cover(cover: &Value) -> bool {
    let Some(cover) = cover.as_object() else {
        return false;
    };
    let reference = cover
        .get("ref")
        .and_then(Value::as_str)
        .is_some_and(|text| !text.is_empty());
    let focus = cover
        .get("focus")
        .is_none_or(|focus| focus.as_f64().is_some_and(|f| (0.0..=100.0).contains(&f)));
    let text = |key: &str| cover.get(key).is_none_or(Value::is_string);
    reference && focus && text("credit") && text("creditUrl")
}
