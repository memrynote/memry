//! A search reindex in short transactions (#5417).
//!
//! A full rebuild of a 17k-note vault takes about a minute. Run as one transaction, it held
//! the `data.db` writer the whole time, so an editor save, a sync pass and the vault write-back
//! waited behind it. A pass is now planned once, on readers, and worked in batches of at most
//! [`BATCH_NOTES`] notes and tasks or [`BATCH_TIME`]: each batch takes the writers, commits
//! both databases once, and lets go.
//!
//! **A batch commits a resume point.** `index_meta` [`RESUME_KEY`] records the pass (the
//! versions it was planned against, full or not, the watermarks it started from and will set)
//! and the last note and task committed. A pass stopped by a vault close, or a crash, loses
//! only its open batch; the next pass goes on after them. A resume point that names another
//! `data.db` or `index.db` version or stamps rule, or does not parse, is ignored. The
//! watermarks move only when the last batch commits, so until then every row the pass has not
//! reached is still owed.
//!
//! **The previous index stays visible until replaced.** Nothing is emptied up front: each
//! note's (or task's) rows are replaced in the batch that indexes it, and a full pass drops
//! the rows of notes and tasks it did not plan once it has indexed the rest. A note that fails
//! to index keeps its old row; the pass finishes the others and then answers the first error,
//! with no watermark moved, so the next pass tries again. Every row is indexed once per pass
//! (the plan is sorted and the cursor committed with the rows), so none is doubled.
//!
//! **Rows are found by rowid.** `id` is UNINDEXED, so a delete by it scans every row of the
//! FTS table; one per note made a pass over a large vault quadratic. A pass reads each table's
//! `id -> rowid` once, from the FTS5 content table, and deletes by rowid.
//!
//! **Two passes never interleave their batches.** Each batch checks, in its transaction, that
//! the resume point, the notes watermark and [`SEQ_KEY`] are what its pass last committed or
//! planned from. Every batch commit counts [`SEQ_KEY`] up, so a pass that committed in between
//! is seen even when it left the other two as they were: the rowids this pass planned are gone.
//! A pass that finds them moved answers [`Step::Stale`] and is planned again.

use std::collections::{BTreeSet, HashMap};
use std::time::{Duration, Instant};

use rusqlite::{Connection, OptionalExtension as _, params};
use serde::{Deserialize, Serialize};

use crate::api::errors::StorageError;
use crate::domain::wiki_target::{WikiNames, settle_name_keys};
use crate::storage::nested_tx;

use super::failed;
use super::links::LinkChanges;
use super::maintenance::{
    DATA_VERSION_KEY, NOTES_WATERMARK_KEY, Reindexed, STAMPS_KEY, STAMPS_VERSION,
    TASKS_WATERMARK_KEY, index_note, index_task, meta_number, meta_set, note_candidates,
    task_candidates,
};

/// `index_meta` key: the resume point of a pass that has committed a batch and not its last.
pub const RESUME_KEY: &str = "reindex.resume";
/// `index_meta` key: counts every batch commit, the last one of a pass included.
const SEQ_KEY: &str = "reindex.seq";
/// The most notes and tasks one batch indexes.
pub const BATCH_NOTES: usize = 200;
/// A batch that has run this long commits after the row it is on.
pub const BATCH_TIME: Duration = Duration::from_millis(50);

/// What [`RESUME_KEY`] holds. Every version field is required: a key an older build wrote
/// does not parse, and is ignored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Resume {
    /// The `data.db` `user_version` the pass was planned against.
    version: i64,
    /// The `index.db` `user_version`: an index migration may drop the rows a cursor counts.
    index_version: i64,
    /// The [`STAMPS_VERSION`] the pass was planned under.
    stamps: i64,
    full: bool,
    notes_from: i64,
    /// The notes watermark the last batch sets.
    notes_to: i64,
    tasks_from: i64,
    tasks_to: i64,
    /// The last note committed.
    notes_after: Option<String>,
    notes_done: bool,
    /// The last task committed.
    tasks_after: Option<String>,
    /// A row failed to index in a committed batch: the watermarks stay where they are.
    failed: bool,
}

