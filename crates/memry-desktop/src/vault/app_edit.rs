//! The app's own edit of a note file's text, outside the editor (Step 13g-2, #3530): the one
//! seam through which a service changes the bytes of an existing note file and has the note's
//! document follow (Electron `landSourceRewrite`, `rename-link-rewrite.ts`). The inbound link
//! repair of a rename uses it (`notes::link_rewrite`); the frontmatter writer of note properties
//! (13k-3), the linked mention and aliases (13i-5) and the tag rename across notes (13j-4) are
//! meant to.
//!
//! [`AppEdit::run`] holds the rows' lane from the read to the row, so no watcher fact and no
//! write-back pass for the note lands in between, and in this order:
//! 1. **Read**: the note's row, and its file, which must be markdown, must hash to the row's hash
//!    (the document holds it; otherwise it is an outside edit not fed yet) and must have a
//!    frontmatter that parses.
//! 2. **The document is the file**: the body the write-back would write
//!    ([`memry_core::domain::write_back::body_for_file`]) is the file's text and its `writing`
//!    data. A document ahead of its file (an edit the write-back has not written yet) or not
//!    the note's body (owed, not pulled, not representable) keeps the file: an edit of the file
//!    would replace that body.
//! 3. **Edit**: the caller's closure gets the file and returns the whole new text, or `None`.
//!    A text whose frontmatter no longer parses is not written.
//! 4. **Write**: the own-write record is told the new hash ([`EchoGuard::will_write`]), and the
//!    file is replaced only while it is still the bytes read
//!    ([`crate::vault::note_file::write_note_over`]).
//! 5. **Feed**: the new body replaces the document's ([`ExternalFeed::feed_app_edit`], with the
//!    body read, so no version of it is kept). File first, as the watcher lands an outside edit:
//!    a feed that does not take the text leaves the note owing its file body, which the
//!    write-back keeps, and the next open feeds it again.
//! 6. **Row**: the new hash, then [`Applied::Changed`] with the caller's [`ChangeSource`].
//!    A feed that did not take the text records only the bytes' pairing hash and publishes
//!    nothing, as the consumer does for an outside edit it could not feed.
//!
//! Every answer but [`Edited::Wrote`] left the file as it was. The caller runs it inside the
//! note's `WriteOrder` turn, never while holding another note's turn, and never from inside the
//! lane or a database call. Each call blocks.

use std::path::PathBuf;
use std::sync::Arc;

use memry_core::api::external_feed::ExternalFeed;
use memry_core::api::vault::Vault;
use memry_core::domain::external_feed::{FeedInput, FeedOutcome, same_text};
use memry_core::domain::write_back::BodyRead;
use memry_core::markdown::convert::api::Converter;
use memry_core::markdown::frontmatter::{YamlValue, parse_markdown_note, split_frontmatter_block};
use memry_core::markdown::shared::writing_tools::writing_of_yaml;
use memry_core::seams::secure_store::SecureStore;

use super::consumer::rows::{RowOwner, RowSession, RowStat};
use super::consumer::{Applied, ChangeSource, VaultTier, converter_for};
use super::embeds::Resolved;
use super::file_types::FileType;
use super::hash::content_hash;
use super::note_file::{NoteFile, NoteFileError, read_note, write_note_over};
use super::watch::EchoGuard;
use crate::notes::error::NotesError;
use crate::session::OpenVault;

const SCOPE: &str = "app_edit";
const BOM: char = '\u{feff}';

