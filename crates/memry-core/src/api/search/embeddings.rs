//! Desktop's note vectors in `index.db` ([`note_embeddings`]). Not on the FFI surface.

use crate::api::errors::StorageError;
use crate::domain::note_embeddings::{self, EmbeddableNote};

use super::Search;

impl Search {
    /// Every live markdown note, in path order ([`note_embeddings::embeddable`]).
    pub fn embeddable_notes(&self) -> Result<Vec<EmbeddableNote>, StorageError> {
        self.data.read_blocking(note_embeddings::embeddable)
    }

    /// The live markdown note `note_id` ([`note_embeddings::embeddable_note`]).
    pub fn embeddable_note(&self, note_id: &str) -> Result<Option<EmbeddableNote>, StorageError> {
        let note_id = note_id.to_owned();
        self.data
            .read_blocking(move |data| note_embeddings::embeddable_note(data, &note_id))
    }

    pub fn mark_embedding_dirty(&self, note_id: &str) -> Result<(), StorageError> {
        let note_id = note_id.to_owned();
        self.index
            .call_blocking(move |index| note_embeddings::mark_dirty(index, &note_id))
    }

    pub fn store_note_embeddings(
        &self,
        note_id: &str,
        windows: Vec<Vec<f32>>,
        similar: Vec<f32>,
    ) -> Result<(), StorageError> {
        let note_id = note_id.to_owned();
        self.index
            .call_blocking(move |index| note_embeddings::store(index, &note_id, &windows, &similar))
    }

    pub fn delete_note_embedding(&self, note_id: &str) -> Result<(), StorageError> {
        let note_id = note_id.to_owned();
        self.index
            .call_blocking(move |index| note_embeddings::delete(index, &note_id))
    }

    pub fn clear_note_embeddings(&self) -> Result<(), StorageError> {
        self.index
            .call_blocking(|index| note_embeddings::clear(index))
    }

    /// Drops the vectors of notes with no markdown file row. Holds the index writer while it
    /// reads the live notes, so a note embedded meanwhile keeps its vectors.
    pub fn prune_note_embeddings(&self) -> Result<usize, StorageError> {
        let data = self.data.clone();
        self.index.call_blocking(move |index| {
            let live = data.read_blocking(|data| {
                note_embeddings::embeddable(data)
                    .map(|notes| notes.into_iter().map(|note| note.note_id).collect())
            })?;
            note_embeddings::prune(index, &live)
        })
    }

    /// The live notes owed a vector, those with none first ([`note_embeddings::owed`]).
    pub fn owed_note_embeddings(&self) -> Result<Vec<EmbeddableNote>, StorageError> {
        let notes = self.embeddable_notes()?;
        self.index
            .read_blocking(move |index| note_embeddings::owed(index, notes))
    }
}
