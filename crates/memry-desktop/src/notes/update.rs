//! A note edited in the app (`updateNote`, `vault/notes-crud.ts`, and `writeNoteCommand`,
//! `notes/domain.ts`): an editor save of its body, an edit of its header tags, its icon.
//!
//! In the note's write order, and under the rows' lane for the whole step, so no watcher fact
//! for its path is applied in between:
//! 1. the note's markdown file, read and parsed; a note with no live record or no file is not
//!    found;
//! 2. the next header tags ([`header_tags::next`]) against the file's: the `tags:` key is
//!    written only when [`header_tags::compare`] reports a change, so an unchanged list keeps
//!    the file's spelling, and every other key keeps its lines (`serialize_updated_note`);
//! 3. a new body, fed into the note's document with the body read in 1
//!    ([`ExternalFeed::feed_app_edit`]), so a save keeps no version of the text it replaces.
//!    A file this run's last update of the note did not write is kept as a version first: an
//!    outside edit, fed or not, that an editor which never showed it would save over (the
//!    write-back's rule for the files it replaces);
//! 4. the file, written over only while it is still the file read in 1 (`write_note_over`);
//! 5. the record's icon and, when the header changed, its tags (one outbox row each), only
//!    once the file holds them, so a refused write leaves the record as the file says;
//! 6. the row's hashes, then [`Applied::Changed`] with [`ChangeSource::Edit`].
//!
//! **Order against the watcher.** The feed comes before the write: an outside edit that lands
//! between 1 and 5 makes the write refuse, and the consumer, once the lane is free, feeds that
//! edit over the save, which its feed keeps as a version. The outside edit wins and the save
//! is not lost. The own-write record is told before the write only when the document holds
//! what is written, and the row then names it. When it does not (a feed answered `Owed`,
//! `LargeFile` or `Refused`, or a tag edit of a file whose outside edit is not fed yet), the
//! row is left as it was and the watcher reports the write, so the consumer brings the file to
//! the document as it does an outside edit.
//!
//! Not here, with their owners: the title (`notes:rename`), `frontmatter`, `properties` and
//! `propertyPatch` (13k), `aliases` (13i), the tag templates (13j, 13l), date reminders
//! (Step 21) and locks (Step 14).

use std::collections::HashSet;
use std::sync::PoisonError;

use memry_core::domain::body_tags;
use memry_core::domain::external_feed::{FeedInput, FeedOutcome};
use memry_core::domain::header_tags::{
    self, EditSource, Existing, HeaderTagEdit, HeaderTagRename, Update,
};
use memry_core::domain::note_stats::header_tags as file_header_tags;
use memry_core::domain::tags::fold;
use memry_core::markdown::frontmatter::{
    YamlMap, YamlValue, serialize_updated_note, split_frontmatter_block,
};
use memry_core::markdown::shared::writing_tools::writing_of_yaml;
use serde::{Deserialize, Deserializer};

use super::error::{NotesError, SCOPE};
use super::read;
use super::service::NotesService;
use super::view::NoteView;
use crate::session::OpenVault;
use crate::vault::consumer::rows::{RowStat, now_ms};
use crate::vault::consumer::{Applied, ChangeSource, converter_for};
use crate::vault::embeds::Resolved;
use crate::vault::file_types::FileType;
use crate::vault::hash::content_hash;
use crate::vault::note_file::{read_note, write_note_over_checked};

const BOM: char = '\u{feff}';
/// `HeaderTagEditSchema`: at most 50 names per list, each 1 to 50 UTF-16 units once trimmed.
const MAX_EDIT_TAGS: usize = 50;
const MAX_TAG_UNITS: usize = 50;

/// `NoteUpdateSchema`, the fields this step writes.
#[derive(Debug, Clone, Default, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteUpdateInput {
    pub id: String,
    #[serde(default)]
    #[specta(optional)]
    pub content: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub header_tags: Option<HeaderTagEditInput>,
    /// Absent leaves the icon; `null` clears it.
    #[serde(default, deserialize_with = "present")]
    #[specta(optional, type = Option<String>)]
    pub emoji: Option<Option<String>>,
}

/// `HeaderTagEditSchema`.
#[derive(Debug, Clone, Default, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HeaderTagEditInput {
    #[serde(default)]
    #[specta(optional)]
    pub add: Option<Vec<String>>,
    #[serde(default)]
    #[specta(optional)]
    pub remove: Option<Vec<String>>,
    #[serde(default)]
    #[specta(optional)]
    pub rename: Option<Vec<HeaderTagRenameInput>>,
    #[serde(default)]
    #[specta(optional)]
    pub source: Option<HeaderTagSource>,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct HeaderTagRenameInput {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Copy, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum HeaderTagSource {
    Inline,
}

/// A field that is present, `null` included; `#[serde(default)]` makes an absent one `None`.
fn present<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(d).map(Some)
}

