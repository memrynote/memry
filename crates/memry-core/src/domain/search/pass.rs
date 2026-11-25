//! [`super::reindex`] in batches, each its own `index.db` transaction, so the
//! caller can let go of `data.db` between them (#5842).
//!
//! A full rebuild of a 17k-note vault is minutes of work. Run as one call it
//! held the vault's `data.db` mutex the whole time, and the sync pass started
//! beside it at app open waited for all of it.
//!
//! **The plan.** The first step reads the watermarks, empties the tables a full
//! rebuild owes, and lists every note, task and capture with a row stamped at
//! or after its table's watermark. Each step indexes at most `batch` of them
//! from `data.db` as it is then and, in the same hold, records the stamps of
//! the rows it read for each ([`Stamps`]).
//!
//! **The catch-up.** Once the list is drained, a step lists again from the
//! same watermarks and indexes again every id that is new to the pass or whose
//! stamps differ from the ones its batch read. Only the stamps are compared,
//! never a clock: writers take their stamp inside the `data.db` hold that
//! writes the row (#5849), but a wall clock can step back, so a row landing
//! after a batch can still carry a stamp older than that batch's read. An id with a row that has no stamp (`synced_at` NULL)
//! cannot say whether it moved, so the last listing indexes it again.
//!
//! **The last step.** It is the step whose listing finds at most `batch`
//! rows to index, or the one after [`CATCH_UP_ROUNDS`] catch-ups, and it
//! indexes them all in one transaction together with the watermarks: the
//! largest stamp listed. It holds `data.db` for at most `batch` rows plus the
//! stamp-less ones, and, when the vault kept changing for every catch-up, for
//! whatever the last listing found.
//!
//! **A pass that stops part way** (an error, or a dropped pass) wrote no
//! watermark, so every row it had not finished is still owed. A full rebuild
//! that stops part way left the version stamps unwritten, and the next pass is
//! full again.
//!
//! **A pass belongs to one `index.db`.** The plan writes [`PASS_KEY`], and a
//! step that finds another value (the file was rebuilt, or another pass
//! planned) drops the pass and plans again. Two passes over one `index.db`
//! must not interleave, since a full plan empties what the other indexed: the
//! caller runs one at a time.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::atomic::{AtomicU64, Ordering};

use rusqlite::Connection;

use crate::api::errors::StorageError;
use crate::domain::wiki_target::WikiNames;
use crate::storage::nested_tx;

use super::failed;
use super::inbox::{INBOX_WATERMARK_KEY, inbox_candidates, inbox_stamps, index_item};
use super::maintenance::{
    DATA_VERSION_KEY, NOTES_WATERMARK_KEY, Reindexed, STAMPS_KEY, STAMPS_VERSION, Stamps,
    TASKS_WATERMARK_KEY, index_note, index_task, meta_number, meta_set, note_candidates,
    note_stamps, task_candidates, task_stamps,
};

/// The most rows one [`ReindexPass::step`] of `Search::reindex` indexes: about
/// half a second of `data.db` on a large vault (#5842).
pub const REINDEX_BATCH: usize = 64;

/// Catch-up listings a pass works in batches. The one after them is the last
/// step whatever it finds, so a vault that never stops changing still ends the
/// pass.
pub const CATCH_UP_ROUNDS: usize = 4;

/// `index_meta` key: the pass planned against this `index.db`.
pub const PASS_KEY: &str = "reindex.pass";

/// Tells apart two passes planned in one millisecond.
static PLANNED: AtomicU64 = AtomicU64::new(0);

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
    /// This pass's [`PASS_KEY`].
    token: i64,
    version: i64,
    full: bool,
    notes: Queue,
    tasks: Queue,
    inbox: Queue,
    rounds: usize,
}

type List = fn(&Connection, i64) -> Result<BTreeMap<String, Stamps>, StorageError>;
type StampsOf = fn(&Connection, i64, &str) -> Result<Stamps, StorageError>;

/// One table's rows in a pass.
struct Queue {
    list: List,
    stamps_of: StampsOf,
    /// The watermark the pass planned from. Every listing starts here.
    from: i64,
    /// The largest stamp listed yet: the watermark the last step writes.
    high: i64,
    /// Listed and not indexed yet, ascending.
    ids: Vec<String>,
    /// The stamps each id had when a step last indexed it.
    read: HashMap<String, Stamps>,
}

