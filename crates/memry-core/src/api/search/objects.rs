//! The reads behind objects, the notes a tag with fields makes into records of a kind
//! (`queries/tag-objects.ts`, `tag-schema-counts.ts`). Not on the FFI surface: iOS keeps no
//! files.

use std::collections::HashSet;

use crate::api::errors::StorageError;
use crate::domain::note_stats;
use crate::domain::notes::failed;

use super::Search;

impl Search {
    /// Every markdown note that is not a journal day, with its file's header tags in their
    /// order (Electron's `note_tags` rows with `in_header`, `objectRow`). A note's header is
    /// what makes it an object of a tag, never a body `#tag`.
    pub fn object_headers(&self) -> Result<Vec<(String, Vec<String>)>, StorageError> {
        let headers = self.index.read_blocking(note_stats::undated_header_tags)?;
        let markdown: HashSet<String> = self.data.read_blocking(|data| {
            let mut statement = data
                .prepare("SELECT note_id FROM note_files WHERE file_type = 'markdown'")
                .map_err(failed)?;
            let ids = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(failed)?
                .collect::<Result<HashSet<_>, _>>()
                .map_err(failed)?;
            Ok(ids)
        })?;
        Ok(headers
            .into_iter()
            .filter(|(id, tags)| !tags.is_empty() && markdown.contains(id))
            .collect())
    }
}