impl HeaderTagEditInput {
    fn checked(self) -> Result<HeaderTagEdit, NotesError> {
        let name = |tag: &String| {
            let units = tag.trim().encode_utf16().count();
            (1..=MAX_TAG_UNITS).contains(&units)
        };
        let (add, remove, rename) = (
            self.add.unwrap_or_default(),
            self.remove.unwrap_or_default(),
            self.rename.unwrap_or_default(),
        );
        let fits = add.len() <= MAX_EDIT_TAGS
            && remove.len() <= MAX_EDIT_TAGS
            && rename.len() <= MAX_EDIT_TAGS
            && add.iter().chain(&remove).all(name)
            && rename.iter().all(|r| name(&r.from) && name(&r.to));
        if !fits {
            return Err(NotesError::InvalidTags);
        }
        Ok(HeaderTagEdit {
            add,
            remove,
            rename: rename
                .into_iter()
                .map(|r| HeaderTagRename {
                    from: r.from,
                    to: r.to,
                })
                .collect(),
            source: self
                .source
                .map(|HeaderTagSource::Inline| EditSource::Inline),
        })
    }
}

/// What an update came to.
#[derive(Debug)]
pub struct Updated {
    pub note: NoteView,
    /// The note's header tags or its body's `#tags` changed (`notes:tags-changed`).
    pub tags_changed: bool,
}

/// An update, checked.
struct Edit {
    id: String,
    content: Option<String>,
    header_tags: Option<HeaderTagEdit>,
    emoji: Option<Option<String>>,
}

impl NotesService {
    pub fn update(&self, open: &OpenVault, input: NoteUpdateInput) -> Result<Updated, NotesError> {
        self.update_checked(open, input, &mut || {})
    }

    /// [`Self::update`] with a hook that runs after the new file is written aside and before
    /// the checks ahead of its rename, so a test can edit the file in that window.
    #[doc(hidden)]
    pub fn update_checked(
        &self,
        open: &OpenVault,
        input: NoteUpdateInput,
        between: &mut dyn FnMut(),
    ) -> Result<Updated, NotesError> {
        let edit = Edit {
            header_tags: input
                .header_tags
                .map(HeaderTagEditInput::checked)
                .transpose()?,
            id: input.id,
            content: input.content,
            emoji: input.emoji,
        };
        let tags_changed = self
            .order
            .run(&edit.id, || self.update_now(open, &edit, between))?;
        let note = read::get(open, &edit.id, None)?
            .ok_or_else(|| NotesError::NotFound(edit.id.clone()))?;
        Ok(Updated { note, tags_changed })
    }

