//! Keeping `index.db` in step with `data.db` (T131, FR-053, data-model §A.5).
//!
//! The query half is [`super`]; this half is everything that writes a row of
//! `fts_notes` or `fts_tasks`, and the watermarks in `index_meta` that let it
//! do so without re-reading the whole vault.
//!
//! ## Incremental maintenance
//!
//! §A.5 gives `index_meta` a per-table watermark "so an incremental reindex is
//! possible and a full rebuild is only needed when the watermark is missing".
//! The watermark is an epoch-millisecond stamp and the columns compared against
//! it are all written by **this device's** clock at apply time — the projection
//! rows' `synced_at`, the update log's `created_at` and `compacted_at`.
//! `sync_items.updated_at` is *not* used: it carries the server's instant for a
//! pulled record, so it is not monotone in local time and a pull of an older
//! record would land below the watermark and never be indexed.
//!
//! The comparison is `>=`, not `>`, and the stored watermark is the largest
//! stamp the pass saw. A row written in the same millisecond the pass read is
//! therefore re-indexed next time rather than missed; re-indexing is a delete
//! and an insert of the same bytes, so the safe direction costs nothing.
//!
//! A missing watermark, or an `index_meta` `data.user_version` that does not
//! match `data.db`, forces a full rebuild: every FTS table is emptied and
//! every live row is re-indexed. `fts_inbox` is [`super::inbox`]'s, called
//! from here with its own watermark.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use rusqlite::{Connection, OptionalExtension as _, params};

use crate::api::errors::StorageError;
use crate::crdt::blocks::extract_blocks;
use crate::crdt::update_log::LOCAL_NAMESPACE_PREFIX;
use crate::domain::body_tags;
use crate::domain::wiki_target::WikiNames;
use crate::storage::nested_tx;
use crate::storage::repositories::projectors::{strings, text};

use super::body_cache::{body_document, body_text, crdt_failed};
use super::failed;
use super::source::{NoteRow, note_row, read_payload};

/// `index_meta` key: the `data.db` `user_version` the index was built against.
pub const DATA_VERSION_KEY: &str = "data.user_version";
/// `index_meta` key: the `fts_notes` watermark.
pub const NOTES_WATERMARK_KEY: &str = "watermark.fts_notes";
/// `index_meta` key: the `fts_tasks` watermark.
pub const TASKS_WATERMARK_KEY: &str = "watermark.fts_tasks";
/// `index_meta` key: the stamp rules the index was built under. Pulled body
/// updates used to be stamped with the server's `createdAt`, which sat below
/// the epoch-ms watermark, so an install that pulled bodies before the fix
/// holds rows no incremental pass will ever see. A missing or older value
/// forces one full rebuild.
pub const STAMPS_KEY: &str = "stamps.version";
/// The current [`STAMPS_KEY`]. `1`: body updates stamped at apply time. `2`
/// (#4315): the body cache keyed by a version a snapshot moves, so the bodies
/// cached empty under `1` are read again. `3` (#5716): body `#tags` read in
/// every script, so `note_body_tags` gains the ones `2` read as prose.
const STAMPS_VERSION: i64 = 3;

/// What one [`reindex`] pass did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Reindexed {
    /// Both tables were emptied first: the watermark was missing or `data.db`
    /// moved to a schema version this index was not built against.
    pub full: bool,
    pub notes_indexed: usize,
    pub notes_removed: usize,
    pub tasks_indexed: usize,
    pub tasks_removed: usize,
    pub inbox_indexed: usize,
    pub inbox_removed: usize,
    /// Rows the apply path had already flagged corrupt. Not an error here.
    pub corrupt_skipped: usize,
}

