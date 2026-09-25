//! Vault-wide tag management (spec 006 ST16), after desktop
//! `ipc/tags-handlers.ts`: list with counts, rename, merge, delete, colour and
//! icon.
//!
//! Tags are matched with [`tags::same_tag`] (ASCII fold, `COLLATE NOCASE`).
//! A rename or merge rewrites every live note, journal entry and task carrying
//! the tag, each through its own writer so each ticks the clock its type
//! merges on ([`tags::set`] for the document types, [`tasks::set_tags`] for
//! tasks) and each lands in the outbox. The `tag_definition` item (id = the
//! lowercased, trimmed name, as desktop keys it) is moved the way desktop's
//! `syncTagDefinitionRename` / `syncMergedTagDefinitions` move it: the old id
//! is tombstoned and the new one created carrying the old colour and icon.

use std::collections::BTreeMap;

use rusqlite::Connection;
use serde_json::{Value, json};

use crate::api::errors::StorageError;
use crate::domain::notes::{self, edit, failed, iso, object, tombstone_local};
use crate::domain::recreate::write_over_tombstone;
use crate::domain::{tags, tasks};
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
/// wrap, then `Math.abs(hash) % 20`.
pub fn default_color(tag: &str) -> &'static str {
    let mut hash: i32 = 0;
    for unit in tag.to_lowercase().encode_utf16() {
        hash = hash.wrapping_mul(31).wrapping_add(i32::from(unit));
    }
    PALETTE[(i64::from(hash).unsigned_abs() % 20) as usize]
}

