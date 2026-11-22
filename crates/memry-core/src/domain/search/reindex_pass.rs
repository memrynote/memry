//! A search reindex in short transactions (#5417).
//!
//! A full rebuild of a 17k-note vault takes about a minute. Run as one transaction, it held
//! the `data.db` writer the whole time, so an editor save, a sync pass and the vault write-back
//! waited behind it. A pass is now planned once, on readers, and worked in batches of at most
//! [`BATCH_NOTES`] notes or [`BATCH_TIME`]: each batch takes the writers, commits, and lets go.
//!
//! **A batch commits a resume point.** `index_meta` [`RESUME_KEY`] records the pass (full or
//! not, the watermark it started from, the watermark it will set) and the last note committed.
//! A pass stopped by a vault close, or a crash, loses only its open batch; the next pass reads
//! the resume point and goes on after that note. The watermarks move only when the last batch
//! commits, so until then every note the pass has not reached is still owed.
//!
//! **Search stays correct while it runs.** A full pass empties `fts_notes` in its first batch,
//! and each batch adds the rows of its notes: a query meanwhile misses the notes not reached
//! yet and nothing else. Every note is written once per pass (the plan is sorted and the cursor
//! committed with the rows), so no row is doubled.
//!
//! **Two passes never interleave their batches.** Each batch checks, in its transaction, that
//! the resume point and the notes watermark are what its pass last committed or planned from.
//! A pass that finds them moved answers [`Step::Stale`] and is planned again.

use std::collections::BTreeSet;
use std::time::{Duration, Instant};

use rusqlite::{Connection, OptionalExtension as _, params};
use serde::{Deserialize, Serialize};

use crate::api::errors::StorageError;
use crate::domain::wiki_target::{WikiNames, settle_name_keys};
use crate::storage::nested_tx;

use super::failed;
use super::maintenance::{
    DATA_VERSION_KEY, NOTES_WATERMARK_KEY, Reindexed, STAMPS_KEY, STAMPS_VERSION,
    TASKS_WATERMARK_KEY, index_note, index_task, meta_number, meta_set, note_candidates,
    task_candidates,
};

/// `index_meta` key: the resume point of a pass that has committed a batch and not its last.
pub const RESUME_KEY: &str = "reindex.resume";
/// The most notes one batch indexes.
pub const BATCH_NOTES: usize = 200;
/// A batch that has run this long commits after the note it is on.
pub const BATCH_TIME: Duration = Duration::from_millis(50);

/// What [`RESUME_KEY`] holds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Resume {
    /// The `data.db` `user_version` the pass was planned against.
    version: i64,
    full: bool,
    notes_from: i64,
    /// The notes watermark the last batch sets.
    notes_to: i64,
    /// The last note committed.
    after: String,
}

/// What one [`ReindexPass::batch`] did.
#[derive(Debug)]
pub enum Step {
    /// The batch committed and notes remain.
    More,
    /// The last batch committed the watermarks.
    Done(Reindexed),
    /// `stop` answered true: the open batch rolled back, the committed ones stand.
    Stopped,
    /// Another pass committed since this one planned: plan again.
    Stale,
}

/// One reindex pass, planned and then worked in batches.
pub struct ReindexPass {
    version: i64,
    full: bool,
    /// The full pass has not emptied the tables yet.
    fresh: bool,
    notes_from: i64,
    notes_to: i64,
    /// Ascending; `notes[next..]` remain.
    notes: Vec<String>,
    next: usize,
    /// The `(resume point, notes watermark)` this pass expects to find, raw.
    expect: (Option<String>, Option<String>),
    /// Loaded at the first batch and again after a batch settled changed names: reading every
    /// name per batch would cost a 17k-note vault seconds over a pass.
    names: Option<WikiNames>,
    done: Reindexed,
}

impl ReindexPass {
    /// Plans a pass, or the rest of a stopped one: reads only, so `data` and `index` may be
    /// readers and no writer waits on the walk of the vault's changes.
    pub fn plan(data: &Connection, index: &Connection) -> Result<Self, StorageError> {
        let version: i64 = data
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(failed)?;
        let expect = (
            meta_raw(index, RESUME_KEY)?,
            meta_raw(index, NOTES_WATERMARK_KEY)?,
        );
        let notes_watermark = meta_number(index, NOTES_WATERMARK_KEY)?;
        let needs_full = meta_number(index, DATA_VERSION_KEY)? != Some(version)
            || meta_number(index, STAMPS_KEY)? != Some(STAMPS_VERSION)
            || notes_watermark.is_none()
            || meta_number(index, TASKS_WATERMARK_KEY)?.is_none();
        let resume = expect
            .0
            .as_deref()
            .and_then(|raw| serde_json::from_str::<Resume>(raw).ok())
            .filter(|resume| {
                resume.version == version
                    && (resume.full || !needs_full)
                    && (resume.full == notes_watermark.is_none())
                    && (resume.full || notes_watermark == Some(resume.notes_from))
            });
        let (full, notes_from) = match &resume {
            Some(resume) => (resume.full, resume.notes_from),
            None if needs_full => (true, 0),
            None => (false, notes_watermark.unwrap_or(0)),
        };
        let (ids, high) = note_candidates(data, notes_from)?;
        let (notes, notes_to) = match &resume {
            Some(resume) => (
                ids.into_iter()
                    .filter(|id| id.as_str() > resume.after.as_str())
                    .collect(),
                resume.notes_to,
            ),
            None => (
                ids.into_iter().collect(),
                high.unwrap_or(notes_from).max(notes_from),
            ),
        };
        Ok(Self {
            version,
            full,
            fresh: full && resume.is_none(),
            notes_from,
            notes_to,
            notes,
            next: 0,
            expect,
            names: None,
            done: Reindexed {
                full,
                ..Reindexed::default()
            },
        })
    }

