//! `Editor`: the note and journal documents editor windows type into (desktop
//! Step 14, #3531). Reached from [`crate::api::vault::Vault::editor`]. Not
//! exported over UniFFI: iOS edits bodies through its own path.
//!
//! One owner per vault holds every resident document ([`Resident`]). A window
//! opens a document and receives its whole state; each edit it sends comes back
//! here as a Yjs update, and [`Editor::apply_update`] stores it, queues it for
//! the other devices and applies it to the resident document, then hands it to
//! every listener of that document with its [`Origin`], so the other windows
//! catch up. Writers that commit body bytes elsewhere (a sync merge, a fed
//! outside edit) pass them to [`Editor::absorb`] after their commit.
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
//! **Every `yrs` transaction on a resident document runs under the resident
//! lock**, reads included ([`Editor::with_document`]). `yrs` does not wait for a
//! busy document, it refuses (`DocumentBusy`): a read outside the lock made a
//! concurrent edit fail, and the window's later edits, which depend on it, then
//! waited forever in the document's pending set. Holding the lock through the
//! commit also keeps a reader from seeing an edit whose commit then fails.
//!
//! The host has no threads and no clock of its own: the shell calls
//! [`Editor::sweep`] on its timer. Every method blocks on the vault's writer
//! connection; the shell runs them in `spawn_blocking`. Locks are taken in one
//! order, the resident set and then the writer, and no lock is held while a
//! listener runs. A listener that panics is caught and reported on stderr, so
//! the caller still gets its answer for a durable edit and the other listeners
//! still run.

use std::collections::HashMap;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use rusqlite::Connection;
use yrs::updates::decoder::Decode as _;
use yrs::{ReadTxn as _, StateVector};

use crate::api::errors::{AuthError, StorageError};
use crate::api::tasks_write::now_ms;
use crate::crdt::errors::CrdtError;
use crate::crdt::markdown_seed::body_is_empty;
use crate::crdt::registry::Document;
use crate::crdt::resident::{EDITOR_LIFECYCLE, Resident};
use crate::crdt::{epoch, update_log};
use crate::crypto::keys;
use crate::domain::notes::journal_day::body_owner;
use crate::seams::secure_store::{SecureStore, SecureStoreKey};
use crate::storage::Db;
use crate::sync::{body_debt, outbox};

/// Where an update came from, for the windows it reaches.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Origin {
    /// A window's edit; the holder is the window that sent it, which the shell
    /// does not send it back to.
    Local(String),
    /// Merged from the server.
    Remote,
    /// An edit made to the vault file outside the app.
    External,
    /// Written by the app itself (seed, repair, restore).
    System,
}

impl Origin {
    fn kind(&self) -> &'static str {
        match self {
            Self::Local(_) => "local",
            Self::Remote => "remote",
            Self::External => "external",
            Self::System => "system",
        }
    }
}

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
}

/// A stored edit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Applied {
    /// Its sequence in the document's local namespace.
    pub seq: i64,
    /// Its outbox row; `None` for a local-only note.
    pub outbox_id: Option<i64>,
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
    #[error(transparent)]
    Crdt(#[from] CrdtError),
}

impl From<StorageError> for EditorError {
    fn from(source: StorageError) -> Self {
        Self::Crdt(CrdtError::Storage { source })
    }
}

/// Called with each update a document took, after its commit.
pub type Listener = Arc<dyn Fn(&[u8], &Origin) + Send + Sync>;

/// Names a listener for [`Editor::unsubscribe`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ListenerId(u64);

#[derive(Default)]
struct Listeners {
    next: u64,
    by_doc: HashMap<String, Vec<(ListenerId, Listener)>>,
}

