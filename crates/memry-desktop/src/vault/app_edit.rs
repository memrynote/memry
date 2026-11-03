//! The app's edit of an existing note's file and document (Step 13g-2, #3530): the one owner of
//! "the app changes the text of a note file and the note's document follows". The inbound link
//! repair of a rename runs through it (`notes::link_rewrite`, Electron `landSourceRewrite`), and
//! so are meant to: the property writer (13k-3), the linked mention and aliases (13i-5), a
//! template's apply (13l-4), the tag rename across notes (13j-4) and, with a precondition of its
//! own, the editor's save (`notes:update`, 13f-3c).
//!
//! [`AppEdit::run`] takes the note's write turn ([`NoteTurn`]) and holds the rows' lane from
//! the read to the row, so no watcher fact and no write-back pass for the note lands in
//! between. Its [`Precondition`] says what may be replaced:
//! - [`Precondition::Held`]: only a file the document holds. The file must hash to its row's
//!   hash, and the document must serialize to its text and `writing` data. Anything else is
//!   [`Edited::Kept`] and nothing changes: an outside edit not fed yet, a document ahead of its
//!   file, a body not pulled or not representable. The edit keeps no version, since it replaces
//!   only what both already hold. The document is compared before the feed and fed without
//!   `unless_changed_from`: the note's turn and the lane keep every writer of this device out
//!   in between, and no body writer runs outside them today. One that does (the resident
//!   editor, Step 14) must pass the body read as `unless_changed_from` here.
//!
//! A frontmatter that does not parse, in the file or in the edit's text, is kept as it is
//! (#3750). The caller's closure gets the file's text without a byte order mark and returns the
//! whole new text, or `None`; the seam puts the mark back once, where the file had it.
//!
//! **Order: the document first, then the file, then the row.**
//! 1. read (row, file, checks); 2. feed the new body ([`ExternalFeed::feed_app_edit`] with the
//!    body read, so the text the user saw is no version); 3. the own-write record, then the
//!    file, replaced only while it is still the bytes read ([`write_note_over`]); 4. the row's
//!    hashes, then [`Applied::Changed`] with the caller's [`ChangeSource`].
//!
//! Why this order, against the other (file, then feed):
//! - **Crash between the feed and the file**: the document holds the body edit and the row
//!   still names the old file, so the next open's reconcile writes the document's body out
//!   (`vault::writeback`, "every open brings the files left behind to their bodies"). The
//!   frontmatter is not in the document (but for its `writing` data), so a frontmatter change
//!   the edit made is lost there, and the edit must be made again (a rename's link repair: a
//!   replayed record, #3886). The other order leaves the whole edit in the file, which the walk
//!   feeds at the next open.
//! - **An outside edit that lands between the read and the write** makes the write refuse
//!   ([`Kept::FileChanged`]). The document already holds the edit, and the consumer, once the
//!   lane is free, feeds the outside edit over it and keeps the edit as a version: the outside
//!   edit wins and the edit is not lost. The other order loses it.
//! - **A feed that does not take the text** (an error, a large file, a refused or owed body):
//!   the file is written anyway, the own-write record is cleared rather than told, and the row
//!   is left. The watcher then reports the write once the lane is free, and the consumer feeds
//!   it as an outside edit (and retries it on an error), at once and not at the next open. A
//!   file whose write an own-write record absorbed would wait for the next open.
//! - **The watcher's echo of a write the document took**: the record is told before the
//!   write, and the row, written under the lane, names the new bytes, so the consumer finds the
//!   file read.
//!
//! A write that fails for another reason (a disk error) after the feed took the text leaves
//! the document ahead of its file, which the next open's reconcile writes. Not here: the lock
//! check (Step 14), and a rewritten journal day's own event (Step 13m).

use std::path::PathBuf;
use std::sync::Arc;

use memry_core::api::errors::{AuthError, StorageError};
use memry_core::api::external_feed::ExternalFeed;
use memry_core::api::vault::Vault;
use memry_core::crdt::errors::CrdtError;
use memry_core::domain::external_feed::{FeedInput, FeedOutcome, same_text};
use memry_core::domain::write_back::BodyRead;
use memry_core::markdown::convert::api::Converter;
use memry_core::markdown::frontmatter::{YamlValue, parse_markdown_note, split_frontmatter_block};
use memry_core::markdown::shared::writing_tools::writing_of_yaml;
use memry_core::seams::secure_store::SecureStore;

use super::consumer::rows::{RowError, RowOwner, RowSession, RowStat};
use super::consumer::{Applied, ChangeSource, VaultTier, converter_for};
use super::embeds::Resolved;
use super::file_types::FileType;
use super::hash::content_hash;
use super::note_file::{NoteFileError, read_note, write_note_over};
use super::watch::EchoGuard;
use crate::notes::write_order::NoteTurn;
use crate::session::OpenVault;

