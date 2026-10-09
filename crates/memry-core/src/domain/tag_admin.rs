//! Vault-wide tag management (spec 006 ST16), after desktop
//! `ipc/tags-handlers.ts`: list with counts, rename, merge, delete, colour and
//! icon. Rename, which carries `/` children along, is [`super::tag_rename`].
//!
//! Tags are matched with [`tags::same_tag`] (§13.7.7 tag identity).
//! A rename or merge rewrites every live note, journal entry and task carrying
//! the tag, each through its own writer so each ticks the clock its type
//! merges on ([`tags::set`] for the document types, [`tasks::set_tags`] for
//! tasks) and each lands in the outbox. The `tag_definition` item (id = the
//! trimmed name, folded: [`definition_id`]; older desktops keyed it by the
//! lowercased name, so lookups go through [`definitions`], never the id) is moved the way desktop's
//! `syncTagDefinitionRename` / `syncMergedTagDefinitions` move it: the old id
//! is tombstoned and the new one created carrying the old colour and icon.

use std::collections::{BTreeMap, BTreeSet};

use rusqlite::Connection;
use serde_json::{Value, json};

use crate::api::errors::StorageError;
use crate::domain::notes::{self, edit, failed, iso, object, tombstone_local};
use crate::domain::recreate::write_over_tombstone;
use crate::domain::{body_tags, tag_schema_refs, tags, tasks};
use crate::storage::repositories::{Change, sync_items};
use crate::sync::outbox;

pub const DEFINITION_TYPE: &str = "tag_definition";

/// `packages/contracts/src/tag-colors.ts`, in its order.
const PALETTE: [&str; 20] = [
    "rose",
    "coral",
    "tangerine",
    "amber",
    "lemon",
    "sage",
    "emerald",
    "mint",
    "teal",
    "cyan",
    "sky",
    "cobalt",
    "indigo",
    "violet",
    "plum",
    "magenta",
    "slate",
    "sand",
    "stone",
    "mauve",
];

/// `defaultTagColorName`: JS `hash * 31 + charCodeAt` over UTF-16 with 32-bit
/// wrap, then `Math.abs(hash) % 20`. Hashes `to_lowercase`, not the fold,
/// because desktop hashes `toLowerCase()` (`packages/contracts/src/tag-colors.ts`).
pub fn default_color(tag: &str) -> &'static str {
    let mut hash: i32 = 0;
    for unit in tag.to_lowercase().encode_utf16() {
        hash = hash.wrapping_mul(31).wrapping_add(i32::from(unit));
    }
    PALETTE[(i64::from(hash).unsigned_abs() % 20) as usize]
}

/// The id a new definition is written under: the tag's key.
pub fn definition_id(tag: &str) -> String {
    tags::tag_key(tag)
}

/// One live `tag_definition`, as the reads need it.
#[derive(Debug, Clone, PartialEq)]
pub struct Definition {
    pub id: String,
    pub color: String,
    pub icon: Option<String>,
    schema_t: Option<f64>,
    created_at: Option<i64>,
}

/// Whether `a` survives `b` among definitions whose ids fold equal, as
/// desktop's merge picks: higher schema `t`, then older `createdAt`, then the
/// smaller id by UTF-16 code unit.
fn survives(a: &Definition, b: &Definition) -> bool {
    let t = |d: &Definition| d.schema_t.unwrap_or(f64::NEG_INFINITY);
    let created = |d: &Definition| d.created_at.unwrap_or(i64::MAX);
    t(a).total_cmp(&t(b))
        .reverse()
        .then_with(|| created(a).cmp(&created(b)))
        .then_with(|| a.id.encode_utf16().cmp(b.id.encode_utf16()))
        .is_lt()
}

/// Every live definition by key, one per key. Two whose ids fold equal
/// (`ünal` and `Ünal`, `i̇ş` and `iş`) are one tag; the survivor answers for it
/// and desktop deletes the other.
pub fn definitions(conn: &Connection) -> Result<BTreeMap<String, Definition>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT d.name, d.color, d.icon, d.created_at,
                    CASE WHEN json_type(s.payload, '$.schema.t') IN ('integer', 'real')
                         THEN json_extract(s.payload, '$.schema.t') END
               FROM tag_definitions d
               LEFT JOIN sync_items s ON s.item_type = ?1 AND s.item_id = d.name
                AND json_valid(s.payload)
              WHERE d.deleted_at IS NULL",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map([DEFINITION_TYPE], |row| {
            Ok(Definition {
                id: row.get(0)?,
                color: row.get(1)?,
                icon: row.get(2)?,
                created_at: row.get(3)?,
                schema_t: row.get(4)?,
            })
        })
        .map_err(failed)?;
    let mut out: BTreeMap<String, Definition> = BTreeMap::new();
    for row in rows {
        let definition = row.map_err(failed)?;
        let key = tags::tag_key(&definition.id);
        if out.get(&key).is_none_or(|kept| survives(&definition, kept)) {
            out.insert(key, definition);
        }
    }
    Ok(out)
}

