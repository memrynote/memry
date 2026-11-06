//! `Editor`: the note and journal documents editor windows type into (desktop
//! Step 14, #3531). Reached from [`crate::api::vault::Vault::editor`]. Not
//! exported over UniFFI: iOS edits bodies through its own path.
//!
//! One owner per vault holds every resident document ([`Resident`]). A window
//! opens a document and receives its whole state; each edit it sends comes back
//! here as a Yjs update, and [`Editor::apply_update`] stores it, queues it for
//! the other devices and applies it to the resident document, then hands it to
//! every listener of that document with its [`Origin`], so the other windows
//! catch up.
//!
//! **Every other writer of the body log reaches the resident documents** (14c-1):
//! a sync merge, a delete's purge, an outside edit fed from the file, a note or
//! journal command. The editor observes its vault's database
//! ([`crate::crdt::body_writes`]); after any write closure that wrote a resident
//! or held document's log, it reads the rows that closure wrote back from the
//! committed log by key, applies them and hands each that added something to
//! the listeners with the writer's [`Origin`] (`catch_up.rs`). A write that
//! rolled back adds nothing. A log that moved to a new epoch was purged: the
//! document goes, its holders are stale until they open it again, and the
//! listeners hear [`Notice::Purged`] ([`Editor::purge`]). The editor's own
//! writes run untold: it fans them out itself, and it holds the resident set
//! while it writes.
//!
//! **Durable before acknowledged** (FR-030, data-model §A.2): the update row and
//! its outbox row commit in one transaction, and [`Applied`] and the fan-out
//! exist only after that commit. The update is applied to the resident document
//! first, so an update `yrs` refuses writes nothing, and one that changes
//! nothing (a resend, a sync-step-2 diff with nothing new) is neither stored,
//! queued nor fanned out, as Electron's `Y.applyUpdate` fires no update for it.
//! When the rows or the commit then fail, the resident document is dropped and
//! the next access replays it from the log. The bytes are stored exactly as
//! received (chapter 12 §12.5.0), and a local-only note gets its log row and no
//! outbox row ([`outbox::enqueue`] decides that).
//!
//! **A read-only note takes no window edit.** [`Opened::read_only`] says why: its
//! file is large-file class as its last read measured it (the app shows it in
//! the large-file viewer), or it is locked. [`Editor::apply_update`] checks on the
//! writer and refuses before the update is applied, stored, queued or fanned out.
//!
//! **Every `yrs` transaction on a resident document runs under the resident
//! lock**, reads included ([`Editor::with_document`]). `yrs` does not wait for a
//! busy document, it refuses (`DocumentBusy`): a read outside the lock made a
//! concurrent edit fail, and the window's later edits, which depend on it, then
//! waited forever in the document's pending set. Holding the lock through the
//! commit also keeps a reader from seeing an edit whose commit then fails.
//!
//! A resident document authors one write of its own, under the writer right
//! after its replay, so it holds every committed update: the repair of blocks
//! without an id (`repairEmptyBlockIds`), stored with its outbox row
//! (`Editor::load`).
//!
//! The host has no threads and no clock of its own: the shell calls
//! [`Editor::sweep`] on its timer, and [`Editor::compact`] for each document
//! [`Editor::compaction_due`] names (`compaction.rs`). Every method blocks on the vault's writer
//! connection; the shell runs them in `spawn_blocking`. Locks are taken in one
//! order, the resident set and then the writer, and no lock is held while a
//! listener runs. A listener that panics is caught and reported on stderr, so
//! the caller still gets its answer for a durable edit and the other listeners
//! still run. Listeners run on the caller's thread: [`Editor::apply_update`]'s,
//! any core writer's after its writer is released, and [`Editor::open`]'s,
//! [`Editor::state_vector`]'s and [`Editor::state_diff`]'s when a load repaired
//! the document. A shell never holds a lock a listener takes across these.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};

use rusqlite::Connection;
use yrs::updates::decoder::Decode as _;
use yrs::{ReadTxn as _, StateVector};

