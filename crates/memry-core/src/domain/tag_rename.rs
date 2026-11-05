//! Tag rename, after desktop's `renameTagEverywhere`
//! (`apps/desktop/src/main/tags/rename-tag.ts`).
//!
//! Renaming `old` to `new` renames every `old/…` child too, each to `new/…`:
//! the payload tags of notes, journals and tasks ([`tag_admin::rewrite`]), the
//! `tag_definition` items, the schema references of other tags
//! ([`tag_schema_refs`]) and the body `#tags` ([`tag_body_rename`]). A new name
//! that already exists merges, as `tags:merge` does: the items join it and its
//! definition is kept, the renamed one tombstoned. Children go first, so
//! renaming `a` to `a/b` moves an existing `a/b` to `a/b/b` before `a` lands
//! on `a/b`.
//!
//! Desktop, whose note files hold the tags too, renames in parts: [`rename_shared`] for what no
//! file holds, then each of the [`holders`] with its file, one at a time ([`rename_holder`] for
//! the record). The rename in progress is recorded with its plan ([`begin`]): the name pairs its
//! shared part has left and the holders not renamed yet, each struck off as it is done, so that
//! an interrupted rename is finished at the next open by visiting only what is left. Renaming
//! again what was renamed is not a no-op when the new name sits under the old one (`a` to
//! `a/b` would make `a/b/b`), which is why the plan is kept rather than recomputed.

use std::collections::BTreeSet;

use rusqlite::{Connection, OptionalExtension as _, params};
use serde::{Deserialize, Serialize};

use crate::api::errors::StorageError;
use crate::domain::notes::failed;
use crate::domain::tag_admin::{
    carriers, definition_for, delete_definitions, item_count, live_definition, refuse, rewrite,
    rewrite_of, upsert_definition,
};
use crate::domain::tag_body_rename::renamed_tag;
use crate::domain::{body_tags, tag_body_rename, tag_schema_refs, tags};

/// The `meta` key of the rename in progress (desktop's `tags.renameJob` setting); an older
/// build ignores it.
const JOB: &str = "tags.rename_job";

/// A rename asked for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameJob {
    pub from: String,
    pub to: String,
    pub run_id: String,
}

/// A live note or journal day a rename reaches.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Holder {
    pub id: String,
    pub day: bool,
}

/// The rename in progress and what it has left: the name pairs of its shared part (children
/// first) and the holders whose record has not taken the new name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenamePlan {
    #[serde(flatten)]
    pub job: RenameJob,
    #[serde(default)]
    pairs: Vec<(String, String)>,
    #[serde(default)]
    pub holders: Vec<Holder>,
}

fn pairs(conn: &Connection, old: &str, new: &str) -> Result<Vec<(String, String)>, StorageError> {
    let old_key = tags::fold(old.trim());
    let mut names: Vec<String> = carriers(conn, None)?
        .into_iter()
        .chain(body_tags::carriers(conn)?)
        .map(|(_, _, tag)| tag)
        .collect();
    let mut statement = conn
        .prepare("SELECT name FROM tag_definitions WHERE deleted_at IS NULL")
        .map_err(failed)?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(failed)?;
    for row in rows {
        names.push(row.map_err(failed)?);
    }
    let mut seen = BTreeSet::from([old_key.clone()]);
    let mut out = vec![(old_key.clone(), new.to_owned())];
    for name in names {
        let name = name.trim();
        let key = tags::fold(name);
        // Segment-wise, never at `old_key.len()`: the fold can change length.
        let depth = old_key.split('/').count();
        let segments: Vec<&str> = name.split('/').collect();
        let child = segments.len() > depth && tags::fold(&segments[..depth].join("/")) == old_key;
        if child && seen.insert(key.clone()) {
            out.push((key, format!("{new}/{}", segments[depth..].join("/"))));
        }
    }
    out.sort_by_key(|(from, _)| std::cmp::Reverse(from.matches('/').count()));
    Ok(out)
}

fn move_definition(
    conn: &Connection,
    from: &str,
    to: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    if tags::same_tag(from.trim(), to.trim()) {
        return Ok(());
    }
    let Some(from_id) = definition_for(conn, from)? else {
        return Ok(());
    };
    let Some(mut template) = live_definition(conn, &from_id)? else {
        return Ok(());
    };
    if let Some(map) = template.as_object_mut() {
        map.remove("clock");
    }
    if definition_for(conn, to)?.is_none() {
        upsert_definition(conn, to, Some(&template), Vec::new(), device_id, now_ms)?;
    }
    delete_definitions(conn, from, device_id, now_ms)
}

/// Records `job` as the rename in progress, with its plan: its name pairs and `holders` (as
/// [`holders`] listed them before anything was renamed). Another rename recorded (other names)
/// is answered and nothing is written; the same one keeps what it has left, under the new run.
pub fn begin(
    conn: &Connection,
    job: &RenameJob,
    holders: Vec<Holder>,
) -> Result<Option<RenameJob>, StorageError> {
    if job.to.trim().is_empty() {
        return Err(refuse("a tag name cannot be empty"));
    }
    let tx = conn.unchecked_transaction().map_err(failed)?;
    let plan = match recorded(&tx)? {
        Some(plan) if plan.job.from != job.from || plan.job.to != job.to => {
            return Ok(Some(plan.job));
        }
        Some(plan) => RenamePlan {
            job: job.clone(),
            ..plan
        },
        None => RenamePlan {
            job: job.clone(),
            pairs: pairs(&tx, &job.from, job.to.trim())?,
            holders,
        },
    };
    save(&tx, &plan)?;
    tx.commit().map_err(failed)?;
    Ok(None)
}