/// The definition id desktop uses: lowercased and trimmed.
pub fn definition_id(tag: &str) -> String {
    tag.trim().to_lowercase()
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
    for (item_type, _, tag) in carriers(conn, None)? {
        let entry = by_fold
            .entry(tags::fold(&tag))
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
    let mut statement = conn
        .prepare("SELECT name, color, icon FROM tag_definitions WHERE deleted_at IS NULL")
        .map_err(failed)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(failed)?;
    for row in rows {
        let (name, color, icon) = row.map_err(failed)?;
        let entry = by_fold
            .entry(tags::fold(&name))
            .or_insert_with(|| TagSummary {
                name: name.clone(),
                color: None,
                icon: None,
                notes: 0,
                journals: 0,
                tasks: 0,
            });
        entry.color = color;
        entry.icon = icon;
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
fn carriers(
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

fn current_tags(
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

/// Replaces `source` by `target` on every carrier. Returns the item count.
fn rewrite(
    conn: &Connection,
    source: &str,
    target: Option<&str>,
    device_id: &str,
    now_ms: i64,
) -> Result<u32, StorageError> {
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
    Ok(u32::try_from(items.len()).unwrap_or(u32::MAX))
}

fn live_definition(conn: &Connection, id: &str) -> Result<Option<Value>, StorageError> {
    let Some(row) = sync_items::load(conn, DEFINITION_TYPE, id)? else {
        return Ok(None);
    };
    if row.deleted_at.is_some() {
        return Ok(None);
    }
    Ok(row.payload.and_then(|raw| serde_json::from_str(&raw).ok()))
}

fn delete_definition(
    conn: &Connection,
    id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    if live_definition(conn, id)?.is_none() {
        return Ok(());
    }
    outbox::commit(
        conn,
        &outbox::Change::delete(DEFINITION_TYPE, id),
        now_ms,
        |tx| tombstone_local(tx, DEFINITION_TYPE, id, device_id, now_ms),
    )?
    .acknowledge();
    Ok(())
}

/// Creates the definition when it is missing, or edits `changes` into it.
fn upsert_definition(
    conn: &Connection,
    name: &str,
    template: Option<&Value>,
    changes: Vec<(&'static str, Change)>,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let id = definition_id(name);
    if live_definition(conn, &id)?.is_some() {
        if !changes.is_empty() {
            edit(conn, DEFINITION_TYPE, &id, changes, device_id, now_ms)?.acknowledge();
        }
        return Ok(());
    }
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

fn refuse(what: &str) -> StorageError {
    StorageError::Invalid {
        what: what.to_owned(),
    }
}

/// Renames a tag everywhere. Returns the number of items rewritten.
pub fn rename(
    conn: &Connection,
    old: &str,
    new: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<u32, StorageError> {
    let new = new.trim();
    if new.is_empty() {
        return Err(refuse("a tag name cannot be empty"));
    }
    let count = rewrite(conn, old, Some(new), device_id, now_ms)?;
    let old_id = definition_id(old);
    if old_id != definition_id(new)
        && let Some(snapshot) = live_definition(conn, &old_id)?
    {
        let mut template = snapshot;
        if let Some(map) = template.as_object_mut() {
            map.remove("clock");
        }
        if live_definition(conn, &definition_id(new))?.is_none() {
            upsert_definition(conn, new, Some(&template), Vec::new(), device_id, now_ms)?;
        }
        delete_definition(conn, &old_id, device_id, now_ms)?;
    }
    Ok(count)
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
    let count = rewrite(conn, source, Some(target), device_id, now_ms)?;
    delete_definition(conn, &definition_id(source), device_id, now_ms)?;
    upsert_definition(conn, target, None, Vec::new(), device_id, now_ms)?;
    Ok(count)
}

/// Removes a tag from every item and deletes its definition.
pub fn delete(
    conn: &Connection,
    tag: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<u32, StorageError> {
    let count = rewrite(conn, tag, None, device_id, now_ms)?;
    delete_definition(conn, &definition_id(tag), device_id, now_ms)?;
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
mod tests {
    use super::*;
    use crate::storage::repositories::InboundRecord;
    use crate::storage::{Db, open_data, test_support::temp_dir};

    const NOW: i64 = 1_760_000_000_000;

    fn seed(db: &Db, item_type: &str, id: &str, payload: &str) {
        db.call_blocking(|conn| {
            sync_items::apply_remote(
                conn,
                &InboundRecord {
                    item_type: item_type.into(),
                    item_id: id.into(),
                    payload_json: payload.into(),
                    server_cursor: Some(1),
                    signer_device_id: Some("desk".into()),
                    updated_at: NOW,
                    deleted_at: None,
                },
                NOW,
            )?;
            Ok(())
        })
        .expect("seed");
    }

    fn vault(label: &str) -> (Db, crate::storage::test_support::TempDir) {
        let dir = temp_dir(label);
        let db = open_data(&dir.path().join("data.db")).expect("open");
        seed(
            &db,
            "note",
            "n1",
            r#"{"title":"a","tags":["Job","ideas"],"clock":{"desk":1}}"#,
        );
        seed(
            &db,
            "note",
            "n2",
            r#"{"title":"b","tags":["work","JOB"],"clock":{"desk":1}}"#,
        );
        seed(
            &db,
            "journal",
            "j1",
            r#"{"date":"2026-09-24","tags":["job"],"clock":{"desk":1}}"#,
        );
        seed(
            &db,
            "tag_definition",
            "job",
            r##"{"name":"job","color":"#ff0000","icon":"💼","clock":{"desk":1}}"##,
        );
        (db, dir)
    }

    fn tags_of(db: &Db, item_type: &str, id: &str) -> Vec<String> {
        db.call_blocking(|conn| current_tags(conn, item_type, id))
            .expect("tags")
    }

    #[test]
    fn the_default_colour_matches_the_contract_hash() {
        // tag-colors.ts: defaultTagColorName('work') and ('ideas').
        assert!(PALETTE.contains(&default_color("work")));
        assert_eq!(default_color("Work"), default_color("work"));
    }

    #[test]
    fn list_counts_every_carrier_case_insensitively_and_reads_definitions() {
        let (db, _d) = vault("tags-list");
        let listed = db.call_blocking(|c| list(c)).expect("list");
        let job = listed
            .iter()
            .find(|t| tags::same_tag(&t.name, "job"))
            .expect("job");
        assert_eq!((job.notes, job.journals, job.tasks), (2, 1, 0));
        assert_eq!(job.color.as_deref(), Some("#ff0000"));
    }

    #[test]
    fn rename_rewrites_every_item_and_moves_the_definition() {
        let (db, _d) = vault("tags-rename");
        let count = db
            .call_blocking(|c| rename(c, "job", "career", "phone", NOW + 1))
            .expect("rename");
        assert_eq!(count, 3);
        assert_eq!(tags_of(&db, "note", "n1"), vec!["career", "ideas"]);
        assert_eq!(tags_of(&db, "journal", "j1"), vec!["career"]);
        db.call_blocking(|c| {
            assert!(live_definition(c, "job")?.is_none());
            let moved = live_definition(c, "career")?.expect("career");
            assert_eq!(moved["color"], json!("#ff0000"));
            assert_eq!(moved["icon"], json!("💼"));
            Ok(())
        })
        .expect("defs");
    }

    #[test]
    fn merge_into_an_existing_tag_dedupes_and_counts_items() {
        let (db, _d) = vault("tags-merge");
        let count = db
            .call_blocking(|c| merge(c, "job", "Work", "phone", NOW + 1))
            .expect("merge");
        assert_eq!(count, 3);
        // n2 had both: one `work`, spelled as it already was.
        assert_eq!(tags_of(&db, "note", "n2"), vec!["work"]);
        assert_eq!(tags_of(&db, "note", "n1"), vec!["Work", "ideas"]);
        db.call_blocking(|c| {
            assert!(live_definition(c, "job")?.is_none());
            assert!(live_definition(c, "work")?.is_some());
            Ok(())
        })
        .expect("defs");
        assert!(
            db.call_blocking(|c| merge(c, "work", "WORK", "phone", NOW + 2))
                .is_err()
        );
    }

    #[test]
    fn delete_removes_it_everywhere_and_colour_icon_create_a_definition() {
        let (db, _d) = vault("tags-delete");
        let count = db
            .call_blocking(|c| delete(c, "JOB", "phone", NOW + 1))
            .expect("delete");
        assert_eq!(count, 3);
        assert_eq!(tags_of(&db, "note", "n2"), vec!["work"]);
        db.call_blocking(|c| {
            set_color(c, "ideas", "sage", "phone", NOW + 2)?;
            set_icon(c, "ideas", Some("💡"), "phone", NOW + 3)?;
            let def = live_definition(c, "ideas")?.expect("ideas");
            assert_eq!(def["color"], json!("sage"));
            assert_eq!(def["colorAuthored"], json!(true));
            assert_eq!(def["icon"], json!("💡"));
            set_icon(c, "ideas", None, "phone", NOW + 4)?;
            assert_eq!(
                live_definition(c, "ideas")?.expect("ideas")["icon"],
                Value::Null
            );
            Ok(())
        })
        .expect("defs");
    }
}
