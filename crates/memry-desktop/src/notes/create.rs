//! A new note made in the app (`createNote`, `vault/notes-crud.ts`).
//!
//! Order, all under the rows' lane so no watcher fact for the path lands in between:
//! 1. the path: the title's file name in the folder (the vault's default note folder when none
//!    is given), the first that no note holds under any spelling the volume folds and no file
//!    or link stands at, as `<name> N.md`; inside the vault or refused;
//! 2. the record, with the tags, the user properties and the icon (one outbox row);
//! 3. the row, with no hash yet, so the watcher's report of the file is a change of this note;
//! 4. the file, created and never replacing one that appeared meanwhile, told to the own-write
//!    record first;
//! 5. the body, seeded from the file, then the row's hashes once the document holds its text,
//!    and only then the `Added` fact, so a create taken back sends no note event.
//!
//! The row comes before the file because a file without a row is offered to the identity, which
//! takes it for a row-less note only by its folder and title (`identity::adopt`): `Plan 1.md` is
//! not the title `Plan`, so after a crash between the two it would become a second note.
//!
//! A failure takes back what this call made: the file only when this call wrote it (a file that
//! was there first stays as it is, and the watcher makes it a note), the record (a tombstone
//! after its create), then the row. A crash leaves one of three states, each one an open
//! converges or the user can act on:
//! - between 2 and 3: a live record with no row and no file. It is not listed here (a note
//!   lists once a row names its file) and syncs as an empty note; a file of that folder and
//!   title is adopted as it.
//! - between 3 and 4: a row with no hash and no file. The removal the next open's watcher finds
//!   keeps the note, since nothing proves only the file went (`identity::removed`), so it lists
//!   with its file missing until it is deleted, or a file at its path brings it back.
//! - between 4 and 5: a row without a hash beside the file, whose text seeds the empty body at
//!   the next open walk, as for any file the app wrote and did not read back.
//!
//! Not here yet, though Electron's create does them: the template a folder (`.folder.md`,
//! Step 13h) or a tag (Step 13j) names, a `template` id (Step 13l), and the note's date
//! reminders (Step 21).

use std::path::Path;

use memry_core::domain::external_feed::{FeedInput, FeedOutcome};
use memry_core::domain::note_stats::word_count;
use memry_core::markdown::frontmatter::{split_frontmatter_block, write_markdown_note};
use memry_core::markdown::shared::writing_tools::WritingFrontmatter;
use serde_json::{Map, Value};

use super::error::{NotesError, SCOPE};
use super::frontmatter::{file_fields, is_reserved_key, new_file_frontmatter};
use super::read;
use super::service::NotesService;
use super::view::{NoteView, SizeClass};
use crate::session::OpenVault;
use crate::shell::file_open::Resolution;
use crate::vault::config::read_vault_config;
use crate::vault::consumer::rows::{Lane, RowStat, now_ms};
use crate::vault::consumer::{Applied, ChangeSource, converter_for};
use crate::vault::embeds::Resolved;
use crate::vault::file_types::FileType;
use crate::vault::hash::content_hash;
use crate::vault::note_file::{NoteFileError, write_new_note};
use crate::vault::paths::{generate_note_path, resolve_vault_file, unique_candidates};
use crate::vault::watch::EchoGuard;

/// Names tried before a create gives up: `<title>.md`, then `<title> 1.md` up to this.
const MAX_CANDIDATES: usize = 10_000;
/// `NoteCreateSchema`: `title` is 1 to 200 UTF-16 units.
const MAX_TITLE_UNITS: usize = 200;
/// `NoteCreateSchema`: at most 50 tags of at most 50 UTF-16 units each.
const MAX_TAGS: usize = 50;
const MAX_TAG_UNITS: usize = 50;

/// What a create is asked to make.
#[derive(Debug, Clone, Default)]
pub struct NewNoteFile {
    pub title: String,
    pub content: String,
    pub folder: Option<String>,
    pub tags: Vec<String>,
    pub properties: Map<String, Value>,
    pub emoji: Option<String>,
}

impl NewNoteFile {
    /// `NoteCreateSchema` and `createNote`'s reading of it: the title's and the tags' limits,
    /// an exact repeat of a tag dropped (`new Set`), a body of whitespace alone made empty, and
    /// the reserved frontmatter keys left out of the properties (`writePropertiesToRoot`), for
    /// the record as for the file.
    fn checked(mut self) -> Result<Self, NotesError> {
        let units = |text: &str| text.encode_utf16().count();
        let title_units = units(&self.title);
        if title_units == 0 || title_units > MAX_TITLE_UNITS {
            return Err(NotesError::InvalidTitle);
        }
        if self.tags.len() > MAX_TAGS || self.tags.iter().any(|tag| units(tag) > MAX_TAG_UNITS) {
            return Err(NotesError::InvalidTags);
        }
        let mut seen = std::collections::HashSet::new();
        self.tags.retain(|tag| seen.insert(tag.clone()));
        // `String.prototype.trim` also strips the byte order mark.
        if self
            .content
            .trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
            .is_empty()
        {
            self.content.clear();
        }
        self.properties
            .retain(|name, value| !is_reserved_key(name, value));
        Ok(self)
    }
}