/// Brings `index.db` up to date with `data.db`, incrementally where it can.
///
/// Safe to call at any time and on any schedule: it is idempotent, and calling
/// it against an empty `index.db` is the supported full rebuild. Runs the whole
/// pass in one transaction; [`ReindexPass`] runs it in batches.
pub fn reindex(
    data: &Connection,
    index: &Connection,
    now_ms: i64,
) -> Result<Reindexed, StorageError> {
    let mut pass = ReindexPass::default();
    loop {
        if let ReindexStep::Done(done) = pass.step(data, index, now_ms, usize::MAX)? {
            return Ok(done);
        }
    }
}

/// What one [`ReindexPass::step`] did.
#[derive(Debug)]
pub enum ReindexStep {
    /// The batch committed and the pass goes on.
    More,
    /// The last batch committed the watermarks.
    Done(Reindexed),
}

/// [`reindex`] in batches, each its own `index.db` transaction, so the caller
/// can let go of `data.db` between them (#5842).
///
/// The first step plans the pass: it reads the watermarks, empties the tables
/// for a full rebuild, and lists every note and task that moved. Each step
/// indexes at most `batch` of them from `data.db` as it is then. A note written
/// after the plan has a stamp at or above the plan's largest, so once the list
/// is drained a step lists again from there: what moved during the pass and
/// was not indexed at its new stamp is indexed again. The step that lists
/// nothing left to do, or few enough to do in that step, writes the watermarks.
///
/// The watermarks move only in that last step, in the same transaction as the
/// listing that chose them, so a pass that fails or is dropped part way leaves
/// every row it had not finished still owed to the next pass. A full rebuild
/// that stops part way leaves the version stamps unwritten, and the next pass
/// is full again.
///
/// Two passes over one `index.db` must not interleave: a full pass's plan
/// would empty what the other had indexed. The caller runs one at a time.
#[derive(Default)]
pub struct ReindexPass {
    plan: Option<Plan>,
    done: Reindexed,
}

/// The most notes and tasks one [`ReindexPass::step`] of `Search::reindex`
/// indexes. About half a second of `data.db` lock on a large vault (#5842).
pub const REINDEX_BATCH: usize = 64;

/// Catch-up listings a pass runs in batches. The one after them runs in a
/// single step whatever its size, so a vault that never stops changing still
/// ends the pass.
const CATCH_UP_ROUNDS: usize = 4;

struct Plan {
    version: i64,
    full: bool,
    /// The watermarks the last step writes: the largest stamp listed yet.
    notes_high: i64,
    tasks_high: i64,
    /// Listed and not indexed yet, ascending.
    notes: Vec<String>,
    tasks: Vec<String>,
    /// The stamp each id was listed at. A catch-up listing skips an id at the
    /// stamp it was listed at, since the step that indexed it read it later.
    notes_listed: HashMap<String, Option<i64>>,
    tasks_listed: HashMap<String, Option<i64>>,
    rounds: usize,
}