const SCOPE: &str = "app_edit";
const BOM: char = '\u{feff}';

/// What an edit may replace (see the module comment). The editor's save adds its own (13f-3c).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Precondition {
    /// Only a file the document holds; anything else is kept.
    Held,
}

/// What an edit came to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Edited {
    /// The file holds the new text. `held`: the document took it too, and the row says so;
    /// otherwise the watcher brings the file to the document as an outside edit.
    Wrote { hash: String, held: bool },
    /// The closure changed nothing.
    Unchanged,
    /// The file was kept as it is.
    Kept(Kept),
}

/// Why the file was kept.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Kept {
    NoRow,
    NotMarkdown,
    /// The row names a file that is not there.
    NoFile,
    /// The row has no hash, so the document is not known to hold the file.
    NotRead,
    /// The file differs from its row's hash (an outside edit not fed yet), or changed while the
    /// write ran.
    FileChanged,
    /// The file's frontmatter does not parse.
    FrontmatterUnreadable,
    /// The edit's text has a frontmatter that does not parse.
    FrontmatterBroken,
    /// The document holds an edit its file does not have yet.
    BodyAhead,
    /// The file holds an edit the document did not take.
    FileAhead,
    /// The note's server body has not been pulled.
    BodyNotPulled,
    /// The document holds what a markdown file cannot, or does not serialize.
    NotRepresentable,
    /// No live note or journal day by that id.
    NoBody,
}