impl NotesService {
    pub fn create(&self, open: &OpenVault, note: NewNoteFile) -> Result<NoteView, NotesError> {
        self.create_checked(open, note, &mut || {}, &mut || Ok(()))
    }

    /// [`Self::create`] with two hooks for tests: `before_file` runs with the row reserved and
    /// before the file is written, `after_file` once the file landed and before its body is
    /// seeded, so a test can fail the step after it.
    #[doc(hidden)]
    pub fn create_checked(
        &self,
        open: &OpenVault,
        note: NewNoteFile,
        before_file: &mut dyn FnMut(),
        after_file: &mut dyn FnMut() -> Result<(), NotesError>,
    ) -> Result<NoteView, NotesError> {
        let note = note.checked()?;
        let root = open.path.as_path();
        let rows = self.tier.rows();
        let session = rows.session_for(&open.vault)?;
        let writer = open.vault.notes_writer(self.store.clone())?;
        let feed = open.vault.external_feed(self.store.clone())?;
        let mut lane = rows.lane_of(session)?;
        let rel = free_path(&lane, root, &note)?;
        let folder = rel.rsplit_once('/').map(|(folder, _)| folder);
        let frontmatter = new_file_frontmatter(&note.tags, &note.properties);
        let output = write_markdown_note(&frontmatter, &note.content)?;
        let hash = content_hash(&output);
        let properties = (!note.properties.is_empty()).then_some(&note.properties);
        let id = writer.create_with(
            &note.title,
            folder,
            &note.tags,
            properties,
            note.emoji.as_deref(),
        )?;
        let unseeded = RowStat {
            file_type: FileType::Markdown,
            size: 0,
            content_hash: None,
            file_hash: None,
        };
        if let Err(error) = lane.put(&id, &rel, unseeded) {
            undo_record(&writer, &id);
            return Err(error.into());
        }
        before_file();
        let echo = self.tier.echo();
        echo.will_write(&rel, &hash);
        if let Err(error) = write_new_note(root, &rel, &frontmatter, &note.content) {
            // Not this call's file: what stands there now is someone else's, its bytes too.
            echo.cancel_write(&rel);
            undo_record(&writer, &id);
            remove_row(&mut lane, &id);
            return Err(match error {
                NoteFileError::AlreadyExists => NotesError::NameConflict,
                error => error.into(),
            });
        }
        let seeded = after_file().and_then(|()| {
            let feed_input = Seed {
                root,
                open,
                id: &id,
                rel: &rel,
                raw: &output,
            };
            feed_input.run(self, &feed)
        });
        let take_back = |lane: &mut Lane<'_>, error: NotesError| {
            remove_file(&echo, root, &rel);
            undo_record(&writer, &id);
            remove_row(lane, &id);
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
        if let Err(error) = lane.put(&id, &rel, stat) {
            return take_back(&mut lane, error.into());
        }
        lane.publish(Applied::Added {
            note_id: id.clone(),
            path: rel.clone(),
            created: true,
            source: ChangeSource::App,
        });
        lane.publish(Applied::Changed {
            note_id: id.clone(),
            path: rel.clone(),
            content_hash: holds_text.then(|| hash.clone()),
            source: ChangeSource::App,
        });
        drop(lane);
        // The sidebar's manual order; the note is made either way.
        if let Err(error) = open
            .vault
            .note_positions()
            .place_at_top(&rel, folder.unwrap_or(""))
        {
            tracing::warn!(
                scope = SCOPE,
                note_id = id,
                "the new note got no slot: {error}"
            );
        }
        if !holds_text {
            // Past the large-file class: the note as a read classifies it, without its text.
            return read::get(open, &id, None)?.ok_or(NotesError::NotFound(id));
        }
        let now = now_ms();
        let parsed = memry_core::markdown::frontmatter::parse_markdown_note(&output)?;
        let fields = file_fields(&parsed.frontmatter);
        Ok(NoteView {
            id,
            path: rel,
            title: note.title,
            word_count: word_count(&note.content),
            content: note.content,
            frontmatter: fields.frontmatter,
            created: now,
            modified: now,
            tags: note.tags,
            header_tags: fields.header_tags,
            aliases: Vec::new(),
            properties: note.properties,
            emoji: note.emoji,
            size_class: SizeClass::Note,
            large_file: None,
            content_omitted: false,
        })
    }
}