/// What an edit came to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Edited {
    /// The file holds the new text. `held`: the document took it too, and the row says so.
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
    /// The row has no hash: the document is not known to hold the file.
    NotRead,
    /// The file differs from its row's hash (an outside edit not fed yet), or changed while
    /// the write ran.
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
    /// The document holds what a markdown file cannot.
    NotRepresentable,
    /// No live note by that id, or its body did not serialize.
    NoBody,
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
    ) -> Result<Self, NotesError> {
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

    /// Edits the note's file: `edit` gets the file as it is and returns its whole new text, or
    /// `None` to leave it. See the module comment for the order and the guards.
    pub fn run<E: From<NotesError>>(
        &self,
        note_id: &str,
        source: ChangeSource,
        edit: impl FnOnce(&NoteFile) -> Result<Option<String>, E>,
    ) -> Result<Edited, E> {
        let mut lane = self.rows.lane_of(self.session).map_err(NotesError::from)?;
        let Some(row) = lane.files().by_id(note_id).map_err(NotesError::from)? else {
            return Ok(Edited::Kept(Kept::NoRow));
        };
        if row.file_type != FileType::Markdown.as_str() {
            return Ok(Edited::Kept(Kept::NotMarkdown));
        }
        let Some(row_hash) = row.content_hash else {
            return Ok(Edited::Kept(Kept::NotRead));
        };
        let Some(file) = read_note(&self.root, &row.path).map_err(NotesError::from)? else {
            return Ok(Edited::Kept(Kept::NoFile));
        };
        if file.hash != row_hash {
            return Ok(Edited::Kept(Kept::FileChanged));
        }
        let Ok(parsed) = file.parse() else {
            return Ok(Edited::Kept(Kept::FrontmatterUnreadable));
        };
        let body = bare(file.split().body);
        if let Some(kept) = self.document_differs(note_id, &row.path, body, &parsed.frontmatter)? {
            return Ok(Edited::Kept(kept));
        }
        let Some(text) = edit(&file)?.filter(|text| *text != file.raw) else {
            return Ok(Edited::Unchanged);
        };
        let Ok(next) = parse_markdown_note(&text) else {
            return Ok(Edited::Kept(Kept::FrontmatterBroken));
        };
        let hash = content_hash(&text);
        self.echo.will_write(&row.path, &hash);
        match write_note_over(&self.root, &row.path, &text, &file.hash) {
            Ok(()) => {}
            Err(error) => {
                self.echo.cancel_write(&row.path);
                return match error {
                    NoteFileError::ChangedUnderWrite => Ok(Edited::Kept(Kept::FileChanged)),
                    error => Err(NotesError::from(error).into()),
                };
            }
        }
        let held = self.feed_text(note_id, &row.path, &text, &next.frontmatter, body);
        if !held {
            if let Err(error) = lane.record_file_hash(note_id, Some(&hash)) {
                tracing::warn!(
                    scope = SCOPE,
                    note_id,
                    "the file hash was not recorded: {error}"
                );
            }
            return Ok(Edited::Wrote { hash, held });
        }
        let stat = RowStat {
            file_type: FileType::Markdown,
            size: text.len() as u64,
            content_hash: Some(hash.clone()),
            file_hash: Some(hash.clone()),
        };
        lane.put(note_id, &row.path, stat)
            .map_err(NotesError::from)?;
        lane.publish(Applied::Changed {
            note_id: note_id.to_owned(),
            path: row.path,
            content_hash: Some(hash.clone()),
            source,
        });
        Ok(Edited::Wrote { hash, held })
    }

    /// Why the document is not the file's text, or `None` when it is.
    fn document_differs(
        &self,
        note_id: &str,
        path: &str,
        body: &str,
        frontmatter: &YamlValue,
    ) -> Result<Option<Kept>, NotesError> {
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
            BodyRead::NotRepresentable(_) => Some(Kept::NotRepresentable),
            BodyRead::NoNote | BodyRead::Failed(_) => Some(Kept::NoBody),
        })
    }

    /// Feeds the written text's body; true when the document now holds it.
    fn feed_text(
        &self,
        note_id: &str,
        path: &str,
        text: &str,
        frontmatter: &YamlValue,
        read: &str,
    ) -> bool {
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
            Ok(FeedOutcome::Fed | FeedOutcome::Unchanged) => true,
            Ok(outcome) => {
                tracing::warn!(
                    scope = SCOPE,
                    note_id,
                    outcome = ?outcome,
                    "an edited file's text did not reach its note"
                );
                false
            }
            Err(error) => {
                tracing::error!(
                    scope = SCOPE,
                    note_id,
                    "an edited file's text did not reach its note: {error}"
                );
                false
            }
        }
    }
}

fn bare(body: &str) -> &str {
    body.strip_prefix(BOM).unwrap_or(body)
}