/// What one [`ReindexPass::batch`] did.
#[derive(Debug)]
pub enum Step {
    /// The batch committed and rows remain.
    More,
    /// The last batch committed the watermarks.
    Done(Reindexed),
    /// `stop` answered true: the open batch rolled back, the committed ones stand.
    Stopped,
    /// Another pass committed since this one planned: plan again.
    Stale,
}

/// The notes or the tasks of a pass: what remains, and the rows the index held at the plan.
struct Planned {
    /// Ascending; `ids[next..]` remain.
    ids: Vec<String>,
    next: usize,
    /// A full pass: every id it planned, done or not. The rows of any other id are dropped.
    all: Option<BTreeSet<String>>,
    /// The rowids that held each id when the pass was planned; an id loses its entry when
    /// the pass replaces its rows.
    rows: HashMap<String, Vec<i64>>,
    /// The rows of unplanned ids were dropped (a full pass), or there are none to drop.
    dropped: bool,
}

impl Planned {
    fn new(
        candidates: BTreeSet<String>,
        after: Option<&str>,
        full: bool,
        rows: HashMap<String, Vec<i64>>,
    ) -> Self {
        let ids = candidates
            .iter()
            .filter(|id| after.is_none_or(|after| id.as_str() > after))
            .cloned()
            .collect();
        Self {
            ids,
            next: 0,
            all: full.then_some(candidates),
            rows,
            dropped: !full,
        }
    }

    fn remaining(&self) -> bool {
        self.next < self.ids.len()
    }

    /// Deletes the rows of the ids the pass did not plan, once it planned the rest.
    fn drop_unplanned(&mut self, index: &Connection, table: &str) -> Result<(), StorageError> {
        if self.dropped || self.remaining() {
            return Ok(());
        }
        let all = self.all.as_ref().expect("a full pass plans every id");
        let mut statement = index
            .prepare_cached(&format!("DELETE FROM {table} WHERE rowid = ?1"))
            .map_err(failed)?;
        for (id, rowids) in &self.rows {
            if !all.contains(id) {
                for rowid in rowids {
                    statement.execute(params![rowid]).map_err(failed)?;
                }
            }
        }
        self.dropped = true;
        Ok(())
    }
}

/// One reindex pass, planned and then worked in batches.
pub struct ReindexPass {
    /// The pass and its committed cursors, as the next batch writes them.
    resume: Resume,
    notes: Planned,
    tasks: Planned,
    /// The `(resume point, notes watermark, batch commit count)` this pass expects to find, raw.
    expect: (Option<String>, Option<String>, Option<String>),
    /// Loaded before the first batch and again after names were settled: reading every name
    /// per batch would cost a 17k-note vault seconds over a pass.
    names: Option<WikiNames>,
    /// The first row that failed to index in this run of the pass.
    failure: Option<StorageError>,
    done: Reindexed,
}

