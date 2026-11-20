//! The foreground drain (#5233): the bodies a first sync left owed, pulled
//! round after round while the shell is in the foreground, until none is owed.
//!
//! A first sync whose packs covered the vault owes nothing and the drain has
//! nothing to do. With partial coverage the first sync pulls the owed
//! documents of the recent window and leaves the rest owed, and the ordinary
//! pass's body step would take many sessions to reach them at
//! [`super::body_step::BODY_REQUEST_BUDGET`] requests a pass. Here the shell
//! keeps asking for rounds.
//!
//! One round is at most [`DRAIN_ROUND_DOCUMENTS`] due documents, so a round
//! holds the vault's pass gate for a bounded time and a write's pass waits
//! for at most one round. Each document goes through the body step's own
//! [`pull_one`]: settled when the pull reached the server's head, backed off
//! after a failure, and a `429` or a lost network ends the round with every
//! document not reached still owed. Only a local storage failure is an error.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tokio::task::JoinSet;

use crate::api::errors::StorageError;
use crate::storage::Db;

use super::body_pull::{BodyPull, BodyPullError, BodyPullReport, PROBE_CHUNK, Probed};
use super::body_step::{Step, pull_one};
use super::first_sync::{FirstSyncPhase, FirstSyncProgress, ProgressSink, read_body_counts};
use super::{body_debt, body_heal};

/// Due documents one round pulls at most. About a minute and a half at one
/// stream and ~200 ms a request, a third of that at four.
pub const DRAIN_ROUND_DOCUMENTS: usize = 400;

/// What one round did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DrainReport {
    /// Documents pulled, settled or not.
    pub documents: usize,
    /// Documents whose debt the round settled.
    pub settled: usize,
    pub requests: usize,
    /// Live documents still owed after the round, backed-off ones included.
    pub remaining: usize,
}

/// The documents due now, at most one round of them. Local only: runs the
/// one-time heal first, as the body step does, and makes no request.
pub async fn take_due(db: &Db) -> Result<Vec<String>, StorageError> {
    db.call(|conn| {
        body_heal::owe_unread_documents(conn)?;
        let mut due = body_debt::due(conn)?;
        due.truncate(DRAIN_ROUND_DOCUMENTS);
        Ok(due)
    })
    .await
}

/// Live documents still owed. Local only.
pub async fn remaining(db: &Db) -> Result<usize, StorageError> {
    Ok(read_body_counts(db).await?.1 as usize)
}

/// Pulls `due`, `workers` documents at a time, one probe chunk after another.
///
/// Progress is `Bodies`, in live documents of the vault: done is every live
/// document not owed, and each settled debt moves it by one.
pub async fn run(
    db: &Db,
    bodies: &Arc<BodyPull>,
    due: Vec<String>,
    workers: usize,
    progress: Arc<dyn ProgressSink>,
) -> Result<DrainReport, StorageError> {
    let (live, owed) = read_body_counts(db).await?;
    let tally = Arc::new(Tally {
        completed: Mutex::new(live.saturating_sub(owed)),
        total: live,
        progress,
    });
    tally.tick();

    let mut report = DrainReport::default();
    let ended = Arc::new(AtomicBool::new(false));
    for chunk in due.chunks(PROBE_CHUNK) {
        let mut probed: HashMap<String, Probed> =
            match bodies.probe(chunk, &mut report.requests).await {
                Ok(probed) => probed,
                Err(BodyPullError::Storage { source }) => return Err(source),
                // Each document then pulls through the ordinary §7.8 path.
                Err(BodyPullError::Api { .. }) => HashMap::new(),
            };
        let queue: VecDeque<(String, Option<Probed>)> = chunk
            .iter()
            .map(|doc_id| (doc_id.clone(), probed.remove(doc_id)))
            .collect();
        let queue = Arc::new(Mutex::new(queue));
        let mut running = JoinSet::new();
        for _ in 0..workers.clamp(1, chunk.len()) {
            running.spawn(worker(
                db.clone(),
                Arc::clone(bodies),
                Arc::clone(&queue),
                Arc::clone(&ended),
                Arc::clone(&tally),
            ));
        }
        while let Some(joined) = running.join_next().await {
            match joined {
                Ok(Ok((part, settled))) => {
                    report.documents += part.documents;
                    report.requests += part.requests;
                    report.settled += settled;
                }
                // Dropping the set aborts the other workers; what they stored
                // is durable with its cursor, and their debts remain.
                Ok(Err(error)) => return Err(error),
                Err(join) if join.is_panic() => std::panic::resume_unwind(join.into_panic()),
                // Only `abort` cancels a worker, and nothing here calls it.
                Err(_) => {}
            }
        }
        if ended.load(Ordering::SeqCst) {
            break;
        }
    }
    report.remaining = remaining(db).await?;
    Ok(report)
}

/// One stream: owed documents off the chunk's queue until it is empty or the
/// round ends.
async fn worker(
    db: Db,
    bodies: Arc<BodyPull>,
    queue: Arc<Mutex<VecDeque<(String, Option<Probed>)>>>,
    ended: Arc<AtomicBool>,
    tally: Arc<Tally>,
) -> Result<(BodyPullReport, usize), StorageError> {
    let mut part = BodyPullReport::default();
    let mut settled = 0;
    while !ended.load(Ordering::SeqCst) {
        let next = queue
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .pop_front();
        let Some((doc_id, probed)) = next else { break };
        match pull_one(&db, &bodies, &doc_id, probed, &mut part).await? {
            Step::Settled => {
                settled += 1;
                tally.advance();
            }
            Step::Owed => {}
            Step::Ended => ended.store(true, Ordering::SeqCst),
        }
    }
    Ok((part, settled))
}

/// The round's count, reported under its lock so two workers settling
/// together never move the bar backwards.
struct Tally {
    completed: Mutex<u64>,
    total: u64,
    progress: Arc<dyn ProgressSink>,
}

impl Tally {
    fn lock(&self) -> std::sync::MutexGuard<'_, u64> {
        self.completed
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn report(&self, completed: u64) {
        self.progress.progress(FirstSyncProgress {
            phase: FirstSyncPhase::Bodies,
            completed: completed.min(self.total),
            total: Some(self.total),
        });
    }

    fn tick(&self) {
        let completed = self.lock();
        self.report(*completed);
    }

    fn advance(&self) {
        let mut completed = self.lock();
        *completed += 1;
        self.report(*completed);
    }
}
