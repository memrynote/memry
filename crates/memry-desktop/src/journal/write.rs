//! A day made on its first write, and a day deleted.
//!
//! **Create** (`createJournalEntry`, `journal/create-entry.ts`), in the day's write order and
//! under the rows' lane, the order of 13f's note create (`notes::create`):
//! 1. the record: the day opened with the tags and properties, or the live day as it is
//!    ([`Journal::open_with`]), so the file says what the record holds;
//! 2. the row, with no hash yet, so the watcher's report of the file is a change of the day;
//! 3. the file Electron writes (`date`, then `tags`, then the properties at the top level), told
//!    to the own-write record first, never replacing a file that appeared meanwhile;
//! 4. the body seeded from the file, the row's hashes, then the `Added` fact.
//!
//! A day that has a file already, by its row or at its path, is never written over: the create
//! answers it as a read does. Where the file's text comes from:
//! - a new day: the caller's, which seeds the empty body;
//! - a deleted day opened again: the caller's, which replaces the body the day was deleted
//!   with, kept as a version first (`ExternalFeed::feed_app_edit`), so file and body agree. A
//!   body that does not take it fails the create, which deletes the day again. Known gap: a
//!   crash after the revive and before the feed leaves a live day holding the deleted body and
//!   no file, and the next create writes that body to the file, as for a synced day;
//! - a live day with no file (one another device made): its own body, which the document
//!   holds; the caller's text goes only into an empty one. A body that is not here yet or that
//!   the file would not hold whole fails the create, and nothing is written.
//!
//! A failure takes back what this call made: its file, the record when this call opened it (a
//! tombstone, as a note create's), and the row. A crash between 1 and 2 leaves a live day with
//! no file, whose next create writes it; between 2 and 3, a row with no hash and no file, which
//! the next create finishes; between 3 and 4, a file whose text seeds the empty body at the
//! next open walk.
//!
//! **Delete** (`journal:deleteEntry`): the file first, for good when the day's document took
//! its bytes and to the trash otherwise (13f's delete), then the tombstone, then the row. A
//! file at the day's path that no row names (one the identity left unclaimed) is the one the
//! page shows: it goes to the trash, told to the own-write record first.
//!
//! Not here yet: the task links Electron's delete takes off the day (`unlinkTasksFromDeletedNote`
//! through `updateTask`, Step 21).

use std::path::Path;

use memry_core::api::journal::Journal;
use memry_core::domain::journal::valid_date;
use memry_core::domain::journal_ops::metadata::OpenedWith;
use memry_core::domain::journal_ops::reads::DayStamp;
use memry_core::domain::write_back::BodyRead;
use memry_core::markdown::convert::note_body::NoteBody;
use memry_core::markdown::frontmatter::{
    YamlError, YamlMap, YamlValue, json_to_yaml, write_markdown_note,
};
use memry_core::markdown::shared::writing_tools::merge_writing_yaml;
use serde_json::{Map, Value};

use super::{JournalEntryView, SCOPE, day_path, entry, is_reserved_day_key, view_of};
use crate::notes::create::{Seed, remove_file, remove_row};
use crate::notes::error::NotesError;
use crate::notes::frontmatter::is_reserved_key;
use crate::notes::service::NotesService;
use crate::session::OpenVault;
use crate::vault::config::settings::day_names;
use crate::vault::consumer::rows::{Lane, RowStat};
use crate::vault::consumer::{Applied, ChangeSource, converter_for};
use crate::vault::embeds::Resolved;
use crate::vault::file_types::FileType;
use crate::vault::hash::content_hash;
use crate::vault::note_file::{NoteFileError, write_new_text};
use crate::vault::paths::open_vault_file;

/// What `journal:createEntry` is asked to make (`CreateEntryInputSchema`).
#[derive(Debug, Clone, Default)]
pub struct NewDay {
    /// `YYYY-MM-DD`
    pub date: String,
    pub content: String,
    pub tags: Vec<String>,
    pub properties: Map<String, Value>,
}

