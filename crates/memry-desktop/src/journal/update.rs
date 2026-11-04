//! A day edited in the app (`journal:updateEntry`, `journal/update-entry.ts`): the editor's
//! save of its text, its tags, its properties.
//!
//! In the day's write order (by date, as its create and delete), then:
//! - a day with no file is made by its first write ([`NotesService::create_day`]'s steps), as
//!   Electron's update creates a missing entry. When a live record had no file yet (another
//!   device's day), the file is made from what it holds, and the whole update then goes over
//!   it as a save: the user's text (keeping a held text it replaces as a version), tags and
//!   properties;
//! - a live day's file is edited through the app-edit seam's editor save
//!   ([`Precondition::Save`]), inside the day's own turn (its record id, the turn every other
//!   app edit of the day takes; the date's turn is always taken first): its body when the text
//!   changed (trimmed, as `serializeJournalEntry` writes it) with `date` set in place as the
//!   write-back sets it, and its properties at the top level when the update names them, every
//!   other key keeping its lines. A new body follows the block with one line end, as
//!   `joinBlockAndBody` writes it; a body equal once trimmed keeps its bytes. The seam feeds
//!   the body to the day's document, keeps a file the run did not write (an outside edit, fed
//!   or not) as a version first, and never puts the file's old body over a document that is
//!   ahead when only the properties change. The fact goes out as [`ChangeSource::App`]: the
//!   command sends `journal:entryUpdated` itself, and Electron sends no `notes:updated` for a
//!   day;
//! - the record, once the file holds the edit (the seam's `landed`, under the lane and before
//!   the fact; a refused write leaves it, and a day deleted meanwhile stays deleted): its tags
//!   when they changed (the file's `tags:` are the author's bytes, never written: decision on
//!   #3530), and the property keys the file edit set or dropped (`file_delta`, as the property
//!   panel's writer mirrors them). Every other key keeps the record's value: one a pull brought
//!   in is not in the file yet (13k-4). A tags-only update writes the record alone.
//!
//! A day's tags are the given list, or the record's, with the `#tags` typed into or deleted
//! from the body applied on top (`inlineTags`): a plain tag joins or leaves the list, a tag
//! with fields stays a mention (`applyInlineTagEdit`).
//!
//! Refused, with nothing changed: a file past the size the page reads whole, before or after
//! the edit; a file the seam keeps (a frontmatter that does not parse, a file that changed
//! during the write); properties for a file whose frontmatter is not a map; a file at the
//! day's path the day does not hold (no live day, or no row), which the identity takes in
//! first.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::sync::PoisonError;

use memry_core::domain::header_tags::{self, EditSource, Existing, HeaderTagEdit, Update};
use memry_core::domain::journal::valid_date;
use memry_core::markdown::frontmatter::{
    Eol, ParsedMarkdownNote, YamlMap, YamlValue, json_to_yaml, parse_markdown_note,
    serialize_parsed_markdown_note, serialize_updated_note,
};
use memry_core::markdown::shared::markdown_class::MarkdownClassThresholds;
use serde_json::{Map, Value};

use super::write::{NewDay, answer, order_key};
use super::{JournalEntryView, RESERVED_KEYS, SCOPE, entry};
use crate::notes::error::NotesError;
use crate::notes::frontmatter::{is_reserved_yaml, user_properties};
use crate::notes::properties::file_delta;
use crate::notes::service::NotesService;
use crate::session::OpenVault;
use crate::vault::app_edit::{AppEdit, Edited, Kept, Precondition};
use crate::vault::consumer::ChangeSource;
use crate::vault::writeback::journal::{Dated, dated_block, set_date};
use memry_core::api::journal::Journal;

/// What `journal:updateEntry` is asked to change (`UpdateEntryInputSchema`); `None` leaves it.
#[derive(Debug, Clone, Default)]
pub struct DayUpdate {
    /// `YYYY-MM-DD`
    pub date: String,
    pub content: Option<String>,
    pub tags: Option<Vec<String>>,
    pub inline_tags: Option<InlineTags>,
    pub properties: Option<Map<String, Value>>,
}

/// What an update came to.
#[derive(Debug, Clone, PartialEq)]
pub struct DayUpdated {
    pub entry: JournalEntryView,
    /// The day had no file, and the update made it (`journal:entryCreated`, not `Updated`).
    pub created: bool,
}

/// The `#tags` typed into or deleted from the body.
#[derive(Debug, Clone, Default)]
pub struct InlineTags {
    pub add: Vec<String>,
    pub remove: Vec<String>,
}

impl NotesService {
    pub fn update_day(
        &self,
        open: &OpenVault,
        update: DayUpdate,
    ) -> Result<DayUpdated, NotesError> {
        let date = valid_date(&update.date)?.to_owned();
        self.order.run(&order_key(&date), |_| {
            self.update_day_now(open, &date, update)
        })
    }