/// The surviving live definition's id for `tag`, if any.
pub(crate) fn definition_for(conn: &Connection, tag: &str) -> Result<Option<String>, StorageError> {
    Ok(definitions(conn)?.remove(&tags::tag_key(tag)).map(|d| d.id))
}

/// Every live definition id for `tag`: all of them answer to one tag.
fn definition_ids(conn: &Connection, tag: &str) -> Result<Vec<String>, StorageError> {
    let key = tags::tag_key(tag);
    let mut statement = conn
        .prepare("SELECT name FROM tag_definitions WHERE deleted_at IS NULL")
        .map_err(failed)?;
    let ids = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(failed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(failed)?;
    Ok(ids
        .into_iter()
        .filter(|id| tags::tag_key(id) == key)
        .collect())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TagSummary {
    /// The first spelling seen, or the definition's name.
    pub name: String,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub notes: i64,
    pub journals: i64,
    pub tasks: i64,
}

/// Every tag in use or defined, by name.
pub fn list(conn: &Connection) -> Result<Vec<TagSummary>, StorageError> {
    let mut by_fold: BTreeMap<String, TagSummary> = BTreeMap::new();
    // A body `#tag` counts like a payload tag, once per item (desktop's index).
    let mut counted = BTreeSet::new();
    let all = carriers(conn, None)?
        .into_iter()
        .chain(body_tags::carriers(conn)?);
    for (item_type, item_id, tag) in all {
        if !counted.insert((item_id, tags::tag_key(&tag))) {
            continue;
        }
        let entry = by_fold
            .entry(tags::tag_key(&tag))
            .or_insert_with(|| TagSummary {
                name: tag.clone(),
                color: None,
                icon: None,
                notes: 0,
                journals: 0,
                tasks: 0,
            });
        match item_type.as_str() {
            "note" => entry.notes += 1,
            "journal" => entry.journals += 1,
            _ => entry.tasks += 1,
        }
    }
    for (key, definition) in definitions(conn)? {
        let entry = by_fold.entry(key).or_insert_with(|| TagSummary {
            name: definition.id.clone(),
            color: None,
            icon: None,
            notes: 0,
            journals: 0,
            tasks: 0,
        });
        entry.color = Some(definition.color);
        entry.icon = definition.icon;
    }
    let mut out: Vec<TagSummary> = by_fold.into_values().collect();
    out.sort_by(|a, b| {
        (b.notes + b.journals + b.tasks)
            .cmp(&(a.notes + a.journals + a.tasks))
            .then_with(|| tags::fold(&a.name).cmp(&tags::fold(&b.name)))
    });
    Ok(out)
}

/// `(item_type, item_id, tag)` for every tag entry on a live note, journal or
/// task; optionally only entries matching `only`.
pub(crate) fn carriers(
    conn: &Connection,
    only: Option<&str>,
) -> Result<Vec<(String, String, String)>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT s.item_type, s.item_id, t.value
               FROM sync_items s, json_each(s.payload, '$.tags') t
              WHERE s.item_type IN ('note', 'journal', 'task')
                AND s.deleted_at IS NULL AND s.payload IS NOT NULL
                AND json_valid(s.payload)
                AND json_type(s.payload, '$.tags') = 'array'
                AND t.type = 'text'",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .map_err(failed)?;
    let mut out = Vec::new();
    for row in rows {
        let (item_type, item_id, tag): (String, String, String) = row.map_err(failed)?;
        if only.is_none_or(|wanted| tags::same_tag(wanted, &tag)) {
            out.push((item_type, item_id, tag));
        }
    }
    Ok(out)
}

pub(crate) fn current_tags(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
) -> Result<Vec<String>, StorageError> {
    if item_type == "task" {
        let stored = notes::require_payload(conn, item_type, item_id)?;
        return Ok(stored
            .object()
            .get("tags")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default());
    }
    tags::list(conn, item_type, item_id)
}

fn write_tags(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
    next: &[String],
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    if item_type == "task" {
        tasks::set_tags(conn, item_id, next, device_id, now_ms)?.acknowledge();
    } else {
        tags::set(conn, item_type, item_id, next, device_id, now_ms)?;
    }
    Ok(())
}

pub(crate) fn rewrite(
    conn: &Connection,
    source: &str,
    target: Option<&str>,
    device_id: &str,
    now_ms: i64,
) -> Result<Vec<(String, String)>, StorageError> {
    let mut items: Vec<(String, String)> = carriers(conn, Some(source))?
        .into_iter()
        .map(|(t, id, _)| (t, id))
        .collect();
    items.dedup();
    for (item_type, item_id) in &items {
        let current = current_tags(conn, item_type, item_id)?;
        let mut next: Vec<String> = Vec::with_capacity(current.len() + 1);
        for tag in current {
            if tags::same_tag(&tag, source) {
                if let Some(target) = target
                    && !next.iter().any(|t| tags::same_tag(t, target))
                {
                    next.push(target.to_owned());
                }
            } else if !target.is_some_and(|t| {
                tags::same_tag(&tag, t) && next.iter().any(|n| tags::same_tag(n, t))
            }) {
                next.push(tag);
            }
        }
        write_tags(
            conn,
            item_type,
            item_id,
            &tags::dedupe(next),
            device_id,
            now_ms,
        )?;
    }
    Ok(items)
}

pub(crate) fn item_count(items: usize) -> u32 {
    u32::try_from(items).unwrap_or(u32::MAX)
}

pub(crate) fn live_definition(conn: &Connection, id: &str) -> Result<Option<Value>, StorageError> {
    let Some(row) = sync_items::load(conn, DEFINITION_TYPE, id)? else {
        return Ok(None);
    };
    if row.deleted_at.is_some() {
        return Ok(None);
    }
    Ok(row.payload.and_then(|raw| serde_json::from_str(&raw).ok()))
}

/// Tombstones every live definition of `tag`, under any id that folds to it.
pub(crate) fn delete_definitions(
    conn: &Connection,
    tag: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    for id in definition_ids(conn, tag)? {
        outbox::commit(
            conn,
            &outbox::Change::delete(DEFINITION_TYPE, &id),
            now_ms,
            |tx| tombstone_local(tx, DEFINITION_TYPE, &id, device_id, now_ms),
        )?
        .acknowledge();
    }
    Ok(())
}

/// Creates the definition when it is missing, or edits `changes` into it.
pub(crate) fn upsert_definition(
    conn: &Connection,
    name: &str,
    template: Option<&Value>,
    changes: Vec<(&'static str, Change)>,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    if let Some(id) = definition_for(conn, name)? {
        if !changes.is_empty() {
            edit(conn, DEFINITION_TYPE, &id, changes, device_id, now_ms)?.acknowledge();
        }
        return Ok(());
    }
    let id = definition_id(name);
    let mut payload = template.cloned().unwrap_or_else(|| json!({}));
    let map = payload
        .as_object_mut()
        .ok_or_else(|| StorageError::Failed {
            what: "tag definition is not an object".into(),
        })?;
    map.insert("name".into(), json!(id));
    if !map.get("color").is_some_and(Value::is_string) {
        map.insert("color".into(), json!(default_color(&id)));
    }
    for (key, change) in changes {
        match change {
            Change::Set(value) => {
                map.insert(key.into(), value);
            }
            Change::Remove => {
                map.remove(key);
            }
        }
    }
    // A template is another name's definition: its clock is not this id's
    // lineage. The id is deterministic, so a name deleted before is created
    // over its own tombstone with a clock past the delete (#2409).
    map.remove("clock");
    map.insert("createdAt".into(), json!(iso(now_ms)?));
    map.remove("modifiedAt");
    let payload = object(payload);
    outbox::commit(
        conn,
        &outbox::Change::upsert(DEFINITION_TYPE, &id),
        now_ms,
        |tx| write_over_tombstone(tx, DEFINITION_TYPE, &id, payload, device_id, now_ms),
    )?
    .acknowledge();
    Ok(())
}

pub(crate) fn refuse(what: &str) -> StorageError {
    StorageError::Invalid {
        what: what.to_owned(),
    }
}

/// Merges `source` into `target` (desktop `tags:merge`). Returns the number of
/// items rewritten.
pub fn merge(
    conn: &Connection,
    source: &str,
    target: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<u32, StorageError> {
    let target = target.trim();
    if target.is_empty() || tags::same_tag(source.trim(), target) {
        return Err(refuse("merge needs two different tags"));
    }
    let count = item_count(rewrite(conn, source, Some(target), device_id, now_ms)?.len());
    delete_definitions(conn, source, device_id, now_ms)?;
    upsert_definition(conn, target, None, Vec::new(), device_id, now_ms)?;
    tag_schema_refs::rewrite_definitions(conn, source, Some(target), device_id, now_ms)?;
    Ok(count)
}

/// Removes a tag from every item and deletes its definition.
pub fn delete(
    conn: &Connection,
    tag: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<u32, StorageError> {
    let count = item_count(rewrite(conn, tag, None, device_id, now_ms)?.len());
    delete_definitions(conn, tag, device_id, now_ms)?;
    Ok(count)
}

/// A colour picked by a person (`colorAuthored: true`).
pub fn set_color(
    conn: &Connection,
    tag: &str,
    color: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    upsert_definition(
        conn,
        tag,
        None,
        vec![
            ("color", Change::set(color)),
            ("colorAuthored", Change::set(true)),
        ],
        device_id,
        now_ms,
    )
}

/// An emoji or `icon:Name`; `None` clears to `null`.
pub fn set_icon(
    conn: &Connection,
    tag: &str,
    icon: Option<&str>,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let value = icon.map(Value::from).unwrap_or(Value::Null);
    upsert_definition(
        conn,
        tag,
        None,
        vec![("icon", Change::Set(value))],
        device_id,
        now_ms,
    )
}

#[cfg(test)]
#[path = "tag_admin_tests.rs"]
mod tests;