    /// Indexes the next batch in one `index.db` transaction and commits it. `data` and `index`
    /// are the writers; the caller lets go of both before the next batch. `stop` can end the
    /// batch between two rows, which rolls back that batch only.
    pub fn batch(
        &mut self,
        data: &Connection,
        index: &Connection,
        now_ms: i64,
        stop: &dyn Fn() -> bool,
    ) -> Result<Step, StorageError> {
        // The wiki names changed since the last batch get their lookup keys back, so a link
        // lookup reads only its matches again (`wiki_target`). Only the reindex settles them,
        // so a batch that settled none sees the names the last one loaded.
        if settle_name_keys(data)? > 0 {
            self.names = None;
        }
        let transaction = nested_tx::begin(index).map_err(failed)?;
        let found = (
            meta_raw(&transaction, RESUME_KEY)?,
            meta_raw(&transaction, NOTES_WATERMARK_KEY)?,
        );
        if found != self.expect {
            return Ok(Step::Stale);
        }
        if self.fresh {
            transaction
                .execute_batch("DELETE FROM fts_notes; DELETE FROM fts_tasks;")
                .map_err(failed)?;
            transaction
                .execute(
                    "DELETE FROM index_meta WHERE key IN (?1, ?2)",
                    params![NOTES_WATERMARK_KEY, TASKS_WATERMARK_KEY],
                )
                .map_err(failed)?;
        }

        let started = Instant::now();
        let mut batch = BTreeSet::new();
        if self.next < self.notes.len() {
            let names = match &mut self.names {
                Some(names) => &*names,
                None => &*self.names.insert(WikiNames::load(data)?),
            };
            while self.next < self.notes.len()
                && batch.len() < BATCH_NOTES
                && (batch.is_empty() || started.elapsed() < BATCH_TIME)
            {
                if stop() {
                    return Ok(Step::Stopped);
                }
                let id = &self.notes[self.next];
                index_note(
                    data,
                    names,
                    &transaction,
                    id,
                    now_ms,
                    self.full,
                    &mut self.done,
                )?;
                batch.insert(id.clone());
                self.next += 1;
            }
            if !self.full {
                super::links::reresolve(names, &transaction, &batch, &mut self.done.links)?;
            }
        }

        if self.next < self.notes.len() {
            let resume = Resume {
                version: self.version,
                full: self.full,
                notes_from: self.notes_from,
                notes_to: self.notes_to,
                after: self.notes[self.next - 1].clone(),
            };
            let raw = serde_json::to_string(&resume).map_err(|error| StorageError::Failed {
                what: format!("the reindex resume point will not serialise: {error}"),
            })?;
            meta_set(&transaction, RESUME_KEY, &raw)?;
            let watermark = meta_raw(&transaction, NOTES_WATERMARK_KEY)?;
            transaction.commit().map_err(failed)?;
            self.fresh = false;
            self.expect = (Some(raw), watermark);
            return Ok(Step::More);
        }

        let tasks_from = if self.full {
            0
        } else {
            meta_number(&transaction, TASKS_WATERMARK_KEY)?.unwrap_or(0)
        };
        let (task_ids, tasks_high) = task_candidates(data, tasks_from)?;
        for id in &task_ids {
            if stop() {
                return Ok(Step::Stopped);
            }
            index_task(data, &transaction, id, &mut self.done)?;
        }
        super::inbox::reindex(data, &transaction, self.full, &mut self.done)?;

        meta_set(&transaction, DATA_VERSION_KEY, &self.version.to_string())?;
        meta_set(&transaction, STAMPS_KEY, &STAMPS_VERSION.to_string())?;
        meta_set(
            &transaction,
            NOTES_WATERMARK_KEY,
            &self.notes_to.to_string(),
        )?;
        meta_set(
            &transaction,
            TASKS_WATERMARK_KEY,
            &tasks_high.unwrap_or(tasks_from).max(tasks_from).to_string(),
        )?;
        transaction
            .execute("DELETE FROM index_meta WHERE key = ?1", params![RESUME_KEY])
            .map_err(failed)?;
        transaction.commit().map_err(failed)?;
        Ok(Step::Done(std::mem::take(&mut self.done)))
    }
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
/// batches it committed and the next pass goes on after them. The `data.db` body tags of the
/// notes in the batch it stopped are written outside that transaction; each is derived from
/// the note's document, so the next pass writes the same rows again. `None` when stopped.
pub fn reindex_until(
    data: &Connection,
    index: &Connection,
    now_ms: i64,
    stop: &dyn Fn() -> bool,
) -> Result<Option<Reindexed>, StorageError> {
    loop {
        let mut pass = ReindexPass::plan(data, index)?;
        loop {
            match pass.batch(data, index, now_ms, stop)? {
                Step::More => {}
                Step::Done(done) => return Ok(Some(done)),
                Step::Stopped => return Ok(None),
                Step::Stale => break,
            }
        }
    }
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