impl NotesService {
    pub fn create_day(
        &self,
        open: &OpenVault,
        day: NewDay,
    ) -> Result<JournalEntryView, NotesError> {
        self.create_day_checked(open, day, &mut || Ok(()))
    }

    /// [`Self::create_day`] with a hook that runs once the file landed and before its body is
    /// seeded, so a test can fail the step after it.
    #[doc(hidden)]
    pub fn create_day_checked(
        &self,
        open: &OpenVault,
        day: NewDay,
        after_file: &mut dyn FnMut() -> Result<(), NotesError>,
    ) -> Result<JournalEntryView, NotesError> {
        let date = valid_date(&day.date)?.to_owned();
        self.order.run(&order_key(&date), |_| {
            self.create_day_now(open, &date, day, after_file)
        })
    }

    pub(super) fn create_day_now(
        &self,
        open: &OpenVault,
        date: &str,
        day: NewDay,
        after_file: &mut dyn FnMut() -> Result<(), NotesError>,
    ) -> Result<JournalEntryView, NotesError> {
        // The file is named in the format a change in progress saves (`vault::config::settings`).
        let _format = day_names();
        let root = open.path.as_path();
        let rows = self.tier.rows();
        let session = rows.session_for(&open.vault)?;
        let journal = open.vault.journal(self.store.clone())?;
        let feed = open.vault.external_feed(self.store.clone())?;
        let mut lane = rows.lane_of(session)?;
        let existing = |lane| {
            drop(lane);
            answer(open, &journal, date)
        };
        let rel = match journal.stamp(date)? {
            Some(DayStamp {
                id,
                path: Some(path),
                ..
            }) => {
                // A create that stopped between its row and its file left a row no text was
                // read into and no file: this create finishes it.
                let unfinished = lane
                    .files()
                    .by_id(&id)?
                    .is_some_and(|row| row.content_hash.is_none())
                    && open_vault_file(root, &path)?.is_none();
                if !unfinished {
                    return existing(lane);
                }
                path
            }
            _ => {
                let rel = day_path(root, date)?;
                // Another note's or day's file stands at the path.
                if lane.row_at(&rel)?.is_some() {
                    return Err(NotesError::NameConflict);
                }
                rel
            }
        };
        let mut properties = day.properties;
        properties
            .retain(|name, value| !is_reserved_day_key(name) && !is_reserved_key(name, value));
        let opened = journal.open_with(date, &day.tags, &properties)?;
        let take_back_record = || {
            if opened.opened {
                undo_record(&journal, date);
            }
        };
        // Fails only for a live day, which this call did not open.
        let text = text_of(self, open, &opened, &rel)?;
        let mut frontmatter = day_frontmatter(date, &opened.tags, &opened.properties);
        let content = match &text {
            Text::Held(body) => {
                merge_writing_yaml(&mut frontmatter, &body.writing);
                body.markdown.as_str()
            }
            // `serializeJournalEntry` writes the trimmed text.
            Text::Given | Text::OverDeleted => day
                .content
                .trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}'),
        };
        let output = day_file(&frontmatter, content)?;
        let hash = content_hash(&output);
        let unseeded = RowStat {
            file_type: FileType::Markdown,
            size: 0,
            content_hash: None,
            file_hash: None,
        };
        if let Err(error) = lane.put(&opened.id, &rel, unseeded) {
            take_back_record();
            return Err(error.into());
        }
        let echo = self.tier.echo();
        echo.will_write(&rel, &hash);
        if let Err(error) = write_new_text(root, &rel, &output) {
            echo.cancel_write(&rel);
            take_back_record();
            remove_row(&mut lane, &opened.id);
            return match error {
                // A file that appeared meanwhile is the day's: the identity takes it.
                NoteFileError::AlreadyExists => existing(lane),
                error => Err(error.into()),
            };
        }
        // The user's text, or none: a held text is another device's, and the first save over it
        // keeps it as a version.
        let users = !matches!(text, Text::Held(_));
        let seeded = after_file().and_then(|()| {
            let seed = Seed {
                root,
                open,
                id: &opened.id,
                rel: &rel,
                raw: &output,
            };
            match text {
                Text::Given => seed.run(self, &feed),
                // No file was read: the deleted body is not the text the user saw. A body that
                // keeps the deleted text (the file's text too large, refused, or owed) takes the
                // day back.
                Text::OverDeleted => seed.replace(self, &feed, "").and_then(|replaced| {
                    replaced.then_some(true).ok_or_else(|| {
                        NotesError::DayTextUnwritable(
                            "the deleted day's text could not be replaced".to_owned(),
                        )
                    })
                }),
                Text::Held(_) => Ok(true),
            }
        });
        let take_back = |lane: &mut _, error: NotesError| {
            remove_file(&echo, root, &rel);
            take_back_record();
            remove_row(lane, &opened.id);
            Err(error)
        };
        let holds_text = match seeded {
            Ok(holds_text) => holds_text,
            Err(error) => return take_back(&mut lane, error),
        };
        let stat = RowStat {
            file_type: FileType::Markdown,
            size: output.len() as u64,
            content_hash: holds_text.then(|| hash.clone()),
            file_hash: Some(hash.clone()),
        };
        if let Err(error) = lane.put(&opened.id, &rel, stat) {
            return take_back(&mut lane, error.into());
        }
        // The tags the new file says: what an outside edit of it is read against (#3825).
        let seen = open
            .vault
            .notes_writer(self.store.clone())
            .map_err(|error| error.to_string())
            .and_then(|writer| {
                (writer.file_tags_seen(&opened.id, &opened.tags)).map_err(|error| error.to_string())
            });
        if let Err(error) = seen {
            tracing::warn!(
                scope = SCOPE,
                note_id = opened.id,
                "a new day file's tags were not kept: {error}"
            );
        }
        if users {
            // The day's first save replaces this file with no version of it.
            self.own_files.wrote(&opened.id, &hash, ChangeSource::App);
        }
        lane.publish(Applied::Added {
            note_id: opened.id.clone(),
            path: rel.clone(),
            created: opened.opened,
            source: ChangeSource::App,
        });
        lane.publish(Applied::Changed {
            note_id: opened.id.clone(),
            path: rel,
            content_hash: holds_text.then_some(hash),
            source: ChangeSource::App,
        });
        drop(lane);
        // The day is made: the answer comes from the bytes written, as a read of them answers.
        Ok(view_of(date, &output, journal.stamp(date)?.as_ref()))
    }

    /// Deletes the day's entry; `false` when it has none.
    pub fn delete_day(&self, open: &OpenVault, date: &str) -> Result<bool, NotesError> {
        let date = valid_date(date)?;
        self.order
            .run(&order_key(date), |_| self.delete_day_now(open, date))
    }

    fn delete_day_now(&self, open: &OpenVault, date: &str) -> Result<bool, NotesError> {
        let rows = self.tier.rows();
        let session = rows.session_for(&open.vault)?;
        let journal = open.vault.journal(self.store.clone())?;
        let mut lane = rows.lane_of(session)?;
        let stamp = journal.stamp(date)?;
        let row = match &stamp {
            Some(stamp) => lane.files().by_id(&stamp.id)?,
            None => None,
        };
        let trashed = match &row {
            // Electron unlinks a day's file for good; one holding text the day never took goes
            // to the trash first.
            Some(row) => {
                self.remove_file_of(&open.path, row, true)?;
                false
            }
            None => self.trash_unnamed(&lane, &open.path, date)?,
        };
        let Some(stamp) = stamp else {
            return Ok(trashed);
        };
        journal.delete_day(date.to_owned())?;
        if let Some(row) = row {
            lane.remove(&stamp.id)?;
            lane.publish(Applied::Removed {
                note_id: stamp.id,
                path: row.path,
                source: ChangeSource::App,
            });
        }
        Ok(true)
    }

    /// Moves the file at the day's path to the trash when no row names it; `false` when there
    /// is none, or a note's row holds it.
    fn trash_unnamed(&self, lane: &Lane<'_>, root: &Path, date: &str) -> Result<bool, NotesError> {
        // A config that makes no path for the day names no file either.
        let Ok(rel) = day_path(root, date) else {
            return Ok(false);
        };
        if lane.row_at(&rel)?.is_some() || open_vault_file(root, &rel)?.is_none() {
            return Ok(false);
        }
        self.trash_file(&self.tier.echo(), root, &rel)?;
        Ok(true)
    }
}

