//! The desktop's tag reads ([`tag_reads`]): the index's measure of each file beside the
//! records. Not on the FFI surface: iOS keeps no files.

use crate::api::errors::StorageError;
use crate::domain::note_list::NoteSort;
use crate::domain::note_stats::{self, FileTags};
use crate::domain::tag_admin;
use crate::domain::tag_reads::{self, TagCount, TagNotes};
use crate::domain::tag_rename::{self, Holder};
use crate::domain::tag_retag;
use crate::domain::tags::tag_key;

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

    /// The tags of the note or journal day `id` as the tag list counts them
    /// ([`tag_reads::of_note`]), `header` being its file's header tags as just read and
    /// `file_hash` the hash its [`Self::note_stats`] row last measured.
    pub fn note_tags(
        &self,
        id: &str,
        header: Vec<String>,
        file_hash: Option<String>,
    ) -> Result<Option<Vec<String>>, StorageError> {
        let file = FileTags {
            header_tags: header,
            word_count: 0,
            file_hash,
        };
        let id = id.to_owned();
        self.data
            .read_blocking(move |data| tag_reads::of_note(data, &id, file))
    }

    /// The live notes and journal days a rename of `old` reaches ([`tag_rename::holders`]).
    pub fn tag_rename_holders(&self, old: &str) -> Result<Vec<Holder>, StorageError> {
        let files = self.index.read_blocking(note_stats::file_tags)?;
        let headers = files.into_iter().map(|(id, file)| (id, file.header_tags));
        let old = old.to_owned();
        self.data
            .read_blocking(move |data| tag_rename::holders(data, headers, &old))
    }

    /// The live notes and journal days a merge or delete of `tag` edits
    /// ([`tag_retag::holders_of`]).
    pub fn tag_holders(&self, tag: &str) -> Result<Vec<Holder>, StorageError> {
        let files = self.index.read_blocking(note_stats::file_tags)?;
        let headers = files.into_iter().map(|(id, file)| (id, file.header_tags));
        let tag = tag.to_owned();
        self.data
            .read_blocking(move |data| tag_retag::holders_of(data, headers, &tag))
    }

    /// The colour each of `tags` was given, `None` for a tag with no definition. Looked up by
    /// key, so `Work` finds the definition of `work`.
    pub fn tag_colors(&self, tags: Vec<String>) -> Result<Vec<Option<String>>, StorageError> {
        self.data.read_blocking(move |data| {
            let definitions = tag_admin::definitions(data)?;
            Ok(tags
                .iter()
                .map(|tag| definitions.get(&tag_key(tag)).map(|d| d.color.clone()))
                .collect())
        })
    }
}
