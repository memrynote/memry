//! App settings: one reader and writer for every settings group of a vault.
//!
//! A group's fields have exactly one owner each:
//!
//! - a **syncable** field (`syncable.rs`) lives in the synced settings item, with its
//!   own per-path clock (chapter 06 §6.9), and is never stored in `local_settings`;
//! - every other field, **including one this build does not know**, lives in the
//!   group's single JSON blob in `local_settings`.
//!
//! [`AppSettings::get_group`] lays defaults, then the blob, then the synced values.
//! [`AppSettings::set_group`] validates the whole patch first, then writes the synced
//! paths and the blob in one transaction, so a refused patch writes nothing and an
//! accepted one is never half applied.
//!
//! Not exported through UniFFI: iOS reads and writes settings through
//! [`crate::api::settings::Settings`].

mod defaults;
mod groups;
mod syncable;

#[cfg(test)]
mod tests;

use std::sync::Arc;

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value};

use crate::api::errors::{AuthError, StorageError};
use crate::api::tasks::Tasks;
use crate::api::tasks_write::now_ms;
use crate::domain::settings;
use crate::seams::secure_store::SecureStore;
use crate::storage::Db;
use crate::storage::repositories::Change;

use groups::Group;

/// What a write touched: the group and every field of the patch, in patch
/// order. A map field appears once, whatever number of entries the patch held.
/// Field names only, never values, so the shell can broadcast and count it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettingsChange {
    pub group: String,
    pub fields: Vec<String>,
}

/// A group as the renderer reads it.
#[derive(Debug, Clone, PartialEq)]
pub struct GroupRead {
    pub value: Value,
    /// The stored blob would not parse as an object, so it was deleted and the
    /// defaults returned (desktop's `group_corrupted_reset`). The core has no
    /// logger: the shell logs `settings_group_corrupted_<group>`.
    pub corrupt_reset: bool,
}

#[derive(Clone)]
pub struct AppSettings {
    db: Db,
    device_id: String,
}

fn invalid(what: String) -> StorageError {
    StorageError::Invalid { what }
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

fn group_of(name: &str) -> Result<&'static Group, StorageError> {
    groups::find(name).ok_or_else(|| invalid(format!("settings group `{name}` is not known")))
}

/// Every group name, in table order.
pub fn group_names() -> Vec<&'static str> {
    groups::GROUPS.iter().map(|group| group.name).collect()
}

impl AppSettings {
    /// Built by [`crate::api::vault::Vault::app_settings`]. The device id is the
    /// one [`crate::api::settings::Settings`] ticks, so both write the same
    /// clock entry.
    pub(crate) fn over(db: Db, store: &Arc<dyn SecureStore>) -> Result<Self, AuthError> {
        let tasks = Tasks::over(db, store)?;
        Ok(Self {
            db: tasks.db,
            device_id: tasks.device_id,
        })
    }

    #[cfg(test)]
    fn for_test(db: Db, device_id: &str) -> Self {
        Self {
            db,
            device_id: device_id.to_owned(),
        }
    }

    /// One group: defaults, then the local blob, then the synced fields.
    pub fn get_group(&self, group: &str) -> Result<GroupRead, StorageError> {
        let spec = group_of(group)?;
        let (mut map, corrupt) = self.db.read_blocking(|conn| read_group(conn, spec))?;
        if let Some(bad) = &corrupt {
            // Only the exact value that failed: a newer write must survive.
            self.db.call_blocking(|conn| {
                conn.execute(
                    "DELETE FROM local_settings WHERE key = ?1 AND value = ?2",
                    params![spec.name, bad],
                )
                .map_err(failed)?;
                Ok(())
            })?;
        }
        for hidden in spec.maps.iter().filter(|map| !map.in_group) {
            map.remove(hidden.name);
        }
        Ok(GroupRead {
            value: Value::Object(map),
            corrupt_reset: corrupt.is_some(),
        })
    }

    /// Writes a patch of one group. See the module docs for the split.
    ///
    /// A map field takes an object of entries; each entry is written under its
    /// own clock and a `null` entry is the delete marker. Entries absent from
    /// the patch are untouched. Any other field is replaced whole.
    pub fn set_group(
        &self,
        group: &str,
        patch: Map<String, Value>,
    ) -> Result<SettingsChange, StorageError> {
        let spec = group_of(group)?;
        let defaults = spec_defaults(spec);
        let mut synced: Vec<(String, Value)> = Vec::new();
        let mut local = Map::new();
        for (field, value) in &patch {
            if let Some(map) = spec.map(field) {
                let entries = value.as_object().ok_or_else(|| {
                    invalid(format!("settings `{group}.{field}` must be an object"))
                })?;
                for (entry, entry_value) in entries {
                    if !(map.entry_ok)(entry) {
                        return Err(invalid(format!(
                            "settings `{group}.{field}`: `{entry}` is not a valid entry"
                        )));
                    }
                    synced.push((format!("{group}.{field}.{entry}"), entry_value.clone()));
                }
                continue;
            }
            validate(group, field, value, defaults.get(field))?;
            if spec.is_syncable(field) {
                synced.push((format!("{group}.{field}"), value.clone()));
            } else {
                local.insert(field.clone(), value.clone());
            }
        }

        let device = self.device_id.clone();
        let spec_name = spec.name;
        self.db.call_blocking(move |conn| {
            let now = now_ms();
            if !synced.is_empty() {
                let changes: Vec<(&str, Change)> = synced
                    .iter()
                    .map(|(path, value)| (path.as_str(), Change::Set(value.clone())))
                    .collect();
                let (_, moved) = settings::apply_many(conn, &changes, &device, now, |tx| {
                    write_local(tx, spec_name, &local, now)
                })?;
                if moved {
                    return Ok(());
                }
            }
            write_local(conn, spec_name, &local, now)
        })?;

        Ok(SettingsChange {
            group: spec.name.to_owned(),
            fields: patch.keys().cloned().collect(),
        })
    }

