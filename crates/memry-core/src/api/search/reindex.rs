//! The search reindex in batches that let go of the `data.db` writer between them (#5417).

use super::Search;
use crate::api::errors::StorageError;
use crate::domain::search::{self, LinkChanges};

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
    pub(super) fn reindex_in_batches(
        &self,
        stop: &dyn Fn() -> bool,
        links: &mut LinkChanges,
    ) -> Result<Option<search::Reindexed>, StorageError> {
        loop {
            let mut pass = self.data.read_blocking(|data| {
                self.index
                    .read_blocking(|index| search::ReindexPass::plan(data, index))
            })?;
            loop {
                // Settling the changed names is a short take; reading every name is not, so
                // it runs on a reader.
                let batch = self
                    .data
                    .call_blocking(|data| pass.settle_names(data))
                    .and_then(|()| self.data.read_blocking(|data| pass.load_names(data)))
                    .and_then(|()| {
                        self.data.call_blocking(|data| {
                            let held = std::time::Instant::now();
                            let step = self.index.call_blocking(|index| {
                                pass.batch(data, index, super::now_ms(), stop)
                            })?;
                            let rest = (self.data.writers_waiting() > 0).then(|| held.elapsed());
                            Ok((step, rest))
                        })
                    });
                let (step, rest) = match batch {
                    Ok(batch) => batch,
                    Err(error) => {
                        links.extend(pass.take_links());
                        return Err(error);
                    }
                };
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
