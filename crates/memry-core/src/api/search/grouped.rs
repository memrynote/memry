//! Desktop's palette reads over [`grouped`]: the grouped and quick searches, the counts, the
//! semantic leg's nearest notes and the result tags. Not on the FFI surface.

use rusqlite::params;

use crate::api::errors::StorageError;
use crate::domain::body_tags::ALL_NOTE_TAGS;
use crate::domain::search::grouped::{
    self, GroupedItem, GroupedQuery, GroupedResponse, GroupedStats, SemanticHit,
};

use super::Search;

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

impl Search {
    /// [`grouped::search_all`] over both databases.
    pub fn grouped(
        &self,
        query: &GroupedQuery,
        semantic: &[SemanticHit],
    ) -> Result<GroupedResponse, StorageError> {
        let index = self.index.clone();
        self.data.read_blocking(move |data| {
            index.read_blocking(|index| Ok(grouped::search_all(data, index, query, semantic)))
        })
    }

    /// [`grouped::quick_search`] over both databases.
    pub fn grouped_quick(
        &self,
        text: &str,
        note_file_types: &[String],
        semantic: &[SemanticHit],
    ) -> Result<Vec<GroupedItem>, StorageError> {
        let index = self.index.clone();
        self.data.read_blocking(move |data| {
            index.read_blocking(|index| {
                Ok(grouped::quick_search(
                    data,
                    index,
                    text,
                    note_file_types,
                    semantic,
                ))
            })
        })
    }

    /// [`grouped::stats`].
    pub fn grouped_stats(&self) -> Result<GroupedStats, StorageError> {
        self.data.read_blocking(grouped::stats)
    }

    /// [`grouped::semantic::note_hits`]: the notes whose vectors lie nearest `query`, their
    /// images' vectors included when `images` is on.
    pub fn semantic_note_hits(
        &self,
        query: &[f32],
        images: bool,
    ) -> Result<Vec<SemanticHit>, StorageError> {
        self.index
            .read_blocking(move |index| Ok(grouped::semantic::note_hits(index, query, images)))
    }

    /// The `(id, tag)` rows of the notes and journal days among `ids`, by id then tag.
    pub fn result_tags(&self, ids: &[&str]) -> Result<Vec<(String, String)>, StorageError> {
        let ids = serde_json::to_string(ids).map_err(|error| StorageError::Failed {
            what: error.to_string(),
        })?;
        self.data.read_blocking(move |data| {
            let mut statement = data
                .prepare(&format!(
                    "SELECT t.note_id, t.tag FROM {ALL_NOTE_TAGS} t
                     WHERE t.note_id IN (SELECT value FROM json_each(?1))
                     ORDER BY t.note_id, t.tag"
                ))
                .map_err(failed)?;
            statement
                .query_map(params![ids], |row| Ok((row.get(0)?, row.get(1)?)))
                .map_err(failed)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(failed)
        })
    }
}
