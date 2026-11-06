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
//! `a/b` would make `a/b/b`), which is why the plan is kept rather than recomputed: a holder the
//! rename could not write stays listed and the rename stays recorded, and a [`begin`] of the
//! same rename (or the next open) tries what is left, never a fresh plan.
//!
//! A holder's file and its record are two writes: a run stopped after the file and before
//! [`rename_holder`] leaves the holder listed, and writing its file again would rename it twice.
//! So the file edit is recorded first ([`start_holder`]: the file's hashes before and after,
//! and the record's lists), and a resume that finds the after text renames the record alone.
//!
//! The job is one `meta` row; each listed holder and each begun file edit is a row of its own
//! (keyed by the note id), so a holder's start and strike-off write one small row however many
//! holders the rename has.

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
use crate::domain::{body_tags, body_write, tag_body_rename, tag_schema_refs, tags};

/// The `meta` key of the rename in progress (desktop's `tags.renameJob` setting); an older
/// build ignores it, and the rows below.
const JOB: &str = "tags.rename_job";
/// The key prefix of a holder not renamed yet (`tags.rename_holder:<id>`, `note` or
/// `journal`).
const HOLDER: &str = "tags.rename_holder:";
/// The key prefix of a holder's file edit begun (`tags.rename_started:<id>`, a [`Started`]).
const STARTED: &str = "tags.rename_started:";

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
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenamePlan {
    pub job: RenameJob,
    pairs: Vec<(String, String)>,
    pub holders: Vec<Holder>,
}

/// The job row. Every field is required and no other is taken, so a row of another layout
/// (one without a plan, or with its holders inline) does not read, never as nothing left to do.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Job {
    from: String,
    to: String,
    run_id: String,
    pairs: Vec<(String, String)>,
}

/// What the job row holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Recorded {
    Plan(RenamePlan),
    /// A row that does not read, with why; only clearing it ([`finish`]) helps.
    Unreadable(String),
}

/// A holder's file edit begun and not yet struck off: the hashes of the file's text before and
/// after it, so a resume that finds the after text knows the file took the rename already, and
/// its record's lists then: an outside edit read meanwhile may have carried the file's renamed
/// header into the record (#3825), or changed it otherwise.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Started {
    pub before: String,
    pub after: String,
    tags: Vec<String>,
    pinned: Option<Vec<String>>,
}

fn holds(list: &[String], tag: &str) -> bool {
    list.iter().any(|held| tags::same_tag(held, tag))
}

/// A begun holder's list: what the rename made of `begun`, less what an edit since removed and
/// plus what it added (`now`), so an edit read into the record meanwhile keeps its change,
/// whether it came in the old name's terms (a day's header, which keeps the old name) or the
/// new (a note's renamed header).
fn since_begun(begun: &[String], now: &[String], from: &str, to: &str) -> Vec<String> {
    let (removed, stayed): (Vec<String>, Vec<String>) =
        begun.iter().cloned().partition(|tag| !holds(now, tag));
    // A name a tag still held renames to stays, though a removed one renames to it too (a
    // merge into a name in use: `a` to `b` of `[a, b]`, `a` removed since).
    let still = tags::renamed_list(&stayed, from, to);
    let gone: Vec<String> = tags::renamed_list(&removed, from, to)
        .into_iter()
        .filter(|tag| !holds(&still, tag))
        .collect();
    let kept = tags::renamed_list(begun, from, to)
        .into_iter()
        .filter(|tag| !holds(&gone, tag));
    let added = now.iter().filter(|tag| !holds(begun, tag)).cloned();
    let next = tags::dedupe(kept.chain(added));
    // In the record's order, a tag it holds under the old name where the renamed one stands.
    let mut ordered: Vec<String> = Vec::with_capacity(next.len());
    for tag in now {
        let renamed = renamed_tag(tag, from, to);
        for name in std::iter::once(tag).chain(renamed.as_ref()) {
            if let Some(held) = next.iter().find(|held| tags::same_tag(held, name))
                && !holds(&ordered, held)
            {
                ordered.push(held.clone());
            }
        }
    }
    let rest: Vec<String> = next
        .into_iter()
        .filter(|tag| !holds(&ordered, tag))
        .collect();
    ordered.extend(rest);
    ordered
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
    match stored(&tx)? {
        Some(other) if other.from != job.from || other.to != job.to => {
            return Ok(Some(RenameJob {
                from: other.from,
                to: other.to,
                run_id: other.run_id,
            }));
        }
        Some(same) => save(
            &tx,
            &Job {
                run_id: job.run_id.clone(),
                ..same
            },
        )?,
        None => {
            let pairs = pairs(&tx, &job.from, job.to.trim())?;
            save(
                &tx,
                &Job {
                    from: job.from.clone(),
                    to: job.to.clone(),
                    run_id: job.run_id.clone(),
                    pairs,
                },
            )?;
            for holder in holders {
                let kind = if holder.day { "journal" } else { "note" };
                put(&tx, &format!("{HOLDER}{}", holder.id), kind)?;
            }
        }
    }
    tx.commit().map_err(failed)?;
    Ok(None)
}

