//! [`super::reindex`] in batches, each its own `index.db` transaction, so the
//! caller can let go of `data.db` between them (#5842).
//!
//! A full rebuild of a 17k-note vault is minutes of work. Run as one call it
//! held the vault's `data.db` mutex the whole time, and the sync pass started
//! beside it at app open waited for all of it.
//!
//! **The plan.** The first step reads the watermarks, empties the tables a full
//! rebuild owes, and lists every note, task and capture that moved, with its
//! stamp. Each step indexes at most `batch` of them from `data.db` as it is
//! then, and records when it read each one.
//!
//! **The catch-up.** A row written after the plan has a stamp at or above the
//! plan's largest, so once the list is drained a step lists again from there.
//! A row is indexed again when it is new to the pass, or when its stamp is not
//! older than the moment its batch read it: an edit in that same millisecond
//! is not taken for the version already read. A row with no stamp
//! (`synced_at` NULL) cannot say whether it moved, so the last listing indexes
//! it again.
//!
//! **The last step.** It is the step whose listing finds at most `batch`
//! rows to index, or the one after [`CATCH_UP_ROUNDS`] catch-ups, and it
//! indexes them all in one transaction together with the watermarks it chose.
//! It holds `data.db` for at most `batch` rows plus the stamp-less ones, and,
//! when the vault kept changing for every catch-up, for whatever the last
//! listing found.
//!
//! **A pass that stops part way** (an error, or a dropped pass) wrote no
//! watermark, so every row it had not finished is still owed. A full rebuild
//! that stops part way left the version stamps unwritten, and the next pass is
//! full again.
//!
//! Two passes over one `index.db` must not interleave: a full pass's plan
//! empties what the other has indexed. The caller runs one at a time.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use rusqlite::Connection;

use crate::api::errors::StorageError;
use crate::domain::wiki_target::WikiNames;
use crate::storage::nested_tx;

use super::failed;
use super::inbox::{INBOX_WATERMARK_KEY, inbox_candidates, index_item};
use super::maintenance::{
    DATA_VERSION_KEY, NOTES_WATERMARK_KEY, Reindexed, STAMPS_KEY, STAMPS_VERSION,
    TASKS_WATERMARK_KEY, index_note, index_task, meta_number, meta_set, note_candidates,
    task_candidates,
};

/// The most rows one [`ReindexPass::step`] of `Search::reindex` indexes: about
/// half a second of `data.db` on a large vault (#5842).
pub const REINDEX_BATCH: usize = 64;

/// Catch-up listings a pass works in batches. The one after them is the last
/// step whatever it finds, so a vault that never stops changing still ends the
/// pass.
pub const CATCH_UP_ROUNDS: usize = 4;

/// What one [`ReindexPass::step`] did.
#[derive(Debug)]
pub enum ReindexStep {
    /// The batch committed and the pass goes on.
    More,
    /// The last step committed the watermarks.
    Done(Reindexed),
}

/// A reindex worked one [`ReindexPass::step`] at a time.
#[derive(Default)]
pub struct ReindexPass {
    plan: Option<Plan>,
    done: Reindexed,
}

struct Plan {
    version: i64,
    full: bool,
    notes: Queue,
    tasks: Queue,
    inbox: Queue,
    rounds: usize,
}

/// One table's rows in a pass.
struct Queue {
    /// The largest stamp listed yet: the watermark the last step writes.
    high: i64,
    /// Listed and not indexed yet, ascending.
    ids: Vec<String>,
    /// When the step that last indexed each id read `data.db`.
    read_at: HashMap<String, i64>,
}

impl Queue {
    fn new(listed: BTreeMap<String, Option<i64>>, from: i64) -> Self {
        Self {
            high: high(&listed, from),
            ids: listed.into_keys().collect(),
            read_at: HashMap::new(),
        }
    }

    /// Lists the rows of `listed` that moved since they were read. Answers
    /// the stamp-less ones it left out because they were read already.
    fn relist(&mut self, listed: BTreeMap<String, Option<i64>>) -> Vec<String> {
        self.high = high(&listed, self.high);
        let mut unstamped = Vec::new();
        for (id, stamp) in listed {
            match (self.read_at.get(&id), stamp) {
                (Some(read), Some(stamp)) if stamp < *read => {}
                (Some(_), None) => unstamped.push(id),
                _ => self.ids.push(id),
            }
        }
        unstamped
    }

    fn take(&mut self, count: usize) -> Vec<String> {
        let rest = self.ids.split_off(count.min(self.ids.len()));
        std::mem::replace(&mut self.ids, rest)
    }
}