impl ReindexPass {
    /// Plans a pass, or the rest of a stopped one: reads only, so `data` and `index` may be
    /// readers and no writer waits on the walk of the vault's changes.
    pub fn plan(data: &Connection, index: &Connection) -> Result<Self, StorageError> {
        let version = user_version(data)?;
        let index_version = user_version(index)?;
        let expect = (
            meta_raw(index, RESUME_KEY)?,
            meta_raw(index, NOTES_WATERMARK_KEY)?,
            meta_raw(index, SEQ_KEY)?,
        );
        let notes_watermark = meta_number(index, NOTES_WATERMARK_KEY)?;
        let tasks_watermark = meta_number(index, TASKS_WATERMARK_KEY)?;
        let needs_full = meta_number(index, DATA_VERSION_KEY)? != Some(version)
            || meta_number(index, STAMPS_KEY)? != Some(STAMPS_VERSION)
            || notes_watermark.is_none()
            || tasks_watermark.is_none();
        let resume = expect
            .0
            .as_deref()
            .and_then(|raw| serde_json::from_str::<Resume>(raw).ok())
            .filter(|resume| {
                resume.version == version
                    && resume.index_version == index_version
                    && resume.stamps == STAMPS_VERSION
                    && resume.full == needs_full
                    && (resume.full
                        || (notes_watermark == Some(resume.notes_from)
                            && tasks_watermark == Some(resume.tasks_from)))
            });
        let (full, notes_from, tasks_from) = match &resume {
            Some(resume) => (resume.full, resume.notes_from, resume.tasks_from),
            None if needs_full => (true, 0, 0),
            None => (
                false,
                notes_watermark.unwrap_or(0),
                tasks_watermark.unwrap_or(0),
            ),
        };
        let (note_ids, notes_high) = note_candidates(data, notes_from)?;
        let (task_ids, tasks_high) = task_candidates(data, tasks_from)?;
        let resume = resume.unwrap_or_else(|| Resume {
            version,
            index_version,
            stamps: STAMPS_VERSION,
            full,
            notes_from,
            notes_to: notes_high.unwrap_or(notes_from).max(notes_from),
            tasks_from,
            tasks_to: tasks_high.unwrap_or(tasks_from).max(tasks_from),
            notes_after: None,
            notes_done: false,
            tasks_after: None,
            failed: false,
        });
        let notes = if resume.notes_done {
            Planned::new(BTreeSet::new(), None, false, HashMap::new())
        } else {
            Planned::new(
                note_ids,
                resume.notes_after.as_deref(),
                resume.full,
                fts_rows(index, "fts_notes_content")?,
            )
        };
        let tasks = Planned::new(
            task_ids,
            resume.tasks_after.as_deref(),
            resume.full,
            fts_rows(index, "fts_tasks_content")?,
        );
        Ok(Self {
            done: Reindexed {
                full: resume.full,
                ..Reindexed::default()
            },
            resume,
            notes,
            tasks,
            expect,
            names: None,
            failure: None,
        })
    }

    /// Gives the wiki names changed since the last batch their lookup keys back, so a link
    /// lookup reads only its matches again (`wiki_target`); the loaded names are then stale.
    /// Only the reindex settles them, so a batch that settled none keeps the names it has.
    /// [`Self::batch`] settles first too; a caller that holds the writer per batch settles
    /// in a take of its own and loads the names on a reader ([`Self::load_names`]), so
    /// reading every name of a large vault never holds the writer.
    pub fn settle_names(&mut self, data: &Connection) -> Result<(), StorageError> {
        if settle_name_keys(data)? > 0 {
            self.names = None;
        }
        Ok(())
    }

    /// Loads the wiki names the next batch resolves links with, when it has none and notes
    /// remain. `data` may be a reader: the names are read from committed rows.
    pub fn load_names(&mut self, data: &Connection) -> Result<(), StorageError> {
        if self.names.is_none() && self.notes.remaining() {
            self.names = Some(WikiNames::load(data)?);
        }
        Ok(())
    }

    /// The links the batches committed so far changed, for a caller that ends the pass early
    /// (stopped, stale, failed) and owes them to its next announcement.
    pub fn take_links(&mut self) -> LinkChanges {
        std::mem::take(&mut self.done.links)
    }

