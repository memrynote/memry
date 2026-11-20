//! A tag's saved folder views as its definition stores them (`readTagViews`). Read by desktop's
//! tag table and by [`crate::api::tag_hub::TagHub::edit_views`]; written by
//! [`crate::domain::tag_admin::set_views`].

use rusqlite::Connection;
use serde_json::Value;

use crate::api::errors::StorageError;
use crate::domain::notes::failed;
use crate::domain::tags::tag_key;

#[derive(Debug, Clone, PartialEq)]
pub enum TagViews {
    /// No definition, or one without views.
    Absent,
    Saved(Vec<Value>),
    /// A value that is not a JSON list. It reads as none, so a bad value never makes the tag
    /// unopenable, and the next edit replaces it, as Electron's does; the shell logs it.
    Unparsed,
}

impl TagViews {
    /// The saved views; none unless [`TagViews::Saved`].
    pub fn list(self) -> Vec<Value> {
        match self {
            Self::Saved(views) => views,
            Self::Absent | Self::Unparsed => Vec::new(),
        }
    }
}

/// A tag's saved views, stored on its definition.
pub fn read(data: &Connection, tag: &str) -> Result<TagViews, StorageError> {
    let key = tag_key(tag);
    let mut statement = data
        .prepare("SELECT name, views FROM tag_definitions WHERE deleted_at IS NULL")
        .map_err(failed)?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .map_err(failed)?;
    for row in rows {
        let (name, views) = row.map_err(failed)?;
        if tag_key(&name) != key {
            continue;
        }
        return Ok(match views.map(|raw| serde_json::from_str(&raw)) {
            None => TagViews::Absent,
            Some(Ok(Value::Array(views))) => TagViews::Saved(views),
            Some(_) => TagViews::Unparsed,
        });
    }
    Ok(TagViews::Absent)
}