    /// One value by `<group>.<field>` or `<group>.<field>.<entry>`.
    pub fn get_path(&self, path: &str) -> Result<Option<Value>, StorageError> {
        let (group, field, entry) = split_path(path)?;
        let spec = group_of(group)?;
        let (map, _) = self.db.read_blocking(|conn| read_group(conn, spec))?;
        let Some(value) = map.get(field) else {
            return Ok(None);
        };
        Ok(match entry {
            None => Some(value.clone()),
            Some(entry) => value.as_object().and_then(|o| o.get(entry)).cloned(),
        })
    }

    /// One value by path, with [`AppSettings::set_group`]'s rules.
    pub fn set_path(&self, path: &str, value: Value) -> Result<SettingsChange, StorageError> {
        let (group, field, entry) = split_path(path)?;
        let patch_value = match entry {
            None => value,
            Some(entry) => Value::Object(Map::from_iter([(entry.to_owned(), value)])),
        };
        self.set_group(group, Map::from_iter([(field.to_owned(), patch_value)]))
    }
}

fn split_path(path: &str) -> Result<(&str, &str, Option<&str>), StorageError> {
    let mut parts = path.splitn(3, '.');
    match (parts.next(), parts.next(), parts.next()) {
        (Some(group), Some(field), entry) if !group.is_empty() && !field.is_empty() => {
            Ok((group, field, entry.filter(|entry| !entry.is_empty())))
        }
        _ => Err(invalid(format!("`{path}` is not a settings path"))),
    }
}

fn spec_defaults(spec: &Group) -> Map<String, Value> {
    match (spec.defaults)() {
        Value::Object(map) => map,
        _ => unreachable!("a group default is an object"),
    }
}

/// Type and range checks. A `null` default means "any value": the field is
/// nullable and its other type is not recorded. A field with no default is
/// unknown to this build and is kept as written.
fn validate(
    group: &str,
    field: &str,
    value: &Value,
    default: Option<&Value>,
) -> Result<(), StorageError> {
    let refuse = |why: &str| invalid(format!("settings `{group}.{field}`: {why}"));
    let Some(default) = default else {
        return Ok(());
    };
    if !default.is_null() {
        let same = matches!(
            (default, value),
            (Value::Bool(_), Value::Bool(_))
                | (Value::Number(_), Value::Number(_))
                | (Value::String(_), Value::String(_))
                | (Value::Array(_), Value::Array(_))
                | (Value::Object(_), Value::Object(_))
        );
        if !same {
            return Err(refuse("wrong type"));
        }
    }
    if let (Some((min, max)), Some(number)) = (groups::range(group, field), value.as_f64())
        && !(min..=max).contains(&number)
    {
        return Err(refuse(&format!("{number} is outside {min} to {max}")));
    }
    Ok(())
}

/// Defaults, then the blob, then the synced values. The second element is the
/// raw blob text when it would not parse as an object.
fn read_group(
    conn: &Connection,
    spec: &Group,
) -> Result<(Map<String, Value>, Option<String>), StorageError> {
    let mut map = spec_defaults(spec);
    for map_field in spec.maps {
        map.entry(map_field.name)
            .or_insert_with(|| Value::Object(Map::new()));
    }

    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM local_settings WHERE key = ?1",
            params![spec.name],
            |row| row.get(0),
        )
        .optional()
        .map_err(failed)?;
    let mut corrupt = None;
    if let Some(raw) = raw {
        match serde_json::from_str::<Value>(&raw) {
            Ok(Value::Object(stored)) => {
                for (field, value) in stored {
                    // One owner per field: a synced field is never read from here.
                    if !spec.is_syncable(&field) && spec.map(&field).is_none() {
                        map.insert(field, value);
                    }
                }
            }
            _ => corrupt = Some(raw),
        }
    }

    let all = settings::all(conn)?;
    if let Some(Value::Object(synced)) = all.get(spec.name) {
        for field in spec.syncable {
            match synced.get(*field) {
                None | Some(Value::Null) => {}
                Some(value) => {
                    map.insert((*field).to_owned(), value.clone());
                }
            }
        }
        for map_field in spec.maps {
            if let Some(Value::Object(entries)) = synced.get(map_field.name) {
                let Some(Value::Object(target)) = map.get_mut(map_field.name) else {
                    continue;
                };
                for (entry, value) in entries {
                    if (map_field.entry_ok)(entry) {
                        target.insert(entry.clone(), value.clone());
                    }
                }
            }
        }
    }
    Ok((map, corrupt))
}

/// Merges `patch` into the group's blob. An unreadable blob is replaced: the
/// caller is writing a new value, and a read would have reset it anyway.
fn write_local(
    conn: &Connection,
    group: &str,
    patch: &Map<String, Value>,
    now: i64,
) -> Result<(), StorageError> {
    if patch.is_empty() {
        return Ok(());
    }
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM local_settings WHERE key = ?1",
            params![group],
            |row| row.get(0),
        )
        .optional()
        .map_err(failed)?;
    let mut blob = match raw.as_deref().map(serde_json::from_str::<Value>) {
        Some(Ok(Value::Object(stored))) => stored,
        _ => Map::new(),
    };
    let before = blob.clone();
    for (field, value) in patch {
        blob.insert(field.clone(), value.clone());
    }
    if raw.is_some() && blob == before {
        return Ok(());
    }
    conn.execute(
        "INSERT INTO local_settings (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![group, Value::Object(blob).to_string(), now],
    )
    .map_err(failed)?;
    Ok(())
}
