//! A new note made in the app (`createNote`, `vault/notes-crud.ts`).
//!
//! Order, all under the rows' lane so no watcher fact for the path lands in between:
//! 1. the path: the title's file name in the folder (the vault's default note folder when none
//!    is given), the first free `<name> N.md`; inside the vault or refused;
//! 2. the record, with the tags, properties and icon (one outbox row): a failure here leaves
//!    nothing on disk;
//! 3. the row, with no hash yet, so the watcher's report of the file is a change of this note;
//! 4. the file, created (never replacing one that appeared meanwhile), told to the own-write
//!    record first;
//! 5. the body, seeded from the file, and the row's hashes once the document holds its text.
//!
//! Any failure after the file landed takes back what this call made: the file (told as the
//! app's removal), the record (a tombstone after its create), then the row. A crash between 4
//! and 5 leaves a row without a hash, and the next open walk seeds the empty body from the
//! file, as for any file the app wrote and did not read back.
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
use super::frontmatter::{file_fields, new_file_frontmatter};
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
use crate::vault::note_file::write_new_note;
use crate::vault::paths::{generate_note_path, resolve_vault_file, unique_candidates};

/// Names tried before a create gives up: `<title>.md`, then `<title> 1.md` up to this.
const MAX_CANDIDATES: usize = 10_000;
/// `NoteCreateSchema`: `title` is 1 to 200 UTF-16 units.
const MAX_TITLE_UNITS: usize = 200;

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

impl NotesService {
    pub fn create(&self, open: &OpenVault, note: NewNoteFile) -> Result<NoteView, NotesError> {
        self.create_checked(open, note, &mut || Ok(()))
    }

    /// [`Self::create`] with a hook that runs once the file landed, before its body is seeded,
    /// so a test can fail the step after the file.
    #[doc(hidden)]
    pub fn create_checked(
        &self,
        open: &OpenVault,
        note: NewNoteFile,
        after_file: &mut dyn FnMut() -> Result<(), NotesError>,
    ) -> Result<NoteView, NotesError> {
        let units = note.title.encode_utf16().count();
        if units == 0 || units > MAX_TITLE_UNITS {
            return Err(NotesError::InvalidTitle);
        }
        // `new Set(tags)`: an exact repeat goes, the first spelling stays.
        let mut seen = std::collections::HashSet::new();
        let mut note = note;
        note.tags.retain(|tag| seen.insert(tag.clone()));
        let root = open.path.as_path();
        let rows = self.tier.rows();
        let session = rows.session_for(&open.vault)?;
        let writer = open.vault.notes_writer(self.store.clone())?;
        let feed = open.vault.external_feed(self.store.clone())?;
        let mut lane = rows.lane_of(session)?;
        let rel = free_path(&lane, root, &note)?;
        let folder = rel.rsplit_once('/').map(|(folder, _)| folder);
        let output = write_markdown_note(
            &new_file_frontmatter(&note.tags, &note.properties),
            &note.content,
        )?;
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
        lane.publish(Applied::Added {
            note_id: id.clone(),
            path: rel.clone(),
            created: true,
            source: ChangeSource::App,
        });
        let echo = self.tier.echo();
        echo.will_write(&rel, &hash);
        let landed = write_new_note(
            root,
            &rel,
            &new_file_frontmatter(&note.tags, &note.properties),
            &note.content,
        );
        let seeded = landed
            .map_err(NotesError::from)
            .and_then(|()| after_file())
            .and_then(|()| {
                let feed_input = Seed {
                    root,
                    open,
                    id: &id,
                    rel: &rel,
                    raw: &output,
                };
                feed_input.run(self, &feed)
            });
        let holds_text = match seeded {
            Ok(holds_text) => holds_text,
            Err(error) => {
                if !matches!(error, NotesError::File(_)) {
                    remove_file(&echo, root, &rel);
                }
                undo_record(&writer, &id);
                remove_row(&mut lane, &id, &rel);
                return Err(error);
            }
        };
        let stat = RowStat {
            file_type: FileType::Markdown,
            size: output.len() as u64,
            content_hash: holds_text.then(|| hash.clone()),
            file_hash: Some(hash.clone()),
        };
        if let Err(error) = lane.put(&id, &rel, stat) {
            remove_file(&echo, root, &rel);
            undo_record(&writer, &id);
            remove_row(&mut lane, &id, &rel);
            return Err(error.into());
        }
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

/// The first name for the note that no file and no row holds, vault-relative with `/`.
fn free_path(lane: &Lane<'_>, root: &Path, note: &NewNoteFile) -> Result<String, NotesError> {
    let folder = note.folder.as_deref().filter(|folder| !folder.is_empty());
    let notes_dir = match folder {
        Some(_) => root.to_path_buf(),
        None => root.join(read_vault_config(root).default_note_folder),
    };
    let base = generate_note_path(&notes_dir, &note.title, folder);
    for candidate in unique_candidates(&base).take(MAX_CANDIDATES) {
        let Some(rel) = vault_relative(root, &candidate) else {
            return Err(NotesError::Outside);
        };
        if lane.check_free(&rel).is_err() || lane.row_at(&rel)?.is_some() {
            continue;
        }
        // Resolved through links: a folder linked outside the vault is refused, and a name
        // something is at, a dangling link included, is taken.
        match resolve_vault_file(root, &rel)? {
            Resolution::Outside => return Err(NotesError::Outside),
            Resolution::Inside(_) => {}
            Resolution::Missing => {
                if root.join(&rel).symlink_metadata().is_err() {
                    return Ok(rel);
                }
            }
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
fn remove_file(echo: &crate::vault::watch::EchoGuard, root: &Path, rel: &str) {
    let removed = echo.removing(rel, || super::delete::remove_vault_file(root, rel));
    if let Err(error) = removed {
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

fn remove_row(lane: &mut Lane<'_>, id: &str, rel: &str) {
    match lane.remove(id) {
        Ok(()) => lane.publish(Applied::Removed {
            note_id: id.to_owned(),
            path: rel.to_owned(),
            source: ChangeSource::App,
        }),
        Err(error) => tracing::error!(
            scope = SCOPE,
            note_id = id,
            "a failed create left its row: {error}"
        ),
    }
}