/// How an edit failed. Every failure but [`AppEditError::File`] after the feed left the file,
/// the document and the row as they were.
#[derive(Debug, thiserror::Error)]
pub enum AppEditError {
    #[error(transparent)]
    Rows(#[from] RowError),
    #[error(transparent)]
    Storage(#[from] StorageError),
    #[error(transparent)]
    Crdt(#[from] CrdtError),
    #[error(transparent)]
    Auth(#[from] AuthError),
    #[error(transparent)]
    File(#[from] NoteFileError),
}

/// One vault session's edits, built per operation: a record or a session from one vault must
/// never reach another's files.
pub struct AppEdit {
    root: PathBuf,
    vault: Arc<Vault>,
    rows: Arc<RowOwner>,
    session: RowSession,
    echo: Arc<EchoGuard>,
    feed: ExternalFeed,
    converter: Converter,
}

impl AppEdit {
    pub fn new(
        tier: &VaultTier,
        store: &Arc<dyn SecureStore>,
        open: &OpenVault,
    ) -> Result<Self, AppEditError> {
        let rows = tier.rows();
        let session = rows.session_for(&open.vault)?;
        let settings = open.vault.app_settings(store.clone()).ok();
        Ok(Self {
            root: open.path.clone(),
            vault: open.vault.clone(),
            session,
            echo: tier.echo(),
            feed: open.vault.external_feed(store.clone())?,
            converter: converter_for(settings.as_ref()),
            rows,
        })
    }

    /// Edits the note whose turn `turn` is: `edit` gets the file's text without a byte order
    /// mark and returns its whole new text, or `None` to leave it. See the module comment for
    /// the order and the guards. Blocks; never call it from inside the lane or a database call.
    pub fn run<E: From<AppEditError>>(
        &self,
        turn: &NoteTurn<'_>,
        precondition: Precondition,
        source: ChangeSource,
        edit: impl FnOnce(&str) -> Result<Option<String>, E>,
    ) -> Result<Edited, E> {
        let note_id = turn.note_id();
        let mut lane = self
            .rows
            .lane_of(self.session)
            .map_err(AppEditError::from)?;
        let Some(row) = lane.files().by_id(note_id).map_err(AppEditError::from)? else {
            return Ok(Edited::Kept(Kept::NoRow));
        };
        if row.file_type != FileType::Markdown.as_str() {
            return Ok(Edited::Kept(Kept::NotMarkdown));
        }
        let Some(file) = read_note(&self.root, &row.path).map_err(AppEditError::from)? else {
            return Ok(Edited::Kept(Kept::NoFile));
        };
        let bom = file.raw.starts_with(BOM);
        let read = bare(&file.raw);
        let Ok(parsed) = parse_markdown_note(read) else {
            return Ok(Edited::Kept(Kept::FrontmatterUnreadable));
        };
        let read_body = split_frontmatter_block(read).body;
        let Precondition::Held = precondition;
        let Some(row_hash) = &row.content_hash else {
            return Ok(Edited::Kept(Kept::NotRead));
        };
        if *row_hash != file.hash {
            return Ok(Edited::Kept(Kept::FileChanged));
        }
        let differs = self.document_differs(note_id, &row.path, read, &parsed.frontmatter);
        if let Some(kept) = differs.map_err(AppEditError::from)? {
            return Ok(Edited::Kept(kept));
        }
        let Some(next) = edit(read)? else {
            return Ok(Edited::Unchanged);
        };
        let next = bare(&next);
        let text = if bom {
            format!("{BOM}{next}")
        } else {
            next.to_owned()
        };
        if text == file.raw {
            return Ok(Edited::Unchanged);
        }
        let Ok(edited) = parse_markdown_note(next) else {
            return Ok(Edited::Kept(Kept::FrontmatterBroken));
        };
        let Some(takes) = self.feed_text(note_id, &row.path, next, &edited.frontmatter, read_body)
        else {
            return Ok(Edited::Kept(Kept::NoBody));
        };
        let hash = content_hash(&text);
        if takes {
            self.echo.will_write(&row.path, &hash);
        } else {
            // What the watcher sees next must reach the consumer, which feeds it.
            self.echo.cancel_write(&row.path);
        }
        if let Err(error) = write_note_over(&self.root, &row.path, &text, &file.hash) {
            self.echo.cancel_write(&row.path);
            return match error {
                NoteFileError::ChangedUnderWrite => Ok(Edited::Kept(Kept::FileChanged)),
                error => Err(AppEditError::from(error).into()),
            };
        }
        if !takes {
            return Ok(Edited::Wrote { hash, held: false });
        }
        let stat = RowStat {
            file_type: FileType::Markdown,
            size: text.len() as u64,
            content_hash: Some(hash.clone()),
            file_hash: Some(hash.clone()),
        };
        lane.put(note_id, &row.path, stat)
            .map_err(AppEditError::from)?;
        lane.publish(Applied::Changed {
            note_id: note_id.to_owned(),
            path: row.path,
            content_hash: Some(hash.clone()),
            source,
        });
        Ok(Edited::Wrote { hash, held: true })
    }

    /// Why the document is not the file's text `read`, or `None` when it is.
    fn document_differs(
        &self,
        note_id: &str,
        path: &str,
        read: &str,
        frontmatter: &YamlValue,
    ) -> Result<Option<Kept>, CrdtError> {
        let body = split_frontmatter_block(read).body;
        // Outside the read: the lookup reads the database the read holds.
        let embeds = Resolved::of_markdown(&self.root, &self.vault.note_files(), body, path);
        let read = self
            .vault
            .write_back()
            .body(&self.converter, note_id, path, body, &embeds)?;
        Ok(match read {
            BodyRead::Body(held) => (!same_text(&held.markdown, body)
                || held.writing != writing_of_yaml(frontmatter))
            .then_some(Kept::BodyAhead),
            BodyRead::FileAhead => Some(Kept::FileAhead),
            BodyRead::BodyNotPulled => Some(Kept::BodyNotPulled),
            BodyRead::NotRepresentable(_) | BodyRead::Failed(_) => Some(Kept::NotRepresentable),
            BodyRead::NoNote => Some(Kept::NoBody),
        })
    }

    /// Feeds the new text's body over `read`, the body read: whether the document now holds
    /// it, or `None` when there is no such note.
    fn feed_text(
        &self,
        note_id: &str,
        path: &str,
        text: &str,
        frontmatter: &YamlValue,
        read: &str,
    ) -> Option<bool> {
        let split = split_frontmatter_block(text);
        let embeds = Resolved::of_markdown(&self.root, &self.vault.note_files(), split.body, path);
        let input = FeedInput {
            note_id,
            markdown: split.body,
            note_path: Some(path),
            writing: Some(writing_of_yaml(frontmatter)),
            frontmatter: split.block,
            embeds: Some(&embeds),
        };
        match self.feed.feed_app_edit(&self.converter, input, read) {
            Ok(FeedOutcome::Fed | FeedOutcome::Unchanged) => Some(true),
            Ok(FeedOutcome::NoNote) => None,
            Ok(outcome) => {
                tracing::warn!(
                    scope = SCOPE,
                    note_id,
                    outcome = ?outcome,
                    "an edited file's text did not reach its note; the watcher brings it in"
                );
                Some(false)
            }
            Err(error) => {
                tracing::error!(
                    scope = SCOPE,
                    note_id,
                    "an edited file's text did not reach its note; the watcher feeds it again: \
                     {error}"
                );
                Some(false)
            }
        }
    }
}

fn bare(text: &str) -> &str {
    text.strip_prefix(BOM).unwrap_or(text)
}