impl ReindexPass {
    /// Runs the next batch of at most `batch` notes and tasks in one
    /// transaction of `index`, and commits it.
    pub fn step(
        &mut self,
        data: &Connection,
        index: &Connection,
        now_ms: i64,
        batch: usize,
    ) -> Result<ReindexStep, StorageError> {
        let transaction = nested_tx::begin(index).map_err(failed)?;
        // `listed`: the stamps this step will write were read in this step.
        let listed = match &mut self.plan {
            None => {
                let plan = Plan::new(data, &transaction)?;
                self.done.full = plan.full;
                self.plan = Some(plan);
                true
            }
            Some(plan) if plan.notes.is_empty() && plan.tasks.is_empty() => {
                plan.catch_up(data)?;
                true
            }
            Some(_) => false,
        };
        let plan = self.plan.as_mut().expect("planned above");
        let batch = if plan.rounds > CATCH_UP_ROUNDS {
            usize::MAX
        } else {
            batch
        };

        let notes = take(&mut plan.notes, batch);
        let tasks = take(&mut plan.tasks, batch - notes.len());
        if !notes.is_empty() {
            let names = WikiNames::load(data)?;
            for id in &notes {
                index_note(data, &names, &transaction, id, now_ms, &mut self.done)?;
            }
            // A full pass indexes every note against the same names; one
            // listed by a catch-up may be a name the others link to.
            if !plan.full || plan.rounds > 0 {
                let changed: BTreeSet<String> = notes.into_iter().collect();
                super::links::reresolve(&names, &transaction, &changed)?;
            }
        }
        for id in &tasks {
            index_task(data, &transaction, id, &mut self.done)?;
        }

        let last = listed && plan.notes.is_empty() && plan.tasks.is_empty();
        if last {
            super::inbox::reindex(data, &transaction, plan.full, &mut self.done)?;
            meta_set(&transaction, DATA_VERSION_KEY, &plan.version.to_string())?;
            meta_set(&transaction, STAMPS_KEY, &STAMPS_VERSION.to_string())?;
            meta_set(
                &transaction,
                NOTES_WATERMARK_KEY,
                &plan.notes_high.to_string(),
            )?;
            meta_set(
                &transaction,
                TASKS_WATERMARK_KEY,
                &plan.tasks_high.to_string(),
            )?;
        }
        transaction.commit().map_err(failed)?;
        Ok(if last {
            ReindexStep::Done(std::mem::take(&mut self.done))
        } else {
            ReindexStep::More
        })
    }
}

impl Plan {
    fn new(data: &Connection, index: &Connection) -> Result<Self, StorageError> {
        let version: i64 = data
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(failed)?;
        let indexed = meta_number(index, DATA_VERSION_KEY)?;
        let notes_from = meta_number(index, NOTES_WATERMARK_KEY)?;
        let tasks_from = meta_number(index, TASKS_WATERMARK_KEY)?;
        let stamps = meta_number(index, STAMPS_KEY)?;

        let full = indexed != Some(version)
            || stamps != Some(STAMPS_VERSION)
            || notes_from.is_none()
            || tasks_from.is_none();
        if full {
            index
                .execute_batch("DELETE FROM fts_notes; DELETE FROM fts_tasks;")
                .map_err(failed)?;
        }
        let notes_from = if full { 0 } else { notes_from.unwrap_or(0) };
        let tasks_from = if full { 0 } else { tasks_from.unwrap_or(0) };
        let notes_listed = note_candidates(data, notes_from)?;
        let tasks_listed = task_candidates(data, tasks_from)?;
        Ok(Self {
            version,
            full,
            notes_high: high(&notes_listed, notes_from),
            tasks_high: high(&tasks_listed, tasks_from),
            notes: notes_listed.keys().cloned().collect(),
            tasks: tasks_listed.keys().cloned().collect(),
            notes_listed: notes_listed.into_iter().collect(),
            tasks_listed: tasks_listed.into_iter().collect(),
            rounds: 0,
        })
    }

    /// Lists what moved since the plan and was not indexed at its new stamp.
    fn catch_up(&mut self, data: &Connection) -> Result<(), StorageError> {
        let notes = note_candidates(data, self.notes_high)?;
        let tasks = task_candidates(data, self.tasks_high)?;
        self.notes_high = high(&notes, self.notes_high);
        self.tasks_high = high(&tasks, self.tasks_high);
        self.notes = relisted(notes, &mut self.notes_listed);
        self.tasks = relisted(tasks, &mut self.tasks_listed);
        self.rounds += 1;
        Ok(())
    }
}

/// The largest stamp listed, never below `from`.
fn high(listed: &BTreeMap<String, Option<i64>>, from: i64) -> i64 {
    listed
        .values()
        .flatten()
        .copied()
        .max()
        .unwrap_or(from)
        .max(from)
}

fn relisted(
    listed: BTreeMap<String, Option<i64>>,
    seen: &mut HashMap<String, Option<i64>>,
) -> Vec<String> {
    listed
        .into_iter()
        .filter_map(|(id, stamp)| match seen.insert(id.clone(), stamp) {
            Some(before) if before == stamp => None,
            _ => Some(id),
        })
        .collect()
}