fn save(conn: &Connection, plan: &RenamePlan) -> Result<(), StorageError> {
    let value = serde_json::to_string(plan).map_err(|error| StorageError::Failed {
        what: format!("a tag rename will not serialise: {error}"),
    })?;
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![JOB, value],
    )
    .map_err(failed)?;
    Ok(())
}

/// The rename in progress. A value that does not read is an error, which [`finish`] clears.
pub fn recorded(conn: &Connection) -> Result<Option<RenamePlan>, StorageError> {
    let raw: Option<String> = conn
        .query_row("SELECT value FROM meta WHERE key = ?1", [JOB], |row| {
            row.get(0)
        })
        .optional()
        .map_err(failed)?;
    raw.map(|raw| {
        serde_json::from_str(&raw).map_err(|error| StorageError::Failed {
            what: format!("the recorded tag rename does not read: {error}"),
        })
    })
    .transpose()
}

/// No rename is in progress.
pub fn finish(conn: &Connection) -> Result<(), StorageError> {
    conn.execute("DELETE FROM meta WHERE key = ?1", [JOB])
        .map_err(failed)?;
    Ok(())
}

/// The part of the recorded rename that no file holds, for desktop: the tasks' tags, the
/// definitions and the schema references, pair by pair, each struck off once done. A pair run
/// twice (stopped before it was struck off) finds nothing the second time: its old name is
/// matched whole, and the pairs under it ran before it.
pub fn rename_shared(conn: &Connection, device_id: &str, now_ms: i64) -> Result<(), StorageError> {
    while let Some(mut plan) = recorded(conn)?
        && let Some((from, to)) = plan.pairs.first().cloned()
    {
        rewrite_of(conn, &["task"], &from, Some(&to), device_id, now_ms)?;
        move_definition(conn, &from, &to, device_id, now_ms)?;
        tag_schema_refs::rewrite_definitions(conn, &from, Some(&to), device_id, now_ms)?;
        plan.pairs.remove(0);
        save(conn, &plan)?;
    }
    Ok(())
}

/// The recorded rename in the record of the holder `id` ([`tags::rename`]), and the holder
/// struck off, in one transaction; `false` when the record did not change. A holder the plan
/// no longer lists is left alone: its record took the new name already.
pub fn rename_holder(
    conn: &Connection,
    id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<bool, StorageError> {
    let tx = conn.unchecked_transaction().map_err(failed)?;
    let Some(mut plan) = recorded(&tx)? else {
        return Ok(false);
    };
    let Some(at) = plan.holders.iter().position(|holder| holder.id == id) else {
        return Ok(false);
    };
    let (from, to) = (&plan.job.from, plan.job.to.trim());
    let wrote = tags::rename(&tx, id, from, to, device_id, now_ms)?;
    plan.holders.remove(at);
    save(&tx, &plan)?;
    tx.commit().map_err(failed)?;
    Ok(wrote)
}

/// Strikes the holder `id` off the recorded rename without renaming it: one a rename could not
/// write, which keeps the old name.
pub fn skip_holder(conn: &Connection, id: &str) -> Result<(), StorageError> {
    let tx = conn.unchecked_transaction().map_err(failed)?;
    if let Some(mut plan) = recorded(&tx)? {
        plan.holders.retain(|holder| holder.id != id);
        save(&tx, &plan)?;
    }
    tx.commit().map_err(failed)
}

/// The live notes and journal days carrying `old` or a child of it, by id: in the record's
/// tags, the body's `#tags`, or a note's header tags as the index last read them from its file
/// (`headers`, by note id), the only place a file the open adopted carries them (#3825). A
/// day's header is the author's text and never counts: its record owns its tags (#3931).
pub fn holders(
    conn: &Connection,
    headers: impl IntoIterator<Item = (String, Vec<String>)>,
    old: &str,
) -> Result<Vec<Holder>, StorageError> {
    let under = |tag: &str| renamed_tag(tag, old, old).is_some();
    let carried: BTreeSet<String> = carriers(conn, None)?
        .into_iter()
        .chain(body_tags::carriers(conn)?)
        .filter(|(item_type, _, tag)| item_type != "task" && under(tag))
        .map(|(_, id, _)| id)
        .collect();
    let headed: BTreeSet<String> = headers
        .into_iter()
        .filter(|(_, tags)| tags.iter().any(|tag| under(tag)))
        .map(|(id, _)| id)
        .collect();
    let mut statement = conn
        .prepare(
            "SELECT item_type FROM sync_items WHERE item_id = ?1 AND deleted_at IS NULL
                AND item_type IN ('note', 'journal')",
        )
        .map_err(failed)?;
    let mut out = Vec::new();
    for id in carried.union(&headed) {
        let item_type: Option<String> = statement
            .query_row([id], |row| row.get(0))
            .optional()
            .map_err(failed)?;
        let Some(item_type) = item_type else { continue };
        let day = item_type == "journal";
        if !day || carried.contains(id) {
            out.push(Holder {
                id: id.clone(),
                day,
            });
        }
    }
    Ok(out)
}

/// Renames a tag and its children everywhere. Returns the number of items
/// whose tags were rewritten.
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
    let mut items = BTreeSet::new();
    for (from, to) in pairs(conn, old, new)? {
        items.extend(rewrite(conn, &from, Some(&to), device_id, now_ms)?);
        move_definition(conn, &from, &to, device_id, now_ms)?;
        tag_schema_refs::rewrite_definitions(conn, &from, Some(&to), device_id, now_ms)?;
    }
    tag_body_rename::rewrite_bodies(conn, old, new, device_id, now_ms);
    Ok(item_count(items.len()))
}

#[cfg(test)]
#[path = "tag_rename_tests.rs"]
mod tests;