impl ReindexPass {
    /// Runs the next batch of at most `batch` rows in one transaction of
    /// `index`, and commits it. `now_ms` is read before `data.db` was taken.
    pub fn step(
        &mut self,
        data: &Connection,
        index: &Connection,
        now_ms: i64,
        batch: usize,
    ) -> Result<ReindexStep, StorageError> {
        let transaction = nested_tx::begin(index).map_err(failed)?;
        // `last`: this step listed, in this transaction, everything it will
        // index, and indexes all of it.
        let last = match &mut self.plan {
            None => {
                let plan = Plan::new(data, &transaction)?;
                self.done.full = plan.full;
                let last = plan.pending() <= batch;
                self.plan = Some(plan);
                last
            }
            Some(plan) if plan.pending() == 0 => plan.catch_up(data, batch)?,
            Some(_) => false,
        };
        let plan = self.plan.as_mut().expect("planned above");
        let mut room = if last { usize::MAX } else { batch };

        let notes = plan.notes.take(room);
        room -= notes.len().min(room);
        if !notes.is_empty() {
            let names = WikiNames::load(data)?;
            for id in &notes {
                index_note(data, &names, &transaction, id, now_ms, &mut self.done)?;
                plan.notes.read_at.insert(id.clone(), now_ms);
            }
            // A full plan indexes every note against the same names; one a
            // catch-up lists may be a name the others link to.
            if !plan.full || plan.rounds > 0 {
                let changed: BTreeSet<String> = notes.into_iter().collect();
                super::links::reresolve(&names, &transaction, &changed)?;
            }
        }
        let tasks = plan.tasks.take(room);
        room -= tasks.len().min(room);
        for id in tasks {
            index_task(data, &transaction, &id, &mut self.done)?;
            plan.tasks.read_at.insert(id, now_ms);
        }
        for id in plan.inbox.take(room) {
            index_item(data, &transaction, &id, &mut self.done)?;
            plan.inbox.read_at.insert(id, now_ms);
        }

        if last {
            meta_set(&transaction, DATA_VERSION_KEY, &plan.version.to_string())?;
            meta_set(&transaction, STAMPS_KEY, &STAMPS_VERSION.to_string())?;
            meta_set(
                &transaction,
                NOTES_WATERMARK_KEY,
                &plan.notes.high.to_string(),
            )?;
            meta_set(
                &transaction,
                TASKS_WATERMARK_KEY,
                &plan.tasks.high.to_string(),
            )?;
            meta_set(
                &transaction,
                INBOX_WATERMARK_KEY,
                &plan.inbox.high.to_string(),
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
        let inbox_from = meta_number(index, INBOX_WATERMARK_KEY)?;
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
        // `fts_inbox` keeps its own watermark (#4320): a missing one empties
        // the table on its own.
        let inbox_from = match inbox_from {
            Some(from) if !full => from,
            _ => {
                index
                    .execute_batch("DELETE FROM fts_inbox;")
                    .map_err(failed)?;
                0
            }
        };
        let notes_from = if full { 0 } else { notes_from.unwrap_or(0) };
        let tasks_from = if full { 0 } else { tasks_from.unwrap_or(0) };
        Ok(Self {
            version,
            full,
            notes: Queue::new(note_candidates(data, notes_from)?, notes_from),
            tasks: Queue::new(task_candidates(data, tasks_from)?, tasks_from),
            inbox: Queue::new(inbox_candidates(data, inbox_from)?, inbox_from),
            rounds: 0,
        })
    }

    fn pending(&self) -> usize {
        self.notes.ids.len() + self.tasks.ids.len() + self.inbox.ids.len()
    }

    /// Lists what moved since it was read. Answers whether this is the last
    /// listing, which then also lists the stamp-less rows again.
    fn catch_up(&mut self, data: &Connection, batch: usize) -> Result<bool, StorageError> {
        let unstamped = [
            self.notes.relist(note_candidates(data, self.notes.high)?),
            self.tasks.relist(task_candidates(data, self.tasks.high)?),
            self.inbox.relist(inbox_candidates(data, self.inbox.high)?),
        ];
        self.rounds += 1;
        let last = self.pending() <= batch || self.rounds > CATCH_UP_ROUNDS;
        if last {
            let queues = [&mut self.notes, &mut self.tasks, &mut self.inbox];
            for (queue, unstamped) in queues.into_iter().zip(unstamped) {
                queue.ids.extend(unstamped);
                queue.ids.sort();
            }
        }
        Ok(last)
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
