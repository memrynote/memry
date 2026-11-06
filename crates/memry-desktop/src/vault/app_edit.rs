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
//! - [`Precondition::HeldAt`]: [`Precondition::Held`] for a note whose file moved since its
//!   document took it (a moved note's own refs, `notes::link_rewrite`). The document is compared
//!   as it was built, with its Obsidian embeds resolved from the file's old path: from the new
//!   one, `![[img/photo.png]]` names another file, and a document that holds the file would read
//!   as ahead of it. The new text is fed at the new path.
//! - [`Precondition::Replace`]: [`Precondition::Held`]'s guard, for an edit that writes over the
//!   user's text (a template applied, `notes:apply-template`). A body it changes is kept as a
//!   version of the whole file first, as a save keeps one.
//! - [`Precondition::Save`]: the user's save (`notes:update`, Electron `writeNote`), which
//!   replaces whatever is there. A save that moves the body first keeps a version of the whole
//!   file unless it is the run's own ([`OwnFiles`]) and its row names it; the feed keeps the
//!   document's body when it is not the body read (a merge from sync the write-back has not
//!   written). A save that leaves the body as read (a header tag edit) feeds nothing and keeps
//!   no version, so a document ahead of its file keeps its text; the file then counts as the
//!   document's (own-write record, row) only if the row named it. Only a frontmatter that does
//!   not parse, a missing row, file or note, a file that is not markdown, and an edit that
//!   lands during the write ([`Kept::FileChanged`]) keep the file. A file its row does not name
//!   and whose bytes are not the run's own is an outside edit the consumer has not fed yet.
//!   This save's bytes, the run's own, will never reach the consumer as one, so what that
//!   file's frontmatter says (tags, property values) reaches the record first, through the
//!   identity's [`NoteIdentity::on_changed`], as the consumer would have told it. The save's own
//!   record mirror then goes over that. A row behind the run's own bytes (a save the feed did
//!   not take) is no outside edit: those bytes carry the record already.
//!
//! A frontmatter that does not parse, in the file or in the edit's text, is kept as it is
//! (#3750). The caller's closure gets the file's text without a byte order mark and returns the
//! whole new text, or `None`; the seam puts the mark back once, where the file had it.
//!
//! **Order: the document first, then the file, then the row.**
//! 1. read (row, file, checks); 2. `Save` and `Replace` only: the version of the file; 3. feed
//!    the new body
//!    ([`ExternalFeed::feed_app_edit`] with the body read, so the text the user saw is no
//!    version); 4. the own-write record, then the file, replaced only while it is still the
//!    bytes read ([`write_note_over_checked`]); 5. the row's hashes, the caller's `landed`
//!    ([`AppEdit::run_then`]), then [`Applied::Changed`] with the caller's [`ChangeSource`].
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

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use memry_core::api::errors::{AuthError, StorageError};
use memry_core::api::external_feed::ExternalFeed;
use memry_core::api::search::Search;
use memry_core::api::vault::Vault;
use memry_core::crdt::errors::CrdtError;
use memry_core::domain::external_feed::{FeedInput, FeedOutcome, same_text};
use memry_core::domain::write_back::BodyRead;
use memry_core::markdown::convert::api::Converter;
use memry_core::markdown::frontmatter::{YamlValue, parse_markdown_note, split_frontmatter_block};
use memry_core::markdown::shared::writing_tools::writing_of_yaml;
use memry_core::seams::secure_store::SecureStore;

use super::consumer::identity::{IdentityCtx, IdentityError, NoteIdentity};
use super::consumer::rows::{RowError, RowOwner, RowSession, RowStat, now_ms};
use super::consumer::{Applied, ChangeSource, VaultTier, converter_for};
use super::embeds::Resolved;
use super::file_types::FileType;
use super::hash::content_hash;
use super::note_file::{
    NoteFile, NoteFileError, large_file_class, read_note, record_large_file,
    write_note_over_checked,
};
use super::watch::EchoGuard;
use crate::notes::write_order::NoteTurn;
use crate::session::OpenVault;

const SCOPE: &str = "app_edit";
const BOM: char = '\u{feff}';