impl Queue {
    fn new(
        data: &Connection,
        from: i64,
        list: List,
        stamps_of: StampsOf,
    ) -> Result<Self, StorageError> {
        let listed = list(data, from)?;
        Ok(Self {
            list,
            stamps_of,
            from,
            high: high(&listed, from),
            ids: listed.into_keys().collect(),
            read: HashMap::new(),
        })
    }

    /// Lists the ids whose stamps moved since they were read. Answers the
    /// stamp-less ones it left out because their stamps did not move.
    fn relist(&mut self, data: &Connection) -> Result<Vec<String>, StorageError> {
        let listed = (self.list)(data, self.from)?;
        self.high = high(&listed, self.high);
        let mut unstamped = Vec::new();
        for (id, stamps) in listed {
            match self.read.get(&id) {
                Some(read) if *read == stamps => {
                    if stamps.contains(&None) {
                        unstamped.push(id);
                    }
                }
                _ => self.ids.push(id),
            }
        }
        Ok(unstamped)
    }

    fn take(&mut self, count: usize) -> Vec<String> {
        let rest = self.ids.split_off(count.min(self.ids.len()));
        std::mem::replace(&mut self.ids, rest)
    }

    /// Records the stamps of `id`'s rows. Called in the hold that indexed it.
    fn read(&mut self, data: &Connection, id: String) -> Result<(), StorageError> {
        let stamps = (self.stamps_of)(data, self.from, &id)?;
        self.read.insert(id, stamps);
        Ok(())
    }
}

impl ReindexPass {
    /// Runs the next batch of at most `batch` rows in one transaction of
    /// `index`, and commits it.
    pub fn step(
        &mut self,
        data: &Connection,
        index: &Connection,
        now_ms: i64,
        batch: usize,
    ) -> Result<ReindexStep, StorageError> {
        let transaction = nested_tx::begin(index).map_err(failed)?;
        if let Some(plan) = &self.plan
            && meta_number(&transaction, PASS_KEY)? != Some(plan.token)
        {
            self.plan = None;
            self.done = Reindexed::default();
        }
        // `last`: this step listed, in this transaction, everything it will
        // index, and indexes all of it.
        let last = match &mut self.plan {
            None => {
                let plan = Plan::new(data, &transaction, now_ms)?;
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
                plan.notes.read(data, id.clone())?;
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
            plan.tasks.read(data, id)?;
        }
        for id in plan.inbox.take(room) {
            index_item(data, &transaction, &id, &mut self.done)?;
            plan.inbox.read(data, id)?;
        }

        if last {
            meta_set(&transaction, DATA_VERSION_KEY, &plan.version.to_string())?;
            meta_set(&transaction, STAMPS_KEY, &STAMPS_VERSION.to_string())?;
            for (key, queue) in [
                (NOTES_WATERMARK_KEY, &plan.notes),
                (TASKS_WATERMARK_KEY, &plan.tasks),
                (INBOX_WATERMARK_KEY, &plan.inbox),
            ] {
                meta_set(&transaction, key, &queue.high.to_string())?;
            }
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
    fn new(data: &Connection, index: &Connection, now_ms: i64) -> Result<Self, StorageError> {
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
        let planned = PLANNED.fetch_add(1, Ordering::Relaxed) % 1_000;
        let token = now_ms.saturating_mul(1_000).saturating_add(planned as i64);
        meta_set(index, PASS_KEY, &token.to_string())?;
        Ok(Self {
            token,
            version,
            full,
            notes: Queue::new(data, notes_from, note_candidates, note_stamps)?,
            tasks: Queue::new(data, tasks_from, task_candidates, task_stamps)?,
            inbox: Queue::new(data, inbox_from, inbox_candidates, inbox_stamps)?,
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
            self.notes.relist(data)?,
            self.tasks.relist(data)?,
            self.inbox.relist(data)?,
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
fn high(listed: &BTreeMap<String, Stamps>, from: i64) -> i64 {
    listed
        .values()
        .flatten()
        .flatten()
        .copied()
        .max()
        .unwrap_or(from)
        .max(from)
}