    fn update_day_now(
        &self,
        open: &OpenVault,
        date: &str,
        update: DayUpdate,
    ) -> Result<DayUpdated, NotesError> {
        let journal = open.vault.journal(self.store.clone())?;
        let Some(existing) = entry(open, &journal, date)? else {
            // A live record with no file (made on another device) keeps its own fields and text
            // through the create; the update then goes over them as a save.
            let held = journal.stamp(date)?.is_some();
            let day = NewDay {
                date: date.to_owned(),
                content: update.content.clone().unwrap_or_default(),
                tags: next_tags(open, &[], &update)?,
                properties: update.properties.clone().unwrap_or_default(),
            };
            let made = self.create_day_now(open, date, day, &mut || Ok(()))?;
            // A held text the user's differs from is kept as a version by that save.
            let entry = match held {
                true => self.save_day(open, &journal, date, &made.tags, update)?,
                false => made,
            };
            return Ok(DayUpdated {
                entry,
                created: true,
            });
        };
        Ok(DayUpdated {
            entry: self.save_day(open, &journal, date, &existing.tags, update)?,
            created: false,
        })
    }

    /// The update of a day whose file is there; `current` are the record's tags.
    fn save_day(
        &self,
        open: &OpenVault,
        journal: &Journal,
        date: &str,
        current: &[String],
        update: DayUpdate,
    ) -> Result<JournalEntryView, NotesError> {
        let unheld = || NotesError::DayTextUnwritable("the file is not the day's yet".to_owned());
        let stamp = journal.stamp(date)?.ok_or_else(unheld)?;
        if stamp.path.is_none() {
            return Err(unheld());
        }
        let tags = next_tags(open, current, &update)?;
        let tags_changed = header_tags::compare(current, &tags).is_some();
        let mirror_tags = || -> Result<(), NotesError> {
            if tags_changed {
                journal.set_live_tags(date, &tags)?;
            }
            Ok(())
        };
        if update.content.is_none() && update.properties.is_none() {
            mirror_tags()?;
            return answer(open, journal, date);
        }
        let properties = update.properties.as_ref().map(|given| {
            let given = given.iter().fold(YamlMap::new(), |mut map, (name, value)| {
                map.insert(name.clone(), json_to_yaml(value));
                map
            });
            (user_properties(&given), self.definition_types(open))
        });
        let change = FileChange {
            date,
            content: update.content.as_deref(),
            properties: properties.as_ref(),
            mirrored: RefCell::new(None),
        };
        let writer = open.vault.notes_writer(self.store.clone())?;
        // The record's tags and the property keys the edit set or dropped, once the file holds
        // it. Not `set_properties`: it takes the day's turn, which this save holds.
        let landed = || -> Result<bool, NotesError> {
            mirror_tags()?;
            if let Some((changed, removed)) = change.mirrored.take()
                && !writer.file_properties(&stamp.id, changed, removed)?
            {
                tracing::warn!(
                    scope = SCOPE,
                    date,
                    "a day's file took a property edit its record could not: no record"
                );
            }
            Ok(false)
        };
        let edit = AppEdit::new(&self.tier, &self.store, open)?;
        let edited = self.order.run(&stamp.id, |turn| {
            let save = Precondition::Save(&self.own_files);
            let text = |read: &str| change.text(read);
            let mut between = || {
                let hook = self
                    .day_file_lands
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .take();
                if let Some(hook) = hook {
                    hook();
                }
            };
            edit.run_then(turn, save, ChangeSource::App, text, landed, &mut between)
        })?;
        if let Edited::Kept(kept) = edited {
            return Err(NotesError::DayTextUnwritable(kept_reason(&kept).to_owned()));
        }
        answer(open, journal, date)
    }
}

/// `serializeJournalEntry` writes the text trimmed.
fn trimmed(content: &str) -> &str {
    content.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// The day's tags after `update`, from `current` (`givenTags` and `applyInlineTagEdit`).
fn next_tags(
    open: &OpenVault,
    current: &[String],
    update: &DayUpdate,
) -> Result<Vec<String>, NotesError> {
    let given = update.tags.as_deref().unwrap_or(current);
    let Some(inline) = &update.inline_tags else {
        return Ok(given.to_vec());
    };
    let with_fields: HashSet<String> = open.vault.tags_with_fields()?;
    let edit = HeaderTagEdit {
        add: inline.add.clone(),
        remove: inline.remove.clone(),
        source: Some(EditSource::Inline),
        ..HeaderTagEdit::default()
    };
    let existing = Existing {
        header_tags: given,
        content: "",
    };
    let update = Update {
        header_tags: Some(&edit),
        ignore_inline_tags: true,
        ..Update::default()
    };
    Ok(header_tags::next(&existing, &update, &with_fields))
}

/// The property keys an edit set, and the ones it dropped.
type Delta = (Map<String, Value>, Vec<String>);

/// The file text an update makes.
struct FileChange<'a> {
    date: &'a str,
    content: Option<&'a str>,
    /// The given properties, and each defined property's type.
    properties: Option<&'a (YamlMap, HashMap<String, String>)>,
    /// What the record takes once the file holds the text ([`file_delta`]), set by [`Self::text`]
    /// when it changes the properties.
    mirrored: RefCell<Option<Delta>>,
}