fn put(conn: &Connection, key: &str, value: &str) -> Result<(), StorageError> {
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(failed)?;
    Ok(())
}

fn get(conn: &Connection, key: &str) -> Result<Option<String>, StorageError> {
    conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |row| {
        row.get(0)
    })
    .optional()
    .map_err(failed)
}

fn save(conn: &Connection, job: &Job) -> Result<(), StorageError> {
    let value = serde_json::to_string(job).map_err(|error| StorageError::Failed {
        what: format!("a tag rename will not serialise: {error}"),
    })?;
    put(conn, JOB, &value)
}

/// The job row; one that does not read is an error.
fn stored(conn: &Connection) -> Result<Option<Job>, StorageError> {
    match read_job(conn)? {
        None => Ok(None),
        Some(Ok(job)) => Ok(Some(job)),
        Some(Err(what)) => Err(StorageError::Failed { what }),
    }
}

fn read_job(conn: &Connection) -> Result<Option<Result<Job, String>>, StorageError> {
    Ok(get(conn, JOB)?.map(|raw| {
        serde_json::from_str(&raw)
            .map_err(|error| format!("the recorded tag rename does not read: {error}"))
    }))
}

/// The rename in progress, or why its row does not read. A database that fails to answer is
/// an error, never [`Recorded::Unreadable`].
pub fn read(conn: &Connection) -> Result<Option<Recorded>, StorageError> {
    let job = match read_job(conn)? {
        None => return Ok(None),
        Some(Err(what)) => return Ok(Some(Recorded::Unreadable(what))),
        Some(Ok(job)) => job,
    };
    let mut statement = conn
        .prepare(
            "SELECT substr(key, ?3), value FROM meta WHERE key >= ?1 AND key < ?2 ORDER BY key",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map(
            params![HOLDER, after_prefix(HOLDER), HOLDER.len() as i64 + 1],
            |row| {
                Ok(Holder {
                    id: row.get(0)?,
                    day: row.get::<_, String>(1)? == "journal",
                })
            },
        )
        .map_err(failed)?;
    let holders = rows.collect::<Result<_, _>>().map_err(failed)?;
    Ok(Some(Recorded::Plan(RenamePlan {
        job: RenameJob {
            from: job.from,
            to: job.to,
            run_id: job.run_id,
        },
        pairs: job.pairs,
        holders,
    })))
}

/// The first key after every key under `prefix`, which ends in `:`.
fn after_prefix(prefix: &str) -> String {
    format!("{};", &prefix[..prefix.len() - 1])
}

/// The rename in progress. A row that does not read is an error, which [`finish`] clears.
pub fn recorded(conn: &Connection) -> Result<Option<RenamePlan>, StorageError> {
    match read(conn)? {
        None => Ok(None),
        Some(Recorded::Plan(plan)) => Ok(Some(plan)),
        Some(Recorded::Unreadable(what)) => Err(StorageError::Failed { what }),
    }
}

/// No rename is in progress: its job, holders and begun edits are cleared.
pub fn finish(conn: &Connection) -> Result<(), StorageError> {
    let tx = conn.unchecked_transaction().map_err(failed)?;
    tx.execute("DELETE FROM meta WHERE key = ?1", [JOB])
        .map_err(failed)?;
    for prefix in [HOLDER, STARTED] {
        tx.execute(
            "DELETE FROM meta WHERE key >= ?1 AND key < ?2",
            params![prefix, after_prefix(prefix)],
        )
        .map_err(failed)?;
    }
    tx.commit().map_err(failed)
}

/// The part of the recorded rename that no file holds, for desktop: the tasks' tags, the
/// definitions and the schema references, pair by pair, each struck off once done. A pair run
/// twice (stopped before it was struck off) finds nothing the second time: its old name is
/// matched whole, and the pairs under it ran before it.
pub fn rename_shared(conn: &Connection, device_id: &str, now_ms: i64) -> Result<(), StorageError> {
    while let Some(mut job) = stored(conn)?
        && let Some((from, to)) = job.pairs.first().cloned()
    {
        rewrite_of(conn, &["task"], &from, Some(&to), device_id, now_ms)?;
        move_definition(conn, &from, &to, device_id, now_ms)?;
        tag_schema_refs::rewrite_definitions(conn, &from, Some(&to), device_id, now_ms)?;
        job.pairs.remove(0);
        save(conn, &job)?;
    }
    Ok(())
}

/// Whether the recorded rename still lists the holder `id`.
pub fn listed(conn: &Connection, id: &str) -> Result<bool, StorageError> {
    Ok(get(conn, &format!("{HOLDER}{id}"))?.is_some())
}

/// The file edit begun on the holder `id` ([`start_holder`]), if any.
pub fn started(conn: &Connection, id: &str) -> Result<Option<Started>, StorageError> {
    get(conn, &format!("{STARTED}{id}"))?
        .map(|raw| {
            serde_json::from_str(&raw).map_err(|error| StorageError::Failed {
                what: format!("a begun tag rename edit does not read: {error}"),
            })
        })
        .transpose()
}

/// The recorded rename in the record of the holder `id` ([`tags::rename`]), and the holder
/// struck off, in one transaction. A holder the plan no longer lists is left alone: its record
/// took the new name already. With its file edit begun ([`start_holder`]), the record takes
/// what the rename made of its lists then, with what an edit changed since ([`since_begun`]).
/// A locked holder with no file edit begun is struck off with its record unchanged.
pub fn rename_holder(
    conn: &Connection,
    id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<bool, StorageError> {
    let tx = conn.unchecked_transaction().map_err(failed)?;
    let Some(job) = stored(&tx)? else {
        return Ok(false);
    };
    if !listed(&tx, id)? {
        return Ok(false);
    }
    let (from, to) = (job.from.as_str(), job.to.trim());
    let wrote = match started(&tx, id)? {
        // A locked holder keeps its tags (Electron `keepLockedNoteTags`): struck off, unwritten.
        // One whose file edit began (and landed, as the caller checks) takes the file's name.
        None if body_write::is_locked(&tx, id)? => false,
        None => tags::rename(&tx, id, from, to, device_id, now_ms)?,
        Some(begun) => tags::rename_with(
            &tx,
            id,
            |now_tags, now_pins| {
                let next = since_begun(&begun.tags, now_tags, from, to);
                let pins = match (begun.pinned.as_deref(), now_pins) {
                    (Some(was), Some(now)) => {
                        Some(tags::spelled_in(since_begun(was, now, from, to), &next))
                    }
                    // Pinned since the edit began: a pin follows its tag to the new name.
                    (None, Some(now)) => Some(tags::spelled_in(
                        now.iter()
                            .map(|pin| match renamed_tag(pin, from, to) {
                                Some(renamed) if !holds(&next, pin) => renamed,
                                _ => pin.clone(),
                            })
                            .collect(),
                        &next,
                    )),
                    (_, None) => None,
                };
                (next, pins)
            },
            device_id,
            now_ms,
        )?,
    };
    for prefix in [HOLDER, STARTED] {
        tx.execute("DELETE FROM meta WHERE key = ?1", [format!("{prefix}{id}")])
            .map_err(failed)?;
    }
    tx.commit().map_err(failed)?;
    Ok(wrote)
}

/// Forgets the file edit begun on the holder `id`, which did not write its file: the holder stays
/// listed, to be tried again.
pub fn unstart_holder(conn: &Connection, id: &str) -> Result<(), StorageError> {
    conn.execute(
        "DELETE FROM meta WHERE key = ?1",
        [format!("{STARTED}{id}")],
    )
    .map_err(failed)?;
    Ok(())
}

/// Records that the holder `id`'s file is about to go from the text hashed `before` to the one
/// hashed `after`, with its record's lists now, until [`rename_holder`] strikes it off or
/// [`unstart_holder`] forgets it. A holder the plan no longer lists records nothing.
pub fn start_holder(
    conn: &Connection,
    id: &str,
    before: &str,
    after: &str,
) -> Result<(), StorageError> {
    let tx = conn.unchecked_transaction().map_err(failed)?;
    if listed(&tx, id)? {
        let (tags, pinned) = tags::lists(&tx, id)?.unwrap_or_default();
        let begun = Started {
            before: before.to_owned(),
            after: after.to_owned(),
            tags,
            pinned,
        };
        let value = serde_json::to_string(&begun).map_err(|error| StorageError::Failed {
            what: format!("a begun tag rename edit will not serialise: {error}"),
        })?;
        put(&tx, &format!("{STARTED}{id}"), &value)?;
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
    let bodies = body_tags::carriers(conn)?;
    holders_where(conn, headers, bodies, |tag| {
        renamed_tag(tag, old, old).is_some()
    })
}

/// The live notes and journal days whose record's tags, `bodies`' `#tags` or a note's header
/// (`headers`) carry a tag `wanted` takes, by id; a day's header never counts (#3931).
pub(crate) fn holders_where(
    conn: &Connection,
    headers: impl IntoIterator<Item = (String, Vec<String>)>,
    bodies: Vec<(String, String, String)>,
    wanted: impl Fn(&str) -> bool,
) -> Result<Vec<Holder>, StorageError> {
    let carried: BTreeSet<String> = carriers(conn, None)?
        .into_iter()
        .chain(bodies)
        .filter(|(item_type, _, tag)| item_type != "task" && wanted(tag))
        .map(|(_, id, _)| id)
        .collect();
    let headed: BTreeSet<String> = headers
        .into_iter()
        .filter(|(_, tags)| tags.iter().any(|tag| wanted(tag)))
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