/// Where a new day file's text comes from (the module docs).
enum Text {
    Given,
    OverDeleted,
    Held(NoteBody),
}

/// The text source of the day `opened`, whose file goes at `rel`.
fn text_of(
    service: &NotesService,
    open: &OpenVault,
    opened: &OpenedWith,
    rel: &str,
) -> Result<Text, NotesError> {
    if opened.revived {
        return Ok(Text::OverDeleted);
    }
    if opened.opened {
        return Ok(Text::Given);
    }
    let settings = open.vault.app_settings(service.store.clone()).ok();
    let embeds = Resolved::of_markdown(&open.path, &open.vault.note_files(), "", rel);
    let read = open.vault.write_back().body(
        &converter_for(settings.as_ref()),
        &opened.id,
        rel,
        "",
        &embeds,
    )?;
    let why = match read {
        BodyRead::Body(body) if body.markdown.trim().is_empty() => return Ok(Text::Given),
        BodyRead::Body(body) => return Ok(Text::Held(body)),
        BodyRead::NoNote => "the day is gone".to_owned(),
        BodyRead::FileAhead => "the day owes a file's text".to_owned(),
        BodyRead::BodyNotPulled => "the day's text has not arrived from sync".to_owned(),
        BodyRead::NotRepresentable(_) => "the file would not hold all of the day".to_owned(),
        BodyRead::Failed(reason) => reason.to_owned(),
    };
    Err(NotesError::DayTextUnwritable(why))
}