use crate::api::errors::{AuthError, StorageError};
use crate::api::tasks_write::now_ms;
use crate::crdt::errors::CrdtError;
use crate::crdt::markdown_seed::body_is_empty;
use crate::crdt::registry::{Document, UpdateSink};
use crate::crdt::resident::{EDITOR_LIFECYCLE, Resident};
use crate::crdt::{BODY_FRAGMENT, epoch, update_log};
use crate::crypto::keys;
use crate::domain::body_write::append_in;
use crate::domain::notes::journal_day::body_owner;
use crate::domain::{note_files, vault_locks};
use crate::markdown::convert::api::Converter;
use crate::markdown::schema::callout_types::CalloutTypes;
use crate::seams::secure_store::{SecureStore, SecureStoreKey};
use crate::storage::Db;
use crate::sync::{body_debt, outbox};

pub use crate::crdt::body_writes::Origin;
pub use crate::crdt::compact::Folded;
pub use compaction::COMPACTION_GROWTH_BYTES;
pub use listeners::{Listener, ListenerId, Notice};

use listeners::Listeners;

mod catch_up;
mod compaction;
mod listeners;

/// What a window receives when it opens a document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Opened {
    /// The whole document as one v1 update, every root included, the ones this
    /// build does not know as well (chapter 12 §12.5.1).
    pub state: Vec<u8>,
    pub state_vector: Vec<u8>,
    /// The body is empty and no server body is owed: the shell may seed it from
    /// the note's file. A note owed its server body is never seeded here: a seed
    /// shares no Yjs items with that body, and the merge would hold both (#2536).
    pub needs_seed: bool,
    /// Why the window must not edit it, when it must not.
    pub read_only: Option<ReadOnly>,
}

/// Why a document opens read-only.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadOnly {
    /// The note's file is large-file class, as the last read of it measured
    /// ([`crate::domain::note_files::is_large_file`]): the app shows it in the
    /// large-file viewer, and its document takes no edit.
    LargeFile,
    /// The note, or a folder above its file, is locked ([`crate::domain::vault_locks`]).
    Locked,
}

/// A stored edit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Applied {
    /// Its sequence in the document's local namespace.
    pub seq: i64,
    /// Its outbox row; `None` for a local-only note.
    pub outbox_id: Option<i64>,
}

