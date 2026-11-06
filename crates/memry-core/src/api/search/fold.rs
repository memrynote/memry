//! The desktop's note fold cache ([`fold_chunks`]) in `index.db`. Not on the FFI surface.

use crate::api::errors::StorageError;
use crate::domain::fold_chunks::{self, ChunkKey};

use super::Search;

impl Search {
    pub fn fold_chunk(&self, key: &ChunkKey) -> Result<Option<String>, StorageError> {
        let key = key.clone();
        self.index
            .read_blocking(move |index| fold_chunks::read(index, &key))
    }

    pub fn put_fold_chunk(
        &self,
        key: &ChunkKey,
        payload: &str,
        now_ms: i64,
    ) -> Result<(), StorageError> {
        let (key, payload) = (key.clone(), payload.to_owned());
        self.index
            .call_blocking(move |index| fold_chunks::write(index, &key, &payload, now_ms))
    }

    pub fn forget_fold_chunk(&self, key: &ChunkKey) -> Result<(), StorageError> {
        let key = key.clone();
        self.index
            .call_blocking(move |index| fold_chunks::delete(index, &key))
    }

    /// Drops the rows written before `cutoff_ms` ([`fold_chunks::prune_older_than`]).
    pub fn prune_fold_chunks(&self, cutoff_ms: i64) -> Result<usize, StorageError> {
        self.index
            .call_blocking(move |index| fold_chunks::prune_older_than(index, cutoff_ms))
    }
}