pub struct Editor {
    db: Db,
    device_id: String,
    resident: Mutex<Resident>,
    listeners: Mutex<Listeners>,
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
        })
    }

    /// `holder` opens `note_id` and receives its state. A holder holds a
    /// document once however often it opens it.
    pub fn open(&self, note_id: &str, holder: &str) -> Result<Opened, EditorError> {
        let now = now_ms();
        let mut resident = self.resident();
        self.on_writer(|conn| {
            if body_owner(conn, note_id)?.is_none() {
                return Err(not_found(note_id));
            }
            let held = resident
                .hold(note_id, holder, now, || self.load(conn, note_id))?
                .ok_or_else(|| unreadable(note_id))?;
            let document = &held.document;
            let opened = (|| {
                Ok(Opened {
                    state: document.encode_state()?,
                    state_vector: document.state_vector()?,
                    needs_seed: body_is_empty(document)? && !body_debt::is_owed(conn, note_id)?,
                })
            })();
            if opened.is_err() && held.added {
                resident.release(note_id, holder, now);
            }
            opened
        })
    }

    /// Stores `update`, a window's edit, queues it for the other devices,
    /// applies it to the resident document and hands it to the listeners as
    /// [`Origin::Local`] of `holder`. `None`: the update changed nothing, and
    /// nothing was stored or sent. See the module doc for the order.
    pub fn apply_update(
        &self,
        note_id: &str,
        update: &[u8],
        holder: &str,
    ) -> Result<Option<Applied>, EditorError> {
        let now = now_ms();
        let applied = {
            let mut resident = self.resident();
            self.on_writer(|conn| {
                let owner = body_owner(conn, note_id)?.ok_or_else(|| not_found(note_id))?;
                let document = resident
                    .borrow(note_id, now, || self.load(conn, note_id))?
                    .ok_or_else(|| unreadable(note_id))?;
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
            })?
        };
        if applied.is_some() {
            self.fan_out(note_id, update, &Origin::Local(holder.to_owned()));
        }
        Ok(applied)
    }

    /// Bytes another writer already committed to `note_id`'s log: applied to
    /// the resident document, when there is one, and handed to the listeners.
    /// A document not in memory takes them from the log when it loads. Call it
    /// after the commit, with the writer connection released: it takes the
    /// resident set, and [`Editor::apply_update`] holds that while it waits for
    /// the writer.
    pub fn absorb(&self, note_id: &str, update: &[u8], origin: Origin) -> Result<(), EditorError> {
        {
            let mut resident = self.resident();
            if let Some(document) = resident.peek(note_id)
                && let Err(error) = document.apply_durable_update(update)
            {
                resident.invalidate(note_id);
                return Err(error.into());
            }
        }
        self.fan_out(note_id, update, &origin);
        Ok(())
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

    /// Whether any holder has `note_id` open.
    pub fn is_open(&self, note_id: &str) -> bool {
        self.resident().is_held(note_id)
    }

    /// Every note some holder has open, sorted.
    pub fn open_note_ids(&self) -> Vec<String> {
        self.resident().held_ids()
    }

    /// Calls `listener` with every update `note_id` takes, after its commit.
    pub fn subscribe(
        &self,
        note_id: &str,
        listener: impl Fn(&[u8], &Origin) + Send + Sync + 'static,
    ) -> ListenerId {
        let mut listeners = self.listeners();
        listeners.next += 1;
        let id = ListenerId(listeners.next);
        listeners
            .by_doc
            .entry(note_id.to_owned())
            .or_default()
            .push((id, Arc::new(listener)));
        id
    }

    /// Stops a listener. False when it was not subscribed.
    pub fn unsubscribe(&self, id: ListenerId) -> bool {
        let mut listeners = self.listeners();
        let mut found = false;
        listeners.by_doc.retain(|_, list| {
            let before = list.len();
            list.retain(|(each, _)| *each != id);
            found |= list.len() != before;
            !list.is_empty()
        });
        found
    }

    fn fan_out(&self, note_id: &str, update: &[u8], origin: &Origin) {
        let listeners: Vec<Listener> = self
            .listeners()
            .by_doc
            .get(note_id)
            .map(|list| list.iter().map(|(_, f)| Arc::clone(f)).collect())
            .unwrap_or_default();
        for listener in listeners {
            if catch_unwind(AssertUnwindSafe(|| listener(update, origin))).is_err() {
                eprintln!(
                    "memry editor: a listener of {note_id} panicked on a {} update",
                    origin.kind()
                );
            }
        }
    }

    /// Runs `read` on `note_id`'s document with the resident lock held, so no
    /// edit can find the document busy (see the module doc).
    fn with_document<T>(
        &self,
        note_id: &str,
        read: impl FnOnce(&Document) -> Result<T, CrdtError>,
    ) -> Result<T, EditorError> {
        let now = now_ms();
        let mut resident = self.resident();
        let document = self.on_writer(|conn| {
            resident
                .borrow(note_id, now, || self.load(conn, note_id))?
                .ok_or_else(|| unreadable(note_id))
        })?;
        // The writer is free again; the resident lock is still held.
        let read = read(&document)?;
        drop(resident);
        Ok(read)
    }

    /// `note_id` replayed from its log. Nothing authors through a resident
    /// document: every byte it takes is already in the log, so its sink is empty.
    fn load(&self, conn: &Connection, note_id: &str) -> Result<Arc<Document>, CrdtError> {
        epoch::open_for_write(conn, &self.device_id, note_id, Arc::new(|_, _| {}))
    }

    fn on_writer<T>(
        &self,
        f: impl FnOnce(&mut Connection) -> Result<T, EditorError>,
    ) -> Result<T, EditorError> {
        self.db.call_blocking(|conn| Ok(f(conn)))?
    }

    fn resident(&self) -> MutexGuard<'_, Resident> {
        self.resident.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn listeners(&self) -> MutexGuard<'_, Listeners> {
        self.listeners
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }
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

fn storage(error: rusqlite::Error) -> EditorError {
    StorageError::Failed {
        what: error.to_string(),
    }
    .into()
}