    /// Indexes the next batch and commits it, `data.db` first. `data` and `index` are the
    /// writers; the caller lets go of both before the next batch. `stop` can end the batch
    /// between two rows, which rolls back that batch only.
    pub fn batch(
        &mut self,
        data: &Connection,
        index: &Connection,
        now_ms: i64,
        stop: &dyn Fn() -> bool,
    ) -> Result<Step, StorageError> {
        let started = Instant::now();
        // One `data.db` commit per batch: the body tags of each note are a savepoint in it.
        let data_tx = nested_tx::begin(data).map_err(failed)?;
        let transaction = nested_tx::begin(index).map_err(failed)?;
        let found = (
            meta_raw(&transaction, RESUME_KEY)?,
            meta_raw(&transaction, NOTES_WATERMARK_KEY)?,
            meta_raw(&transaction, SEQ_KEY)?,
        );
        if found != self.expect {
            return Ok(Step::Stale);
        }
        self.settle_names(&data_tx)?;

        let mut count = 0;
        let room =
            |count: usize| count < BATCH_NOTES && (count == 0 || started.elapsed() < BATCH_TIME);
        if self.notes.remaining() {
            let names = match &mut self.names {
                Some(names) => &*names,
                None => &*self.names.insert(WikiNames::load(&data_tx)?),
            };
            let mut batch = BTreeSet::new();
            while self.notes.remaining() && room(count) {
                if stop() {
                    return Ok(Step::Stopped);
                }
                let id = self.notes.ids[self.notes.next].clone();
                let old = self.notes.rows.get(&id).cloned().unwrap_or_default();
                let indexed = replaced(&transaction, "fts_notes", &old, || {
                    index_note(&data_tx, names, &transaction, &id, now_ms, &mut self.done)
                });
                match indexed {
                    Ok(()) => {
                        self.notes.rows.remove(&id);
                        batch.insert(id.clone());
                    }
                    Err(error) => failed_row(&mut self.resume, &mut self.failure, error),
                }
                self.resume.notes_after = Some(id);
                self.notes.next += 1;
                count += 1;
            }
            if !self.resume.full {
                super::links::reresolve(names, &transaction, &batch, &mut self.done.links)?;
            }
        }
        self.notes.drop_unplanned(&transaction, "fts_notes")?;
        self.resume.notes_done = !self.notes.remaining();

        if self.resume.notes_done {
            while self.tasks.remaining() && room(count) {
                if stop() {
                    return Ok(Step::Stopped);
                }
                let id = self.tasks.ids[self.tasks.next].clone();
                let old = self.tasks.rows.get(&id).cloned().unwrap_or_default();
                match replaced(&transaction, "fts_tasks", &old, || {
                    index_task(&data_tx, &transaction, &id, &mut self.done)
                }) {
                    Ok(()) => {
                        self.tasks.rows.remove(&id);
                    }
                    Err(error) => failed_row(&mut self.resume, &mut self.failure, error),
                }
                self.resume.tasks_after = Some(id);
                self.tasks.next += 1;
                count += 1;
            }
            self.tasks.drop_unplanned(&transaction, "fts_tasks")?;
        }

        if !self.resume.notes_done || self.tasks.remaining() {
            let raw =
                serde_json::to_string(&self.resume).map_err(|error| StorageError::Failed {
                    what: format!("the reindex resume point will not serialise: {error}"),
                })?;
            meta_set(&transaction, RESUME_KEY, &raw)?;
            let watermark = meta_raw(&transaction, NOTES_WATERMARK_KEY)?;
            let seq = count_commit(&transaction)?;
            data_tx.commit().map_err(failed)?;
            transaction.commit().map_err(failed)?;
            self.expect = (Some(raw), watermark, Some(seq));
            return Ok(Step::More);
        }

        // The inbox keeps its own watermark and is small: it is refilled in this transaction,
        // so a query never sees it emptied.
        super::inbox::reindex(&data_tx, &transaction, self.resume.full, &mut self.done)?;
        if !self.resume.failed {
            meta_set(
                &transaction,
                DATA_VERSION_KEY,
                &self.resume.version.to_string(),
            )?;
            meta_set(&transaction, STAMPS_KEY, &STAMPS_VERSION.to_string())?;
            meta_set(
                &transaction,
                NOTES_WATERMARK_KEY,
                &self.resume.notes_to.to_string(),
            )?;
            meta_set(
                &transaction,
                TASKS_WATERMARK_KEY,
                &self.resume.tasks_to.to_string(),
            )?;
        }
        transaction
            .execute("DELETE FROM index_meta WHERE key = ?1", params![RESUME_KEY])
            .map_err(failed)?;
        count_commit(&transaction)?;
        data_tx.commit().map_err(failed)?;
        transaction.commit().map_err(failed)?;
        if self.resume.failed {
            return Err(self.failure.take().unwrap_or_else(|| StorageError::Failed {
                what: "a row of this reindex pass failed to index in an earlier run; the \
                       watermarks were not moved"
                    .to_owned(),
            }));
        }
        Ok(Step::Done(std::mem::take(&mut self.done)))
    }
}