/// The first name for the note that no note holds and nothing stands at, vault-relative with
/// `/`. The folder is resolved through links and must stay inside the vault; at the name, any
/// entry takes it: a file, a folder, a link, a dangling one included.
fn free_path(lane: &Lane<'_>, root: &Path, note: &NewNoteFile) -> Result<String, NotesError> {
    let folder = note.folder.as_deref().filter(|folder| !folder.is_empty());
    let notes_dir = match folder {
        Some(_) => root.to_path_buf(),
        None => root.join(read_vault_config(root).default_note_folder),
    };
    let base = generate_note_path(&notes_dir, &note.title, folder);
    let Some(base_rel) = vault_relative(root, &base) else {
        return Err(NotesError::Outside);
    };
    // `None`: the folder is not there yet, so no name in it is taken on disk.
    let real_folder = match base_rel.rsplit_once('/') {
        None => Some(root.to_path_buf()),
        Some((folder, _)) => match resolve_vault_file(root, folder)? {
            Resolution::Inside(real) => Some(real),
            Resolution::Missing => None,
            Resolution::Outside => return Err(NotesError::Outside),
        },
    };
    for candidate in unique_candidates(&base).take(MAX_CANDIDATES) {
        let Some(rel) = vault_relative(root, &candidate) else {
            return Err(NotesError::Outside);
        };
        // The folded key covers the exact spelling too.
        if lane.check_free(&rel).is_err() {
            continue;
        }
        let name = rel.rsplit_once('/').map_or(rel.as_str(), |(_, name)| name);
        let taken = real_folder
            .as_ref()
            .is_some_and(|folder| folder.join(name).symlink_metadata().is_ok());
        if !taken {
            return Ok(rel);
        }
    }
    Err(NotesError::NameConflict)
}

/// `path` under `root` as a vault-relative `/` path of plain segments, or `None` outside.
fn vault_relative(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let segments = rel
        .components()
        .map(|component| match component {
            std::path::Component::Normal(name) => name.to_str(),
            _ => None,
        })
        .collect::<Option<Vec<_>>>()?;
    (!segments.is_empty()).then(|| segments.join("/"))
}

/// The body seeded from the file just written.
struct Seed<'a> {
    root: &'a Path,
    open: &'a OpenVault,
    id: &'a str,
    rel: &'a str,
    raw: &'a str,
}

impl Seed<'_> {
    /// `Ok(true)` when the document now holds the file's text; `Ok(false)` when it did not take
    /// it (a body past the large-file class), which leaves the row without a content hash, so
    /// the write-back never writes over the file.
    fn run(
        &self,
        service: &NotesService,
        feed: &memry_core::api::external_feed::ExternalFeed,
    ) -> Result<bool, NotesError> {
        let split = split_frontmatter_block(self.raw);
        // Outside the feed's write: the lookup reads the database the feed holds.
        let embeds = Resolved::of_markdown(
            self.root,
            &self.open.vault.note_files(),
            split.body,
            self.rel,
        );
        let settings = self.open.vault.app_settings(service.store.clone()).ok();
        let input = FeedInput {
            note_id: self.id,
            markdown: split.body,
            note_path: Some(self.rel),
            // A new file holds no writing data.
            writing: Some(WritingFrontmatter::default()),
            frontmatter: split.block,
            embeds: Some(&embeds),
        };
        let outcome = feed.seed_body_if_empty(&converter_for(settings.as_ref()), input)?;
        if !matches!(outcome, FeedOutcome::Fed | FeedOutcome::Unchanged) {
            tracing::warn!(
                scope = SCOPE,
                note_id = self.id,
                ?outcome,
                "a new note's text did not reach its document"
            );
        }
        Ok(matches!(outcome, FeedOutcome::Fed | FeedOutcome::Unchanged))
    }
}

/// Takes back the file this create wrote, as the app's own removal.
fn remove_file(echo: &EchoGuard, root: &Path, rel: &str) {
    if let Err(error) = super::delete::unlink(echo, root, rel) {
        tracing::error!(
            scope = SCOPE,
            "a failed create left its new file behind: {error}"
        );
    }
}

/// Tombstones the record this create made; the create was queued, so peers get both.
fn undo_record(writer: &memry_core::api::notes_write::NotesWriter, id: &str) {
    if let Err(error) = writer.delete(id.to_owned()) {
        tracing::error!(
            scope = SCOPE,
            note_id = id,
            "a failed create left its record: {error}"
        );
    }
}

/// Removes the row this create reserved. No fact goes out: none went out for it.
fn remove_row(lane: &mut Lane<'_>, id: &str) {
    if let Err(error) = lane.remove(id) {
        tracing::error!(
            scope = SCOPE,
            note_id = id,
            "a failed create left its row: {error}"
        );
    }
}
