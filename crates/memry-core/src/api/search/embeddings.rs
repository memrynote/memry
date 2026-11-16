//! Desktop's note vectors in `index.db` ([`note_embeddings`]). Not on the FFI surface.

use crate::api::errors::StorageError;
use crate::domain::note_embeddings::{self, EmbeddableNote};

use super::Search;

impl Search {
    /// Every live markdown note and every file with text read out of it, in path order, with
    /// the hash its vectors must record ([`note_embeddings::with_file_text`]).
    pub fn embeddable_notes(&self) -> Result<Vec<EmbeddableNote>, StorageError> {
        let notes = self.data.read_blocking(note_embeddings::candidates)?;
        self.index
            .read_blocking(move |index| note_embeddings::with_file_text(index, notes))
    }

    /// The note `note_id` if it is embeddable ([`Self::embeddable_notes`] for one note).
    pub fn embeddable_note(&self, note_id: &str) -> Result<Option<EmbeddableNote>, StorageError> {
        let note_id = note_id.to_owned();
        let Some(note) = self
            .data
            .read_blocking(move |data| note_embeddings::candidate(data, &note_id))?
        else {
            return Ok(None);
        };
        self.index
            .read_blocking(move |index| note_embeddings::with_note_file_text(index, note))
    }

    /// How many notes have a head vector ([`note_embeddings::count`]).
    pub fn note_embedding_count(&self) -> Result<u64, StorageError> {
        self.index.read_blocking(note_embeddings::count)
    }

    pub fn mark_embedding_dirty(&self, note_id: &str) -> Result<(), StorageError> {
        let note_id = note_id.to_owned();
        self.index
            .call_blocking(move |index| note_embeddings::mark_dirty(index, &note_id))
    }

    /// The note's vectors, recorded as built from the input `read_hash` names
    /// ([`note_embeddings::embedded_hash`]) and the note's title ([`note_embeddings::store`]).
    pub fn store_note_embeddings(
        &self,
        note: &EmbeddableNote,
        read_hash: Option<&str>,
        windows: Vec<Vec<f32>>,
        similar: Vec<f32>,
    ) -> Result<(), StorageError> {
        let (note_id, hash, title) = (
            note.note_id.clone(),
            read_hash.map(str::to_owned),
            note.title.clone(),
        );
        self.index.call_blocking(move |index| {
            note_embeddings::store(index, &note_id, hash.as_deref(), &title, &windows, &similar)
        })
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

    /// Drops the vectors of notes that are not embeddable: gone, or a file with no text read
    /// out of it. Holds the index writer while it reads the live notes, so a note embedded
    /// meanwhile keeps its vectors.
    pub fn prune_note_embeddings(&self) -> Result<usize, StorageError> {
        let data = self.data.clone();
        self.index.call_blocking(move |index| {
            let notes = data.read_blocking(note_embeddings::candidates)?;
            note_embeddings::prune(index, notes)
        })
    }

    /// The live notes owed a vector, those with none first ([`note_embeddings::owed`]).
    pub fn owed_note_embeddings(&self) -> Result<Vec<EmbeddableNote>, StorageError> {
        let notes = self.embeddable_notes()?;
        self.index
            .read_blocking(move |index| note_embeddings::owed(index, notes))
    }
}