    fn update_now(
        &self,
        open: &OpenVault,
        edit: &Edit,
        between: &mut dyn FnMut(),
    ) -> Result<bool, NotesError> {
        let id = edit.id.as_str();
        let root = open.path.as_path();
        let rows = self.tier.rows();
        let session = rows.session_for(&open.vault)?;
        let writer = open.vault.notes_writer(self.store.clone())?;
        let reads_tags = edit.header_tags.is_some() || edit.content.is_some();
        let with_fields = match reads_tags {
            true => open.vault.tags_with_fields()?,
            false => HashSet::new(),
        };
        let mut lane = rows.lane_of(session)?;
        let not_found = || NotesError::NotFound(id.to_owned());
        let listed = open
            .vault
            .note_files()
            .listed_by_id(id)?
            .ok_or_else(not_found)?;
        let row = lane.files().by_id(id)?.ok_or_else(not_found)?;
        if row.file_type != FileType::Markdown.as_str() {
            return Err(NotesError::NotMarkdown);
        }
        let file = read_note(root, &row.path)?.ok_or_else(not_found)?;
        let parsed = file.parse()?;
        let frontmatter = match &parsed.frontmatter {
            YamlValue::Map(map) => (**map).clone(),
            _ => YamlMap::new(),
        };
        let before = file_header_tags(&frontmatter);
        let existing = Existing {
            header_tags: &before,
            content: &parsed.content,
        };
        let update = Update {
            header_tags: edit.header_tags.as_ref(),
            content: edit.content.as_deref(),
            ..Update::default()
        };
        let tags = header_tags::next(&existing, &update, &with_fields);
        let change = header_tags::compare(&before, &tags);
        if change.is_some() && !matches!(parsed.frontmatter, YamlValue::Map(_)) {
            // A top level that is a list or a scalar is the author's; no key goes into it.
            return Err(NotesError::FrontmatterNotAMap);
        }
        let body_tags_changed = edit
            .content
            .as_deref()
            .is_some_and(|content| tag_keys(&parsed.content) != tag_keys(content));
        // A file with no frontmatter keeps its byte order mark in the body; it goes back once,
        // ahead of whatever block the edit adds.
        let unmarked = |body: &str| body.strip_prefix(BOM).unwrap_or(body).to_owned();
        let read_body = unmarked(&parsed.content);
        let writing = writing_of_yaml(&parsed.frontmatter);
        let mut next = frontmatter.clone();
        header_tags::set_tags(&mut next, &tags, change.as_ref());
        let body = unmarked(edit.content.as_deref().unwrap_or(&read_body));
        let mut output =
            serialize_updated_note(parsed, &frontmatter, next, &body, change.is_some())?;
        if file.raw.starts_with(BOM) && !output.starts_with(BOM) {
            output.insert(0, BOM);
        }

        let emoji_changed = edit
            .emoji
            .as_ref()
            .is_some_and(|emoji| *emoji != listed.emoji);

        let held = row.content_hash.as_deref() == Some(file.hash.as_str());
        let (holds, fed) = match edit.content {
            None => (held, false),
            Some(_) => {
                let ours = self.saved_file(id).as_deref() == Some(file.hash.as_str());
                if !ours && body != read_body {
                    open.vault
                        .write_back()
                        .keep_replaced(id, &file.raw, &read_body)?;
                }
                let split = split_frontmatter_block(&output);
                // Outside the feed's write: the lookup reads the database the feed holds.
                let embeds =
                    Resolved::of_markdown(root, &open.vault.note_files(), split.body, &row.path);
                let settings = open.vault.app_settings(self.store.clone()).ok();
                let input = FeedInput {
                    note_id: id,
                    markdown: split.body,
                    note_path: Some(&row.path),
                    writing: Some(writing),
                    frontmatter: split.block,
                    embeds: Some(&embeds),
                };
                let outcome = open
                    .vault
                    .external_feed(self.store.clone())?
                    .feed_app_edit(&converter_for(settings.as_ref()), input, &read_body)?;
                match outcome {
                    FeedOutcome::Fed => (true, true),
                    FeedOutcome::Unchanged => (true, false),
                    FeedOutcome::NoNote => return Err(not_found()),
                    outcome => {
                        tracing::warn!(
                            scope = SCOPE,
                            note_id = id,
                            ?outcome,
                            "a saved body did not reach the note's document"
                        );
                        (false, false)
                    }
                }
            }
        };

        let hash = content_hash(&output);
        let wrote = output != file.raw;
        if wrote {
            let echo = self.tier.echo();
            if holds {
                echo.will_write(&row.path, &hash);
            }
            if let Err(error) =
                write_note_over_checked(root, &row.path, &output, &file.hash, between)
            {
                if holds {
                    echo.cancel_write(&row.path);
                }
                return Err(error.into());
            }
        }
        self.saved
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(id.to_owned(), hash.clone());
        if let Some(emoji) = edit.emoji.clone().filter(|_| emoji_changed) {
            writer.set_icon(id.to_owned(), emoji)?;
        }
        if change.is_some() {
            writer.set_tags(id.to_owned(), tags)?;
        }
        let mut content_hash = row.content_hash.clone();
        if holds && (wrote || !held) {
            // A save's feed made the body the file's now; a tag edit moved no body, so the row
            // keeps its stamp and a body still ahead of the file stays behind for the reconcile.
            let at = match edit.content {
                Some(_) => now_ms(),
                None => row.indexed_at,
            };
            let stat = RowStat {
                file_type: FileType::Markdown,
                size: output.len() as u64,
                content_hash: Some(hash.clone()),
                file_hash: Some(hash.clone()),
            };
            lane.put_as_of(id, &row.path, stat, at)?;
            content_hash = Some(hash);
        }
        if wrote || fed || emoji_changed {
            lane.publish(Applied::Changed {
                note_id: id.to_owned(),
                path: row.path,
                content_hash,
                source: ChangeSource::Edit,
            });
        }
        Ok(change.is_some() || body_tags_changed)
    }
}

impl NotesService {
    /// The hash of the file this run's last update of the note wrote.
    fn saved_file(&self, id: &str) -> Option<String> {
        self.saved
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(id)
            .cloned()
    }
}

/// A body's `#tags`, by tag fold.
fn tag_keys(body: &str) -> HashSet<String> {
    body_tags::extract_markdown(body)
        .iter()
        .map(|tag| fold(tag))
        .collect()
}