fn take(ids: &mut Vec<String>, count: usize) -> Vec<String> {
    let rest = ids.split_off(count.min(ids.len()));
    std::mem::replace(ids, rest)
}

/// Every note or journal whose record, body log or body snapshot moved at or
/// after `from`, with the largest stamp seen for it.
fn note_candidates(
    data: &Connection,
    from: i64,
) -> Result<BTreeMap<String, Option<i64>>, StorageError> {
    // A `synced_at` this device never wrote is read as "changed" rather than
    // as "older than the watermark": a NULL compares false against every
    // bound, so the null-tolerant reading is the only one that cannot lose a
    // row. It costs a re-index per pass and never a missing note.
    let sql = "
        SELECT id AS doc_id, synced_at AS stamp FROM notes
          WHERE synced_at IS NULL OR synced_at >= ?1
        UNION ALL
        SELECT id, synced_at FROM journal_entries
          WHERE synced_at IS NULL OR synced_at >= ?1
        UNION ALL
        SELECT CASE WHEN doc_id LIKE ?2 THEN substr(doc_id, ?3) ELSE doc_id END, created_at
          FROM yjs_updates WHERE created_at >= ?1
        UNION ALL
        SELECT CASE WHEN doc_id LIKE ?2 THEN substr(doc_id, ?3) ELSE doc_id END, compacted_at
          FROM yjs_snapshots WHERE compacted_at >= ?1";
    let local = format!("{LOCAL_NAMESPACE_PREFIX}%");
    let skip = LOCAL_NAMESPACE_PREFIX.len() as i64 + 1;
    stamped(data, sql, params![from, local, skip])
}

/// Every task whose projection row moved at or after `from`.
fn task_candidates(
    data: &Connection,
    from: i64,
) -> Result<BTreeMap<String, Option<i64>>, StorageError> {
    stamped(
        data,
        "SELECT id AS doc_id, synced_at AS stamp FROM tasks
           WHERE synced_at IS NULL OR synced_at >= ?1",
        params![from],
    )
}

pub(super) fn candidates(
    data: &Connection,
    sql: &str,
    bound: &[&dyn rusqlite::ToSql],
) -> Result<(BTreeSet<String>, Option<i64>), StorageError> {
    let listed = stamped(data, sql, bound)?;
    let high = listed.values().flatten().copied().max();
    Ok((listed.into_keys().collect(), high))
}

/// Every id `sql` answers, with the largest stamp it answered for it.
fn stamped(
    data: &Connection,
    sql: &str,
    bound: &[&dyn rusqlite::ToSql],
) -> Result<BTreeMap<String, Option<i64>>, StorageError> {
    let mut statement = data.prepare(sql).map_err(failed)?;
    let rows = statement
        .query_map(bound, |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<i64>>(1)?))
        })
        .map_err(failed)?;
    let mut listed: BTreeMap<String, Option<i64>> = BTreeMap::new();
    for row in rows {
        let (id, stamp) = row.map_err(failed)?;
        let entry = listed.entry(id).or_default();
        *entry = (*entry).max(stamp);
    }
    Ok(listed)
}

