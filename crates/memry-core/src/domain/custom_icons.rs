//! Custom icons: the images a person adds for notes, folders and tags (desktop
//! Step 13), after `custom-icons-api.ts`.
//!
//! A `custom_icon` is a record with no projection table (chapter 13 §13.7.11,
//! decided in Step 13 by Kaan): the icon's bytes ride in the payload as base64
//! (`data`), and **the stored payload is the record**. [`list`] reads
//! `sync_items`, which holds a local create from the moment its transaction
//! commits and an icon another device pushed from the moment it is applied, so
//! there is no second copy to keep in step. The `.memry/icons/` files are a
//! mirror the desktop shell rebuilds from this list (`notes::icons::list` in
//! memry-desktop writes every missing file); this module never touches a file.
//!
//! What a payload holds is checked at the door and not on the way out: a write
//! here accepts the formats desktop stores (`png` and `svg`, re-encoded or
//! sanitized by the shell before it gets here), a name of at most 60 UTF-16
//! units, and base64 data under a cap. A row a peer wrote is listed as it
//! stands; one that cannot be read is reported in [`CustomIcons::skipped`]
//! instead of being dropped without a word.

use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use rusqlite::{Connection, params};
use serde_json::{Value, json};

use crate::api::errors::{AuthError, StorageError};
use crate::api::tasks::Tasks;
use crate::seams::secure_store::SecureStore;
use crate::storage::Db;
use crate::storage::repositories::Change;
use crate::storage::repositories::schema::Object;
use crate::sync::outbox;

use super::notes::{self, failed, insert_local, iso, next_clock, object, tombstone_local};
use super::tasks::model::new_task_id;

/// The `(type, _)` half of every key this module writes.
pub const ITEM_TYPE: &str = "custom_icon";

/// `CUSTOM_ICON_STORED_EXTENSIONS`: normalization only ever produces these.
pub const STORED_EXTENSIONS: [&str; 2] = ["png", "svg"];

/// `CUSTOM_ICON_NAME_MAX_LENGTH`, counted in UTF-16 units as zod counts it.
pub const NAME_MAX_UNITS: usize = 60;

/// Base64 of the 2 MiB `CUSTOM_ICON_MAX_INPUT_BYTES`, which no normalised icon
/// exceeds. A bigger payload is a caller that skipped normalization.
pub const DATA_MAX_LEN: usize = (2 * 1024 * 1024 / 3 + 1) * 4;

/// One live icon.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CustomIcon {
    pub id: String,
    pub name: String,
    pub ext: String,
    /// Base64 image bytes, as the payload carries them.
    pub data: String,
    pub created_at: Option<String>,
}

/// The live icons, and the ids of live rows that could not be read as one (a
/// row the sync tier marked corrupt included). A row known by metadata only,
/// whose payload has not been pulled yet, is neither: it is not here yet.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CustomIcons {
    pub icons: Vec<CustomIcon>,
    pub skipped: Vec<String>,
}

fn invalid(what: String) -> StorageError {
    StorageError::Invalid { what }
}

fn clean_name(name: &str) -> Result<&str, StorageError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(invalid("a custom icon needs a name".to_owned()));
    }
    if name.encode_utf16().count() > NAME_MAX_UNITS {
        return Err(invalid(format!(
            "a custom icon name is at most {NAME_MAX_UNITS} characters"
        )));
    }
    Ok(name)
}

fn check_image(ext: &str, data: &str) -> Result<(), StorageError> {
    if !STORED_EXTENSIONS.contains(&ext) {
        return Err(invalid(format!(
            "a custom icon is stored as png or svg, not `{ext}`"
        )));
    }
    if data.is_empty() || data.len() > DATA_MAX_LEN {
        return Err(invalid(
            "custom icon data is empty or over the size cap".to_owned(),
        ));
    }
    STANDARD
        .decode(data)
        .map_err(|error| invalid(format!("custom icon data is not base64: {error}")))?;
    Ok(())
}

fn text(payload: &Object, key: &str) -> Option<String> {
    payload.get(key).and_then(Value::as_str).map(str::to_owned)
}