/// What an edit may replace (see the module comment).
#[derive(Debug, Clone, Copy)]
pub enum Precondition<'a> {
    /// Only a file the document holds; anything else is kept.
    Held,
    /// [`Precondition::Held`], for a document built while its file was at this path.
    HeldAt(&'a str),
    /// [`Self::Held`], and a body the edit changes kept as a version first: the edit writes over
    /// the user's text.
    Replace,
    /// The user's save: whatever is there, a file that is not the run's own kept as a version
    /// first.
    Save(&'a OwnFiles),
}

/// By note id, the hash of the file this run wrote for the note, and who wrote it: set by its
/// create and by a save that moved its body, carried by a save that did not only while that
/// file was still on disk, dropped when such a save lands on another or an outside edit
/// replaces it. A save replaces the run's own file, the row naming it, with no version: the
/// user saw it. Any other file may hold an outside edit the editor never showed (canvas,
/// project overview), fed or not, so it is kept first. The consumer reports the watcher's read
/// of the run's own file as its writer's (a save whose document did not take it).
#[derive(Debug, Default)]
pub struct OwnFiles(Mutex<HashMap<String, (String, ChangeSource)>>);

impl OwnFiles {
    /// This run wrote `hash` as the note's text, as `source`.
    pub fn wrote(&self, note_id: &str, hash: &str, source: ChangeSource) {
        self.marks()
            .insert(note_id.to_owned(), (hash.to_owned(), source));
    }

    /// Who wrote `hash` as the note's text, when it is the text this run wrote last for it.
    pub(crate) fn writer(&self, note_id: &str, hash: &str) -> Option<ChangeSource> {
        self.marks()
            .get(note_id)
            .filter(|(own, _)| own == hash)
            .map(|(_, source)| *source)
    }

    fn is(&self, note_id: &str, hash: &str) -> bool {
        self.writer(note_id, hash).is_some()
    }

    /// An outside edit replaced the note's file: bytes equal to the run's put back later are
    /// the outside's too.
    pub(crate) fn forget(&self, note_id: &str) {
        self.marks().remove(note_id);
    }

    /// A vault opens: what the run wrote in another is not its own here, though a day's id is.
    pub(crate) fn clear(&self) {
        self.marks().clear();
    }

    /// A save that left the body: `to` is the run's own only if `from`, the file it replaced,
    /// was.
    fn carried(&self, note_id: &str, from: &str, to: &str) {
        let mut marks = self.marks();
        match marks.get_mut(note_id) {
            Some((own, _)) if own == from => *own = to.to_owned(),
            _ => {
                marks.remove(note_id);
            }
        }
    }

    fn marks(&self) -> MutexGuard<'_, HashMap<String, (String, ChangeSource)>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// What an edit came to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Edited {
    /// The file holds the new text. `held`: the document took it too, and the row says so;
    /// otherwise the watcher brings the file to the document as an outside edit.
    /// `kept_outside`: a save's body went over an outside edit not fed yet, kept as a version
    /// first; the editor had no event for it. `text`: the file as written, byte order mark
    /// included.
    Wrote {
        hash: String,
        held: bool,
        kept_outside: bool,
        text: String,
    },
    /// The closure changed nothing; `text` is the file as read.
    Unchanged { text: String },
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
    search: Arc<Search>,
    identity: Arc<dyn NoteIdentity>,
    rows: Arc<RowOwner>,
    session: RowSession,
    echo: Arc<EchoGuard>,
    feed: ExternalFeed,
    converter: Converter,
    fail_next_feed: AtomicBool,
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
            search: open.search.clone(),
            identity: tier.identity(),
            session,
            echo: tier.echo(),
            feed: open.vault.external_feed(store.clone())?,
            converter: converter_for(settings.as_ref()),
            rows,
            fail_next_feed: AtomicBool::new(false),
        })
    }

    /// Test hook: this edit's next feed fails, as for a document that does not load.
    #[doc(hidden)]
    pub fn fail_next_feed(&self) {
        self.fail_next_feed.store(true, Ordering::Relaxed);
    }

    /// Edits the note whose turn `turn` is: `edit` gets the file's text without a byte order
    /// mark and returns its whole new text, or `None` to leave it. See the module comment for
    /// the order and the guards. Blocks; never call it from inside the lane or a database call.
    pub fn run<E: From<AppEditError>>(
        &self,
        turn: &NoteTurn<'_>,
        precondition: Precondition<'_>,
        source: ChangeSource,
        edit: impl FnOnce(&str) -> Result<Option<String>, E>,
    ) -> Result<Edited, E> {
        self.run_then(turn, precondition, source, edit, || Ok(false), &mut || {})
    }

    /// [`Self::run`], and `landed` once the file holds the edit, or the edit left it as it was:
    /// under the lane and before the note event, so a caller's record mirrors (an icon, tags)
    /// wait for the file, a refused write leaves them, and the event reads them. `landed`
    /// answers whether the note changed though its file did not, which sends the event anyway.
    /// `between` runs after the new file is written aside and before its rename, so a test can
    /// edit the file in that window.
    pub fn run_then<E: From<AppEditError>>(
        &self,
        turn: &NoteTurn<'_>,
        precondition: Precondition<'_>,
        source: ChangeSource,
        edit: impl FnOnce(&str) -> Result<Option<String>, E>,
        landed: impl FnOnce() -> Result<bool, E>,
        between: &mut dyn FnMut(),
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
        let row_names_file = row.content_hash.as_deref() == Some(file.hash.as_str());
        let mut outside = false;
        let own = match precondition {
            Precondition::Held | Precondition::HeldAt(_) | Precondition::Replace => {
                if row.content_hash.is_none() {
                    return Ok(Edited::Kept(Kept::NotRead));
                }
                if !row_names_file {
                    return Ok(Edited::Kept(Kept::FileChanged));
                }
                let built_at = match precondition {
                    Precondition::HeldAt(path) => path,
                    _ => &row.path,
                };
                let differs = self.document_differs(note_id, built_at, read, &parsed.frontmatter);
                if let Some(kept) = differs.map_err(AppEditError::from)? {
                    return Ok(Edited::Kept(kept));
                }
                None
            }
            Precondition::Save(own) => {
                // A row with no hash names no file the document took, so none was replaced.
                outside =
                    row.content_hash.is_some() && !row_names_file && !own.is(note_id, &file.hash);
                if let Some(previous) = row.content_hash.as_deref().filter(|_| outside) {
                    self.take_outside(note_id, previous, &file)
                        .map_err(AppEditError::from)?;
                }
                Some(own)
            }
        };
        let text = edit(read)?.map(|next| match bom {
            true => format!("{BOM}{}", bare(&next)),
            false => bare(&next).to_owned(),
        });
        let Some(text) = text.filter(|text| *text != file.raw) else {
            if let Some(own) = own {
                own.carried(note_id, &file.hash, &file.hash);
            }
            if landed()? {
                lane.publish(Applied::Changed {
                    note_id: note_id.to_owned(),
                    path: row.path,
                    content_hash: row.content_hash,
                    source,
                });
            }
            return Ok(Edited::Unchanged { text: file.raw });
        };
        let next = bare(&text);
        let Ok(edited) = parse_markdown_note(next) else {
            return Ok(Edited::Kept(Kept::FrontmatterBroken));
        };
        // A save that leaves the body as read (a header tag edit) feeds nothing, so a document
        // ahead of its file keeps its text, and loses nothing a version would hold.
        let body_changed = split_frontmatter_block(next).body != read_body;
        let body_moved = own.is_none() || body_changed;
        let keeps = match precondition {
            Precondition::Held | Precondition::HeldAt(_) => false,
            Precondition::Replace => body_changed,
            Precondition::Save(own) => {
                body_changed && !(row_names_file && own.is(note_id, &file.hash))
            }
        };
        if keeps {
            self.vault
                .write_back()
                .keep_replaced(note_id, &file.raw, read_body)
                .map_err(AppEditError::from)?;
        }
        let takes = match body_moved {
            true => {
                let fed = self.feed_text(note_id, &row.path, next, &edited.frontmatter, read_body);
                let Some(takes) = fed else {
                    return Ok(Edited::Kept(Kept::NoBody));
                };
                takes
            }
            // The document holds what the row names; the file is its text only if that is it.
            false => row_names_file,
        };
        let hash = content_hash(&text);
        if takes {
            self.echo.will_write(&row.path, &hash);
        } else {
            // What the watcher sees next must reach the consumer, which feeds it.
            self.echo.cancel_write(&row.path);
        }
        if let Err(error) =
            write_note_over_checked(&self.root, &row.path, &text, &file.hash, between)
        {
            self.echo.cancel_write(&row.path);
            return match error {
                NoteFileError::ChangedUnderWrite => Ok(Edited::Kept(Kept::FileChanged)),
                error => Err(AppEditError::from(error).into()),
            };
        }
        // The watcher may skip this write's echo, so no read of it would record the class.
        record_large_file(lane.files(), note_id, large_file_class(&text).is_some());
        if let Some(own) = own {
            match body_moved {
                true => own.wrote(note_id, &hash, source),
                false => own.carried(note_id, &file.hash, &hash),
            }
        }
        if takes {
            let stat = RowStat {
                file_type: FileType::Markdown,
                size: text.len() as u64,
                content_hash: Some(hash.clone()),
                file_hash: Some(hash.clone()),
            };
            // A body left as read keeps the row's stamp, so a document ahead of the file stays
            // ahead for the write-back.
            let at = if body_moved { now_ms() } else { row.indexed_at };
            lane.put_as_of(note_id, &row.path, stat, at)
                .map_err(AppEditError::from)?;
        }
        landed()?;
        if !takes {
            return Ok(Edited::Wrote {
                hash,
                held: false,
                kept_outside: outside && keeps,
                text,
            });
        }
        lane.publish(Applied::Changed {
            note_id: note_id.to_owned(),
            path: row.path,
            content_hash: Some(hash.clone()),
            source,
        });
        Ok(Edited::Wrote {
            hash,
            held: true,
            kept_outside: outside && keeps,
            text,
        })
    }

    /// The record takes what an outside edit not fed yet, the file `file` that replaced the
    /// one hashed `previous`, says of it (see the module comment).
    fn take_outside(
        &self,
        note_id: &str,
        previous: &str,
        file: &NoteFile,
    ) -> Result<(), StorageError> {
        let ctx = IdentityCtx {
            root: &self.root,
            vault: &self.vault,
            search: &self.search,
        };
        self.identity
            .on_changed(&ctx, note_id, previous, file)
            .map_err(|error| match error {
                IdentityError::Storage(error) => error,
                IdentityError::Other(what) => StorageError::Failed { what },
            })
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
        let fed = match self.fail_next_feed.swap(false, Ordering::Relaxed) {
            true => Err(CrdtError::Undecodable {
                doc_id: note_id.to_owned(),
                what: "test fault".to_owned(),
            }),
            false => self.feed.feed_app_edit(&self.converter, input, read),
        };
        match fed {
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
