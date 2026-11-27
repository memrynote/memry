//! The search reindex in batches that let go of the `data.db` writer between them (#5417).

use std::cell::OnceCell;

use super::Search;
use crate::api::errors::StorageError;
use crate::domain::search::{self, LinkChanges};
use crate::storage::nested_tx;

impl Search {
    /// [`Search::reindex`] that `stop` can end between two rows (`false`): the batches it
    /// committed stand and the next pass goes on after them. The links each committed batch
    /// changed go into `links` as it commits, so a pass that stops, fails or is planned again
    /// still owes them to desktop's announcement. For desktop's note index, which must let go
    /// of both databases when the vault closes. Not on the FFI surface.
    pub fn reindex_until(
        &self,
        stop: &dyn Fn() -> bool,
        links: &mut LinkChanges,
    ) -> Result<bool, StorageError> {
        Ok(self.reindex_in_batches(stop, links)?.is_some())
    }

    /// Plans the pass on readers, then holds the writers of both databases for one batch at a
    /// time ([`search::ReindexPass`]), so a writer waiting on `data.db` waits one batch. A
    /// batch that ends with writers waiting rests as long as it held the writer, so they get
    /// at least half of it while a pass runs.
    ///
    /// The batch writes `index.db` into a transaction opened here and commits `data.db`; that
    /// transaction commits after the `data.db` writer is let go (#5468), so a save or the vault
    /// write-back never waits on the search-index commit. The lock order stays `data.db` then
    /// `index.db`: the index writer is taken under the data writer and only outlives it. A crash
    /// between the two commits leaves `data.db` ahead of an index whose resume point and
    /// watermarks are unmoved, so the next pass indexes that batch again from `data.db`.
    /// A failed index commit ends the pass, as a failed batch does.
    pub(super) fn reindex_in_batches(
        &self,
        stop: &dyn Fn() -> bool,
        links: &mut LinkChanges,
    ) -> Result<Option<search::Reindexed>, StorageError> {
        loop {
            let mut pass = self.plan_reindex()?;
            loop {
                let (step, rest) = self.reindex_batch(&mut pass, stop, links)?;
                match step {
                    search::ReindexStep::More => {}
                    search::ReindexStep::Done(mut done) => {
                        links.extend(std::mem::take(&mut done.links));
                        return Ok(Some(done));
                    }
                    search::ReindexStep::Stopped => {
                        links.extend(pass.take_links());
                        return Ok(None);
                    }
                    search::ReindexStep::Stale => {
                        links.extend(pass.take_links());
                        break;
                    }
                }
                if let Some(rest) = rest {
                    rest_between_batches(rest, stop);
                }
            }
        }
    }

    /// Plans a pass on readers ([`search::ReindexPass::plan`]).
    pub(super) fn plan_reindex(&self) -> Result<search::ReindexPass, StorageError> {
        self.data.read_blocking(|data| {
            self.index
                .read_blocking(|index| search::ReindexPass::plan(data, index))
        })
    }

    /// One batch of `pass` under both writers, as [`Search::reindex_in_batches`] describes,
    /// and how long the batch should rest when writers queued behind it. A failed batch hands
    /// the links it owes to `links` and ends the pass.
    pub(super) fn reindex_batch(
        &self,
        pass: &mut search::ReindexPass,
        stop: &dyn Fn() -> bool,
        links: &mut LinkChanges,
    ) -> Result<(search::ReindexStep, Option<std::time::Duration>), StorageError> {
        // Settling the changed names is a short take; reading every name is not, so
        // it runs on a reader.
        let index_writer = OnceCell::new();
        let batch = self
            .data
            .call_blocking(|data| pass.settle_names(data))
            .and_then(|()| self.data.read_blocking(|data| pass.load_names(data)))
            .and_then(|()| {
                let (step, index_tx, rest) = self.data.call_blocking(|data| {
                    let held = std::time::Instant::now();
                    let _ = index_writer.set(self.index.hold_writer()?);
                    let index = index_writer.get().expect("set above");
                    let index_tx = nested_tx::begin(index).map_err(search::failed)?;
                    let step = pass.batch(data, &index_tx, super::now_ms(), stop)?;
                    // Counted under the writer: once it is let go, a waiter takes it.
                    let rest = (self.data.writers_waiting() > 0).then(|| held.elapsed());
                    Ok((step, index_tx, rest))
                })?;
                match index_tx.commit().map_err(search::failed) {
                    Ok(()) => Ok((step, rest)),
                    Err(error) => {
                        if let search::ReindexStep::Done(done) = step {
                            links.extend(done.links);
                        }
                        Err(error)
                    }
                }
            });
        // Let go of index.db before the rest: a save takes data.db then index.db, and
        // would wait on this writer while holding data.db (REVIEW-5503).
        drop(index_writer);
        batch.inspect_err(|_| links.extend(pass.take_links()))
    }
}

/// Parks the reindex for `rest` (capped at a second), waking every few milliseconds for
/// `stop`, so the writes that queued behind a batch run before the next one.
fn rest_between_batches(rest: std::time::Duration, stop: &dyn Fn() -> bool) {
    const SLICE: std::time::Duration = std::time::Duration::from_millis(10);
    let until = std::time::Instant::now() + rest.min(std::time::Duration::from_secs(1));
    while !stop() {
        let left = until.saturating_duration_since(std::time::Instant::now());
        if left.is_zero() {
            return;
        }
        std::thread::park_timeout(left.min(SLICE));
    }
}