/// Every live icon, oldest first.
pub fn list(conn: &Connection) -> Result<CustomIcons, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT item_id, payload, corrupt_at IS NOT NULL FROM sync_items
              WHERE item_type = ?1 AND deleted_at IS NULL
                AND (payload IS NOT NULL OR corrupt_at IS NOT NULL)
              ORDER BY item_id",
        )
        .map_err(failed)?;
    let rows: Vec<(String, Option<String>, bool)> = statement
        .query_map([ITEM_TYPE], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)?;

    let mut found = CustomIcons::default();
    for (id, raw, corrupt) in rows {
        // A row the sync tier marked corrupt is reported like any unreadable
        // one: it is the user's icon, not noise.
        let payload = raw
            .filter(|_| !corrupt)
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .and_then(|value| value.as_object().cloned());
        let icon = payload.and_then(|payload| {
            Some(CustomIcon {
                name: text(&payload, "name")?,
                ext: text(&payload, "ext")?,
                data: text(&payload, "data")?,
                created_at: text(&payload, "createdAt"),
                id: id.clone(),
            })
        });
        match icon {
            Some(icon) => found.icons.push(icon),
            None => found.skipped.push(id),
        }
    }
    found.icons.sort_by(|a, b| {
        a.created_at
            .cmp(&b.created_at)
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(found)
}

fn require_live(conn: &Connection, id: &str) -> Result<(), StorageError> {
    let live: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sync_items
                            WHERE item_type = ?1 AND item_id = ?2 AND deleted_at IS NULL)",
            params![ITEM_TYPE, id],
            |row| row.get(0),
        )
        .map_err(failed)?;
    if live {
        Ok(())
    } else {
        Err(StorageError::NotFound {
            what: format!("custom icon {id}"),
        })
    }
}

/// Adds an icon and returns its id.
pub fn create(
    conn: &Connection,
    name: &str,
    ext: &str,
    data: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<String, StorageError> {
    let name = clean_name(name)?;
    check_image(ext, data)?;
    let id = new_task_id();
    outbox::commit(
        conn,
        &outbox::Change::upsert(ITEM_TYPE, &id),
        now_ms,
        |tx| {
            let at = iso(now_ms)?;
            let payload = object(json!({
                "name": name,
                "ext": ext,
                "data": data,
                "clock": next_clock(&Object::new(), device_id)?,
                "createdAt": at,
                "updatedAt": at,
            }));
            insert_local(tx, ITEM_TYPE, &id, payload, now_ms)
        },
    )?
    .acknowledge();
    Ok(id)
}

/// Renames a live icon; its bytes and every key this build does not model stay
/// as they were.
pub fn rename(
    conn: &Connection,
    id: &str,
    name: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let name = clean_name(name)?;
    require_live(conn, id)?;
    notes::edit(
        conn,
        ITEM_TYPE,
        id,
        vec![
            ("name", Change::set(name)),
            ("updatedAt", Change::set(iso(now_ms)?)),
        ],
        device_id,
        now_ms,
    )?
    .acknowledge();
    Ok(())
}

/// The functions of this module over one vault's database, writing under this device's
/// identity. Built by `Vault::custom_icons`; each call blocks.
pub struct CustomIconStore {
    db: Db,
    device_id: String,
}

impl CustomIconStore {
    pub(crate) fn over(db: Db, store: &Arc<dyn SecureStore>) -> Result<Self, AuthError> {
        let tasks = Tasks::over(db, store)?;
        Ok(Self {
            db: tasks.db,
            device_id: tasks.device_id,
        })
    }

    pub fn list(&self) -> Result<CustomIcons, StorageError> {
        self.db.read_blocking(list)
    }

    pub fn create(
        &self,
        name: &str,
        ext: &str,
        data: &str,
        now_ms: i64,
    ) -> Result<String, StorageError> {
        self.db
            .call_blocking(|conn| create(conn, name, ext, data, &self.device_id, now_ms))
    }

    pub fn rename(&self, id: &str, name: &str, now_ms: i64) -> Result<(), StorageError> {
        self.db
            .call_blocking(|conn| rename(conn, id, name, &self.device_id, now_ms))
    }

    pub fn delete(&self, id: &str, now_ms: i64) -> Result<(), StorageError> {
        self.db
            .call_blocking(|conn| delete(conn, id, &self.device_id, now_ms))
    }
}

/// Deletes a live icon.
pub fn delete(
    conn: &Connection,
    id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    require_live(conn, id)?;
    outbox::commit(conn, &outbox::Change::delete(ITEM_TYPE, id), now_ms, |tx| {
        tombstone_local(tx, ITEM_TYPE, id, device_id, now_ms)
    })?
    .acknowledge();
    Ok(())
}