/// Counts this batch's commit in [`SEQ_KEY`] and gives the new count, raw.
fn count_commit(index: &Connection) -> Result<String, StorageError> {
    let seq = meta_raw(index, SEQ_KEY)?
        .and_then(|raw| raw.parse::<u64>().ok())
        .unwrap_or(0)
        .wrapping_add(1)
        .to_string();
    meta_set(index, SEQ_KEY, &seq)?;
    Ok(seq)
}

/// Notes a row that failed to index: the pass goes on, and its last batch answers the first.
fn failed_row(resume: &mut Resume, failure: &mut Option<StorageError>, error: StorageError) {
    resume.failed = true;
    failure.get_or_insert(error);
}

/// Runs `index`, which writes one row's new rows, in a savepoint that first deletes `old`,
/// the rowids that held it: a failure rolls back to the row's old state.
fn replaced(
    index: &Connection,
    table: &str,
    old: &[i64],
    write: impl FnOnce() -> Result<(), StorageError>,
) -> Result<(), StorageError> {
    index
        .execute_batch("SAVEPOINT reindex_row")
        .map_err(failed)?;
    let written = (|| {
        let mut delete = index
            .prepare_cached(&format!("DELETE FROM {table} WHERE rowid = ?1"))
            .map_err(failed)?;
        for rowid in old {
            delete.execute(params![rowid]).map_err(failed)?;
        }
        write()
    })();
    let end = match &written {
        Ok(()) => "RELEASE reindex_row",
        Err(_) => "ROLLBACK TO reindex_row; RELEASE reindex_row",
    };
    index.execute_batch(end).map_err(failed)?;
    written
}

/// Brings `index.db` up to date with `data.db`, incrementally where it can.
///
/// Safe to call at any time and on any schedule: it is idempotent, and calling
/// it against an empty `index.db` is the supported full rebuild.
pub fn reindex(
    data: &Connection,
    index: &Connection,
    now_ms: i64,
) -> Result<Reindexed, StorageError> {
    reindex_until(data, index, now_ms, &|| false).map(|done| done.unwrap_or_default())
}

/// [`reindex`] that `stop` can end between two rows, on connections the caller holds for the
/// whole pass. Each batch commits on its own ([`ReindexPass`]): a stopped pass keeps the
/// batches it committed and the next pass goes on after them. `None` when stopped.
pub fn reindex_until(
    data: &Connection,
    index: &Connection,
    now_ms: i64,
    stop: &dyn Fn() -> bool,
) -> Result<Option<Reindexed>, StorageError> {
    let mut links = LinkChanges::default();
    loop {
        let mut pass = ReindexPass::plan(data, index)?;
        loop {
            match pass.batch(data, index, now_ms, stop)? {
                Step::More => {}
                Step::Done(mut done) => {
                    links.extend(std::mem::take(&mut done.links));
                    done.links = links;
                    return Ok(Some(done));
                }
                Step::Stopped => return Ok(None),
                Step::Stale => {
                    links.extend(pass.take_links());
                    break;
                }
            }
        }
    }
}

/// `id -> rowids` of an FTS5 table, read from its content table, whose `c0` is the `id`
/// column: a scan of the FTS table itself would read every row's text.
fn fts_rows(index: &Connection, content: &str) -> Result<HashMap<String, Vec<i64>>, StorageError> {
    let mut statement = index
        .prepare(&format!("SELECT id, c0 FROM {content}"))
        .map_err(failed)?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(failed)?;
    let mut found: HashMap<String, Vec<i64>> = HashMap::new();
    for row in rows {
        let (rowid, id) = row.map_err(failed)?;
        found.entry(id).or_default().push(rowid);
    }
    Ok(found)
}

fn user_version(conn: &Connection) -> Result<i64, StorageError> {
    conn.query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(failed)
}

fn meta_raw(index: &Connection, key: &str) -> Result<Option<String>, StorageError> {
    index
        .query_row(
            "SELECT value FROM index_meta WHERE key = ?1",
            params![key],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map(Option::flatten)
        .map_err(failed)
}
