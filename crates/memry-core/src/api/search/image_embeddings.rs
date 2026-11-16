//! Desktop's image vectors in `index.db` ([`image_embeddings`]). Not on the FFI surface.

use crate::api::errors::StorageError;
use crate::domain::image_embeddings::{self, Classify, ImageEmbeddingState, ImageSource};

use super::Search;

impl Search {
    /// The images and PDF pages of `note_ids` (or of every note) the vision encoder reads
    /// ([`image_embeddings::sources`]): the text jobs of `index.db` joined with the live note
    /// files of `data.db`.
    pub fn image_sources(
        &self,
        note_ids: Option<Vec<String>>,
        classify: Classify,
    ) -> Result<Vec<ImageSource>, StorageError> {
        let jobs = self
            .index
            .read_blocking(move |index| image_embeddings::jobs(index, note_ids.as_deref()))?;
        let mut ids: Vec<String> = jobs.iter().map(|job| job.note_id.clone()).collect();
        ids.dedup();
        let files = self
            .data
            .read_blocking(move |data| image_embeddings::note_files(data, &ids))?;
        Ok(image_embeddings::sources(jobs, &files, classify))
    }

    pub fn image_embedding_state(
        &self,
        note_ids: Option<Vec<String>>,
    ) -> Result<Vec<ImageEmbeddingState>, StorageError> {
        self.index
            .read_blocking(move |index| image_embeddings::state(index, note_ids.as_deref()))
    }

    pub fn store_image_embedding(
        &self,
        image: ImageSource,
        vector: Vec<f32>,
    ) -> Result<(), StorageError> {
        self.index
            .call_blocking(move |index| image_embeddings::store(index, &image, &vector))
    }

    /// The vectors and state rows of each `(note_id, source)`.
    pub fn delete_image_embeddings(
        &self,
        images: Vec<(String, String)>,
    ) -> Result<(), StorageError> {
        self.index
            .call_blocking(move |index| image_embeddings::delete(index, &images))
    }

    pub fn prune_image_embeddings(&self) -> Result<(), StorageError> {
        self.index
            .call_blocking(|index| image_embeddings::prune_orphans(index))
    }

    pub fn clear_image_embeddings(&self) -> Result<(), StorageError> {
        self.index
            .call_blocking(|index| image_embeddings::clear(index))
    }
}