/// The day as a read of it answers, for a create that found it made.
pub(super) fn answer(
    open: &OpenVault,
    journal: &Journal,
    date: &str,
) -> Result<JournalEntryView, NotesError> {
    entry(open, journal, date)?.ok_or_else(|| NotesError::NotFound(date.to_owned()))
}

/// Days are written in order by date: a day's record id is known only once it is opened.
pub(super) fn order_key(date: &str) -> String {
    format!("journal:{date}")
}

/// The frontmatter of a new day file (`createJournalFrontmatter` and `writePropertiesToRoot`):
/// `date`, `tags` when there are any, then the properties in their order.
fn day_frontmatter(date: &str, tags: &[String], properties: &Map<String, Value>) -> YamlMap {
    let mut map = YamlMap::new();
    map.insert("date".to_owned(), YamlValue::String(date.to_owned()));
    if !tags.is_empty() {
        let items = tags.iter().cloned().map(YamlValue::String).collect();
        map.insert("tags".to_owned(), YamlValue::seq(items));
    }
    for (name, value) in properties {
        map.insert(name.clone(), json_to_yaml(value));
    }
    map
}

/// The text `serializeJournalEntry` writes (`matter.stringify`): a note file's, except that a
/// day with no text ends with an empty line after the block.
fn day_file(frontmatter: &YamlMap, content: &str) -> Result<String, YamlError> {
    let mut output = write_markdown_note(frontmatter, content)?;
    if content.is_empty() {
        output.push('\n');
    }
    Ok(output)
}

/// Tombstones the day this create opened; it was queued, so peers get both.
fn undo_record(journal: &Journal, date: &str) {
    if let Err(error) = journal.delete_day(date.to_owned()) {
        tracing::error!(scope = SCOPE, date, "a failed create left its day: {error}");
    }
}