/// Whether the documents' edits reach disk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Health {
    /// False when the vault's database opened read-only: every edit is then
    /// refused ([`Editor::apply_update`] fails), so it lives only in the window
    /// that typed it, and no other window or device sees it.
    pub persistent: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum EditorError {
    /// No live note or journal day has this id. Nothing was written.
    #[error("no live note or journal day {note_id}")]
    NotFound { note_id: String },
    /// The document's log does not replay. It does not open for editing until
    /// the app restarts; its text stays readable, and nothing was removed.
    #[error("the body of {note_id} cannot be replayed")]
    Unreadable { note_id: String },
    /// The note is locked: the edit was refused before anything was written. The text is
    /// Electron's `VAULT_LOCKED_NOTE_MESSAGE` (`packages/contracts/src/vault-locks-api.ts`):
    /// agents relay it verbatim and the renderer shows it localized.
    #[error("The owner made this note read-only.")]
    Locked { note_id: String },
    /// The note's file is large-file class: the edit was refused before
    /// anything was written. Electron has no text for it (its renderer never
    /// mounts an editor on a large file); this one is shown to the user.
    #[error("This note is too large to edit. It opens read-only.")]
    LargeFile { note_id: String },
    /// The window's copy is of a document since purged (a delete applied): it
    /// opens the document again before it edits. Nothing was written.
    #[error("{note_id} was deleted since this window opened it")]
    Purged { note_id: String },
    #[error(transparent)]
    Crdt(#[from] CrdtError),
}

impl From<StorageError> for EditorError {
    fn from(source: StorageError) -> Self {
        Self::Crdt(CrdtError::Storage { source })
    }
}

pub struct Editor {
    db: Db,
    device_id: String,
    resident: Mutex<Resident>,
    listeners: Mutex<Listeners>,
    /// Bytes each document's log took since its last compaction.
    grown: Mutex<HashMap<String, usize>>,
    /// The writer's read-only state, read once: it holds for the connection's
    /// life.
    read_only: OnceLock<bool>,
}

impl Editor {
    /// Built by [`crate::api::vault::Vault::editor`]. The device identity is the
    /// one core-authored writes go under, as for
    /// [`crate::api::external_feed::ExternalFeed`].
    pub(crate) fn over(db: Db, store: &Arc<dyn SecureStore>) -> Result<Self, AuthError> {
        let secret =
            store
                .get(SecureStoreKey::DeviceSigningKey)?
                .ok_or(AuthError::MalformedToken {
                    what: "this device has no signing key, so it has no identity to write under"
                        .to_string(),
                })?;
        let public = secret.get(32..64).ok_or(AuthError::MalformedToken {
            what: "device signing key is not 64 bytes".to_string(),
        })?;
        Ok(Self {
            db,
            device_id: keys::local_device_id_hex(public)?,
            resident: Mutex::new(Resident::new(EDITOR_LIFECYCLE)),
            listeners: Mutex::new(Listeners::default()),
            grown: Mutex::default(),
            read_only: OnceLock::new(),
        })
    }

    /// `holder` opens `note_id` and receives its state. A holder holds a
    /// document once however often it opens it.
    pub fn open(&self, note_id: &str, holder: &str) -> Result<Opened, EditorError> {
        let now = now_ms();
        let mut repaired = None;
        let mut resident = self.resident();
        let opened = self.on_writer(|conn| {
            if body_owner(conn, note_id)?.is_none() {
                return Err(not_found(note_id));
            }
            let held = resident
                .hold(note_id, holder, now, || {
                    self.load(conn, note_id, &mut repaired)
                })?
                .ok_or_else(|| unreadable(note_id))?;
            let document = &held.document;
            let opened = (|| {
                let read_only = read_only(conn, note_id)?;
                Ok(Opened {
                    state: document.encode_state()?,
                    state_vector: document.state_vector()?,
                    // A large file's text never seeds a document (`external_feed`).
                    needs_seed: read_only != Some(ReadOnly::LargeFile)
                        && body_is_empty(document)?
                        && !body_debt::is_owed(conn, note_id)?,
                    read_only,
                })
            })();
            match &opened {
                Ok(_) => resident.reopened(note_id, holder),
                Err(_) if held.added => {
                    resident.release(note_id, holder, now);
                }
                Err(_) => {}
            }
            opened
        });
        drop(resident);
        self.tell_repair(note_id, repaired);
        opened
    }

    /// Stores `update`, a window's edit, queues it for the other devices,
    /// applies it to the resident document and hands it to the listeners as
    /// [`Origin::Local`] of `holder`. `None`: the update changed nothing, and
    /// nothing was stored or sent. A note that opens read-only refuses it
    /// ([`EditorError::LargeFile`], [`EditorError::Locked`]) before anything is
    /// written or applied. See the module doc for the order.
    pub fn apply_update(
        &self,
        note_id: &str,
        update: &[u8],
        holder: &str,
    ) -> Result<Option<Applied>, EditorError> {
        let now = now_ms();
        let mut repaired = None;
        let applied = {
            let mut resident = self.resident();
            if resident.is_stale(note_id, holder) {
                return Err(EditorError::Purged {
                    note_id: note_id.to_owned(),
                });
            }
            self.on_writer(|conn| {
                let owner = body_owner(conn, note_id)?.ok_or_else(|| not_found(note_id))?;
                if let Some(why) = read_only(conn, note_id)? {
                    let note_id = note_id.to_owned();
                    return Err(match why {
                        ReadOnly::LargeFile => EditorError::LargeFile { note_id },
                        ReadOnly::Locked => EditorError::Locked { note_id },
                    });
                }
                let document = resident
                    .borrow(note_id, now, || self.load(conn, note_id, &mut repaired))?
                    .ok_or_else(|| unreadable(note_id))?;
                // A purge that committed while this edit waited for the writer,
                // before its observer fenced the holders: the edit is of the
                // deleted body (chapter 07 §7.15).
                if document.client_id() != epoch::client_id(conn, &self.device_id, note_id)? {
                    resident.purge(note_id);
                    return Err(EditorError::Purged {
                        note_id: note_id.to_owned(),
                    });
                }
                // Durable origin: the rows below hold these bytes, so the
                // document's own sink must not report them a second time.
                let changed = document
                    .apply_durable_update_changed(update)
                    .inspect_err(|_| resident.invalidate(note_id))?;
                if !changed {
                    return Ok(None);
                }
                let stored = (|| {
                    let tx = conn.transaction().map_err(storage)?;
                    let seq = update_log::append_local_update_in(&tx, note_id, update, now)?;
                    let change =
                        outbox::Change::crdt_update(owner.item_type, note_id, update.to_vec());
                    let outbox_id = outbox::enqueue(&tx, &change, now)?;
                    tx.commit().map_err(storage)?;
                    Ok(Applied { seq, outbox_id })
                })();
                if stored.is_err() {
                    resident.invalidate(note_id);
                }
                stored.map(Some)
            })
        };
        self.tell_repair(note_id, repaired);
        let applied = applied?;
        if applied.is_some() {
            let origin = Origin::Local(holder.to_owned());
            self.fan_out(note_id, Notice::Update(update, &origin));
        }
        Ok(applied)
    }

    /// `note_id`'s body was purged (a delete applied, chapter 07 §7.15): the
    /// resident copy goes, a log that did not replay may be tried again, and
    /// the listeners hear [`Notice::Purged`]. A day deleted and written again is
    /// a new document under the old id, which the next open replays. Until a
    /// holder opens it again, [`Editor::apply_update`] refuses its edits
    /// ([`EditorError::Purged`]): they are edits of the deleted body.
    pub fn purge(&self, note_id: &str) {
        self.resident().purge(note_id);
        self.fan_out(note_id, Notice::Purged);
    }

    /// The document's state vector, for the sync-step handshake.
    pub fn state_vector(&self, note_id: &str) -> Result<Vec<u8>, EditorError> {
        self.with_document(note_id, Document::state_vector)
    }

    /// What the document holds beyond `state_vector`: a window's sync step 1.
    pub fn state_diff(&self, note_id: &str, state_vector: &[u8]) -> Result<Vec<u8>, EditorError> {
        let theirs =
            StateVector::decode_v1(state_vector).map_err(|err| CrdtError::Undecodable {
                doc_id: note_id.to_owned(),
                what: err.to_string(),
            })?;
        self.with_document(note_id, |document| {
            document.read(|txn| txn.encode_diff_v1(&theirs))
        })
    }

    /// `holder` closes `note_id`. False when it did not hold it.
    pub fn release(&self, note_id: &str, holder: &str) -> bool {
        self.resident().release(note_id, holder, now_ms())
    }

    /// A window that is gone lets go of everything it held; returns those ids.
    pub fn release_holder(&self, holder: &str) -> Vec<String> {
        self.resident().release_holder(holder, now_ms())
    }

    /// Unloads the documents nobody has held for the grace period; returns them.
    pub fn sweep(&self, now_ms: i64) -> Vec<String> {
        self.resident().sweep(now_ms)
    }

    /// Whether the edits this host takes are stored (`crdt:get-health`).
    /// Waits for the writer on its first call only.
    pub fn health(&self) -> Result<Health, EditorError> {
        let read_only = match self.read_only.get() {
            Some(read_only) => *read_only,
            None => {
                let read_only =
                    self.on_writer(|conn| conn.is_readonly(rusqlite::MAIN_DB).map_err(storage))?;
                *self.read_only.get_or_init(|| read_only)
            }
        };
        Ok(Health {
            persistent: !read_only,
        })
    }

    /// Whether any holder has `note_id` open.
    pub fn is_open(&self, note_id: &str) -> bool {
        self.resident().is_held(note_id)
    }

    /// Every note some holder has open, sorted.
    pub fn open_note_ids(&self) -> Vec<String> {
        self.resident().held_ids()
    }

    /// Runs `read` on `note_id`'s document with the resident lock held, so no
    /// edit can find the document busy (see the module doc).
    fn with_document<T>(
        &self,
        note_id: &str,
        read: impl FnOnce(&Document) -> Result<T, CrdtError>,
    ) -> Result<T, EditorError> {
        let now = now_ms();
        let mut repaired = None;
        let mut resident = self.resident();
        let document = self.on_writer(|conn| {
            resident
                .borrow(note_id, now, || self.load(conn, note_id, &mut repaired))?
                .ok_or_else(|| unreadable(note_id))
        });
        // The writer is free again; the resident lock is still held.
        let read = document.and_then(|document| Ok(read(&document)?));
        drop(resident);
        self.tell_repair(note_id, repaired);
        read
    }

    /// `note_id` replayed from its log, its blocks without an id repaired
    /// (`repairEmptyBlockIds`: the editor crashes on mount without one). The
    /// repair is stored with its outbox row before the document is kept, and
    /// handed back in `repaired` for the listeners. It runs under the writer
    /// right after the replay, so its clock follows every committed update of
    /// this device. Nothing else authors through a resident document.
    ///
    /// A locked note is repaired too, as Electron repairs it
    /// (`crdt-provider.ts:933-940`): block ids are not the owner's text. Electron
    /// keeps its repair on the device (its update listener attaches after it);
    /// this one is queued, on purpose (#3531 14e-2): two devices repairing apart
    /// mint two ids for one block, and only the queued repair lets them settle on
    /// one, which a peer takes as it takes any remote edit of a locked note.
    fn load(
        &self,
        conn: &Connection,
        note_id: &str,
        repaired: &mut Option<Vec<u8>>,
    ) -> Result<Arc<Document>, CrdtError> {
        // One-shot: taken after the repair, so a later authored write would
        // be reported, never collected and silently left unstored.
        let authored: Arc<Mutex<Option<Vec<Vec<u8>>>>> = Arc::new(Mutex::new(Some(Vec::new())));
        let sink: UpdateSink = {
            let authored = Arc::clone(&authored);
            Arc::new(move |doc_id, bytes: &[u8]| {
                let mut authored = authored.lock().unwrap_or_else(PoisonError::into_inner);
                match authored.as_mut() {
                    Some(updates) => updates.push(bytes.to_vec()),
                    None => {
                        debug_assert!(false, "a resident document authored past its load");
                        eprintln!("memry editor: {doc_id} authored past its load; not stored");
                    }
                }
            })
        };
        let document = epoch::open_for_write(conn, &self.device_id, note_id, sink)?;
        self.count_loaded(conn, note_id)?;
        Converter::new(CalloutTypes::default()).repair_empty_block_ids(&document, BODY_FRAGMENT);
        let taken = authored
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        let Some(update) = taken.and_then(|mut updates| updates.pop()) else {
            return Ok(document);
        };
        let owner = body_owner(conn, note_id)?.ok_or_else(|| CrdtError::Storage {
            source: StorageError::Failed {
                what: format!("no live note or journal day {note_id} to repair"),
            },
        })?;
        let tx = conn.unchecked_transaction().map_err(storage_crdt)?;
        append_in(&tx, owner.item_type, note_id, &update, now_ms())?;
        tx.commit().map_err(storage_crdt)?;
        *repaired = Some(update);
        Ok(document)
    }

    /// Hands a repair made while loading `note_id` to its listeners.
    fn tell_repair(&self, note_id: &str, repaired: Option<Vec<u8>>) {
        if let Some(update) = repaired {
            self.fan_out(note_id, Notice::Update(&update, &Origin::System));
        }
    }

    /// The writer, untold: the editor fans its own writes out, and it holds
    /// the resident set here, which hearing of a write takes.
    fn on_writer<T>(
        &self,
        f: impl FnOnce(&mut Connection) -> Result<T, EditorError>,
    ) -> Result<T, EditorError> {
        self.db.call_blocking_untold(|conn| Ok(f(conn)))?
    }

    fn resident(&self) -> MutexGuard<'_, Resident> {
        self.resident.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Why `note_id` opens read-only, if it does. Read on the writer, in the
/// caller's turn: a class or a lock committed while an edit waited for the
/// writer refuses that edit.
fn read_only(conn: &Connection, note_id: &str) -> Result<Option<ReadOnly>, StorageError> {
    if note_files::is_large_file(conn, note_id)? {
        return Ok(Some(ReadOnly::LargeFile));
    }
    Ok(vault_locks::is_note_locked(conn, note_id, None)?.then_some(ReadOnly::Locked))
}

fn not_found(note_id: &str) -> EditorError {
    EditorError::NotFound {
        note_id: note_id.to_owned(),
    }
}

fn unreadable(note_id: &str) -> EditorError {
    EditorError::Unreadable {
        note_id: note_id.to_owned(),
    }
}

fn storage_crdt(error: rusqlite::Error) -> CrdtError {
    StorageError::Failed {
        what: error.to_string(),
    }
    .into()
}

fn storage(error: rusqlite::Error) -> EditorError {
    storage_crdt(error).into()
}