impl FileChange<'_> {
    /// The day file `read` (no byte order mark) with this change, or `None` when it already
    /// says it.
    fn text(&self, read: &str) -> Result<Option<String>, NotesError> {
        let ceiling = MarkdownClassThresholds::default().max_file_bytes;
        if read.len() > ceiling {
            return Err(NotesError::TooLarge(ceiling));
        }
        let mut parsed = parse_markdown_note(read)?;
        // A body equal once trimmed keeps its bytes (`editJournalFile`).
        let body = self
            .content
            .map(trimmed)
            .filter(|content| *content != parsed.content.trim());
        let frontmatter = self.next_frontmatter(&parsed)?;
        let output = match (frontmatter, body) {
            (None, None) => return Ok(None),
            (frontmatter, Some(body)) => {
                // `joinBlockAndBody(block, body)`: the text and one line end, right after the
                // block, in the file's line ends.
                let eol = match parsed.eol {
                    Eol::Lf => "\n",
                    Eol::CrLf => "\r\n",
                };
                parsed.content = format!("{body}\n").replace("\r\n", "\n").replace('\n', eol);
                let body = parsed.content.clone();
                match frontmatter {
                    Some((reading, next)) => {
                        serialize_updated_note(parsed, &reading, next, &body, true)?
                    }
                    None => body_with_date(parsed, read, self.date, &body)?,
                }
            }
            (Some((reading, next)), None) => {
                let body = parsed.content.clone();
                serialize_updated_note(parsed, &reading, next, &body, true)?
            }
        };
        if output.len() > ceiling {
            return Err(NotesError::TooLarge(ceiling));
        }
        Ok((output != read).then_some(output))
    }

    /// The block's reading and its next keys when the update changes the file's properties:
    /// every key that is not a property keeps its place (the legacy nested envelope goes, as
    /// Electron flattens it), the given properties follow in their order, and `date` says the
    /// day. Sets what the record takes: the property keys the edit set or dropped, the day's
    /// own keys left out as a read leaves them out.
    fn next_frontmatter(
        &self,
        parsed: &ParsedMarkdownNote,
    ) -> Result<Option<(YamlMap, YamlMap)>, NotesError> {
        let Some((given, types)) = self.properties else {
            return Ok(None);
        };
        let YamlValue::Map(map) = &parsed.frontmatter else {
            if given.is_empty() {
                return Ok(None);
            }
            // A top level that is a list or a scalar is the author's; no key goes into it.
            return Err(NotesError::DayTextUnwritable(
                "the file's frontmatter is not a map".to_owned(),
            ));
        };
        let reading = (**map).clone();
        let mut next = YamlMap::new();
        for (name, value) in reading.iter() {
            let stays = name != "properties"
                && (RESERVED_KEYS.contains(&name) || is_reserved_yaml(name, value));
            if stays {
                next.insert(name.to_owned(), value.clone());
            }
        }
        for (name, value) in given.iter() {
            next.insert(name.to_owned(), value.clone());
        }
        set_date(&mut next, self.date);
        let (mut changed, mut removed) = file_delta(&reading, &next, types);
        changed.retain(|name, _| !RESERVED_KEYS.contains(&name.as_str()));
        removed.retain(|name| !RESERVED_KEYS.contains(&name.as_str()));
        if changed.is_empty() && removed.is_empty() {
            return Ok(None);
        }
        *self.mirrored.borrow_mut() = Some((changed, removed));
        Ok(Some((reading, next)))
    }
}

/// `parsed` with `body`, and its `date` set in place as the write-back sets it on a body write.
fn body_with_date(
    mut parsed: ParsedMarkdownNote,
    read: &str,
    date: &str,
    body: &str,
) -> Result<String, NotesError> {
    match dated_block(&parsed, read, date) {
        Dated::Says => {}
        Dated::Set(block) => parsed.raw_frontmatter_block = Some(block),
        Dated::NotInPlace(why) => tracing::warn!(
            scope = SCOPE,
            date,
            "a journal day's file is saved without the day's date: {why}"
        ),
    }
    Ok(serialize_parsed_markdown_note(&parsed, body, false)?)
}

/// What the user is told when the seam keeps the file.
fn kept_reason(kept: &Kept) -> &'static str {
    match kept {
        Kept::NoRow | Kept::NoFile | Kept::NotMarkdown | Kept::NoBody => {
            "the day's file is not there; try again"
        }
        Kept::NotRead | Kept::FileChanged | Kept::FileAhead => {
            "the day's file changed outside the app; try again once it is read"
        }
        Kept::BodyAhead => "the day holds an edit its file does not have yet; try again",
        Kept::BodyNotPulled => "the day's text has not arrived from sync",
        Kept::NotRepresentable => "the file would not hold all of the day",
        Kept::FrontmatterUnreadable | Kept::FrontmatterBroken => {
            "the day's frontmatter does not parse"
        }
    }
}
