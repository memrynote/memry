//! What a vault file's frontmatter `tags` give its record: a found day's declared tags (13m-5),
//! and an outside edit's (#3825). The rules are the core's (`memry_core::domain::notes::file_tags`,
//! `journal_day`); this reads the file and the index.

use memry_core::api::notes_write::NotesWriter;
use memry_core::api::search::Search;
use memry_core::domain::note_stats::header_tags;
use memry_core::markdown::frontmatter::{YamlValue, gray_matter_data};

use super::SCOPE;
use crate::vault::consumer::identity::IdentityError;
use crate::vault::note_file::NoteFile;

/// A found day file declares `tags`: what an outside edit of it is read against. A failure
/// leaves the index's measure to stand in, and is logged.
pub(super) fn found(writer: &NotesWriter, id: &str, tags: &[String]) {
    if let Err(error) = writer.file_tags_seen(id, tags) {
        tracing::warn!(
            scope = SCOPE,
            note_id = id,
            "a found file's tags were not kept: {error}"
        );
    }
}

/// An edit outside the app replaced the note's file, whose hash was `previous`: a note's record
/// takes the file's list, a day's what the edit changed in it (`file_tags::taken`), against the
/// list kept for the day, else the index's measure of the replaced file when it read its
/// header. A frontmatter that does not parse, or is not a map, says nothing of the tags: the
/// record and the kept list stay as they were.
pub(super) fn edited(
    writer: &NotesWriter,
    search: &Search,
    note_id: &str,
    previous: &str,
    file: &NoteFile,
) -> Result<(), IdentityError> {
    let Some(after) = of_block(file.split().block) else {
        tracing::info!(
            scope = SCOPE,
            note_id,
            "an outside edit's frontmatter does not read as a map; the record keeps its tags"
        );
        return Ok(());
    };
    let before = search
        .note_stats(note_id)?
        .filter(|stored| stored.file_hash.as_deref() == Some(previous) && stored.stats.header_read)
        .map(|stored| stored.stats.header_tags);
    Ok(writer.file_tags_edited(note_id, before.as_deref(), &after)?)
}

/// The `tags` a frontmatter block declares: none without a block or in an empty one, and `None`
/// for a block that does not parse or is not a map, which says nothing of them.
pub(super) fn of_block(block: Option<&str>) -> Option<Vec<String>> {
    match block.map(gray_matter_data) {
        None | Some(Ok(YamlValue::Null)) => Some(Vec::new()),
        Some(Ok(YamlValue::Map(map))) => Some(header_tags(&map)),
        Some(_) => None,
    }
}
