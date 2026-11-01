//! The desktop's tag reads ([`tag_reads`]): the index's measure of each file beside the
//! records. Not on the FFI surface: iOS keeps no files.

use crate::api::errors::StorageError;
use crate::domain::note_list::NoteSort;
use crate::domain::note_stats;
use crate::domain::tag_reads::{self, TagCount, TagNotes};

use super::Search;

impl Search {
    /// Every tag with its count ([`tag_reads::counts`]).
    pub fn tag_counts(&self) -> Result<Vec<TagCount>, StorageError> {
        let files = self.index.read_blocking(note_stats::file_tags)?;
        self.data
            .read_blocking(move |data| tag_reads::counts(data, &files))
    }

    /// The colour of `tag` and the notes and journal days carrying it ([`tag_reads::tagged`]).
    pub fn tagged_notes(
        &self,
        tag: &str,
        descendants: bool,
        sort: NoteSort,
        ascending: bool,
    ) -> Result<TagNotes, StorageError> {
        let files = self.index.read_blocking(note_stats::file_tags)?;
        let tag = tag.to_owned();
        self.data.read_blocking(move |data| {
            tag_reads::tagged(data, &files, &tag, descendants, sort, ascending)
        })
    }
}
