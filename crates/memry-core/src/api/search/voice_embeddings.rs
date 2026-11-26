//! Desktop's voice memo vectors in `index.db` ([`voice_embeddings`]). Not on the FFI surface.

use crate::api::errors::StorageError;
use crate::domain::voice_embeddings::{self, VoiceEmbeddingState, VoiceItem, VoiceSource};

use super::Search;

impl Search {
    /// The live voice memos of `data.db`, or the one with `item_id`
    /// ([`voice_embeddings::items`]).
    pub fn voice_items(&self, item_id: Option<String>) -> Result<Vec<VoiceItem>, StorageError> {
        self.data
            .read_blocking(move |data| voice_embeddings::items(data, item_id.as_deref()))
    }

    pub fn voice_embedding_state(&self) -> Result<Vec<VoiceEmbeddingState>, StorageError> {
        self.index.read_blocking(voice_embeddings::state)
    }

    /// Every window of the memo replaced with `vectors`, computed from `source`.
    pub fn store_voice_embeddings(
        &self,
        item_id: String,
        source: VoiceSource,
        vectors: Vec<Vec<f32>>,
    ) -> Result<(), StorageError> {
        self.index.call_blocking(move |index| {
            voice_embeddings::replace(index, &item_id, source, &vectors)
        })
    }

    pub fn delete_voice_embeddings(&self, item_id: String) -> Result<(), StorageError> {
        self.index
            .call_blocking(move |index| voice_embeddings::delete(index, &item_id))
    }

    pub fn clear_voice_embeddings(&self) -> Result<(), StorageError> {
        self.index
            .call_blocking(|index| voice_embeddings::clear(index))
    }
}