/// Re-indexes one note or journal: delete first, then insert if it still earns
/// a row.
fn index_note(
    data: &Connection,
    names: &WikiNames,
    index: &Connection,
    id: &str,
    now_ms: i64,
    done: &mut Reindexed,
) -> Result<(), StorageError> {
    index
        .execute("DELETE FROM fts_notes WHERE id = ?1", params![id])
        .map_err(failed)?;
    // The note's outgoing links go with it. Deleting first means a note that
    // stopped linking somewhere really stops: an insert-only pass would leave
    // a backlink the source no longer makes.
    index
        .execute("DELETE FROM note_links WHERE source_id = ?1", params![id])
        .map_err(failed)?;
    body_tags::clear(data, id)?;

    let (title, tags) = match note_row(data, id)? {
        NoteRow::Absent => {
            done.notes_removed += 1;
            return Ok(());
        }
        NoteRow::Corrupt => {
            done.corrupt_skipped += 1;
            return Ok(());
        }
        // The fill bumps `synced_at`, so it comes back as a candidate.
        NoteRow::NotPulled => return Ok(()),
        NoteRow::Live { title, tags } => (title, tags),
    };
    index
        .execute(
            "INSERT INTO fts_notes (id, title, content, tags) VALUES (?1, ?2, ?3, ?4)",
            params![id, title, body_text(data, id, now_ms)?, tags.join(" ")],
        )
        .map_err(failed)?;
    index_links(data, names, index, id)?;
    done.notes_indexed += 1;
    Ok(())
}

/// Projects one note's outgoing wiki links into `note_links` (N800).
///
/// **The table existed and nothing wrote a row into it**, which is why
/// backlinks could not be answered: a query over it would have returned
/// nothing, forever, and looked like a note with no backlinks.
///
/// Journal sources are projected the same way: their body is a document keyed
/// by the record id, and [`index_note`] reaches this for both types.
///
/// The rows themselves are [`super::links::write`]'s.
fn index_links(
    data: &Connection,
    names: &WikiNames,
    index: &Connection,
    id: &str,
) -> Result<(), StorageError> {
    let document = body_document(data, id)?;
    let Some(document) = document else {
        return Ok(());
    };
    let blocks = extract_blocks(&document).map_err(|error| crdt_failed(id, error))?;
    body_tags::write(data, id, &body_tags::extract(&blocks))?;

    super::links::write(names, index, id, &blocks)
}

/// Re-indexes one task. A task has no body document, so `description` is the
/// whole of its second column.
fn index_task(
    data: &Connection,
    index: &Connection,
    id: &str,
    done: &mut Reindexed,
) -> Result<(), StorageError> {
    index
        .execute("DELETE FROM fts_tasks WHERE id = ?1", params![id])
        .map_err(failed)?;

    let row = data
        .query_row(
            "SELECT payload, deleted_at, corrupt_reason FROM sync_items
             WHERE item_type = 'task' AND item_id = ?1",
            params![id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()
        .map_err(failed)?;

    let Some((payload, deleted_at, corrupt)) = row else {
        done.tasks_removed += 1;
        return Ok(());
    };
    if deleted_at.is_some() {
        done.tasks_removed += 1;
        return Ok(());
    }
    if corrupt.is_some() {
        done.corrupt_skipped += 1;
        return Ok(());
    }
    let Some(payload) = payload else {
        return Ok(());
    };

    let view = read_payload("task", id, &payload)?;
    index
        .execute(
            "INSERT INTO fts_tasks (id, title, description, tags) VALUES (?1, ?2, ?3, ?4)",
            params![
                id,
                text(&view, "title").unwrap_or_default(),
                text(&view, "description").unwrap_or_default(),
                strings(&view, "tags").join(" "),
            ],
        )
        .map_err(failed)?;
    done.tasks_indexed += 1;
    Ok(())
}

pub(super) fn meta_number(index: &Connection, key: &str) -> Result<Option<i64>, StorageError> {
    let raw: Option<Option<String>> = index
        .query_row(
            "SELECT value FROM index_meta WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .optional()
        .map_err(failed)?;
    match raw.flatten() {
        None => Ok(None),
        // A watermark that will not parse is not read as "start from zero"
        // silently; it is read as missing, which forces the full rebuild that
        // is the documented recovery for a watermark that cannot be trusted.
        Some(value) => Ok(value.parse::<i64>().ok()),
    }
}

pub(super) fn meta_set(index: &Connection, key: &str, value: &str) -> Result<(), StorageError> {
    index
        .execute(
            "INSERT INTO index_meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )
        .map_err(failed)?;
    Ok(())
}
