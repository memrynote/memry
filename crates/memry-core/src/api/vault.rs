//! The opened vault, and the read-only `Notes` reached through it (T164,
//! band B3's `Vault` and `Notes` minimum, spec-defect 114).
//!
//! **Read-only.** Nothing here writes a row, enqueues an outbox change, or
//! drives a sync pass. Pull-then-push is the core's and stays the core's: a
//! shell that could run half of it would be a second sync client, and the
//! ordering a half-pass breaks is not recoverable from the shell (chapter 05).
//!
//! ## Why two objects rather than one
//!
//! `contracts/core-api.md`'s band B3 table names `Vault` — "the unlocked vault
//! key, vault selection, vault metadata" — and `Notes` — "notes, folders,
//! journals, templates, tags, properties" — as separate objects, and they stay
//! separate here for a reason that outlives this slice: everything the write
//! half adds lands on `Notes`. Create, rename, move and delete already exist in
//! `domain::notes` and `domain::folders`, and journals, templates, tags and
//! properties each have a module of their own. Folded into `Vault`, they would
//! make one object that owns the database handle, the vault key and every
//! content mutation in the product, and would pass this repository's 600-line
//! ceiling before the first journal method.
//!
//! The usual counter-argument does not apply. `AuthSession` refuses a second
//! object over the same account because a second `TokenManager` over the same
//! keychain entries is a device revocation waiting to happen (chapter 02 §2.9),
//! and there is no equivalent here: [`Db`] is a handle to **one** connection
//! behind **one** mutex, cloning it shares both, and [`Vault::notes`] hands out
//! a clone rather than opening a second connection to the same file. Two
//! objects, one connection.
//!
//! **No key crosses.** A read of the local projections and the local update log
//! needs no vault key at all — decryption happened when the records were pulled
//! — so this slice never holds one, and `core-api.md`'s "none of the B3 objects
//! exposes a key" is kept by having nothing to expose. When the write half
//! arrives and a push must seal, the key belongs on `Vault` and still does not
//! cross: the cost of this shape is that `Vault` then holds it and `Notes` asks
//! `Vault` to seal, rather than each object carrying its own copy.

use std::path::PathBuf;
use std::sync::Arc;

use crate::api::auth::AuthSession;
use crate::api::errors::{AuthError, StorageError};
use crate::api::inbox::Inbox;
use crate::api::journal::Journal;
use crate::api::notes::Notes;
use crate::api::notes_write::NotesWriter;
use crate::api::search::Search;
use crate::api::sync::VaultSync;
use crate::api::tasks::Tasks;
use crate::seams::secure_store::SecureStore;
use crate::storage::{Db, open_data};

/// One vault's local database, opened.
///
/// Every method blocks (spec-defect 90): these are local SQLite reads, so the
/// shell moves them onto its serial core queue rather than awaiting them. None
/// of them suspends, which also means none of them can be left uncancellable —
/// `rust_future_cancel` does not appear in the bindings at all (defect 108),
/// and a blocking call never needed it.
#[derive(uniffi::Object)]
pub struct Vault {
    id: String,
    db: Db,
    /// Kept because `index.db` lives beside `data.db` and is opened later, on
    /// demand: the index is a cache of the vault (data-model §A.5) and a
    /// vault that is never searched must not pay for it at open.
    directory: String,
}

impl Vault {
    /// The database handle, for integration tests that seed a peer's records
    /// through the real apply path. Not on the FFI surface.
    #[doc(hidden)]
    pub fn db_handle(&self) -> Db {
        self.db.clone()
    }
}

#[uniffi::export]
impl Vault {
    /// Opens `data.db` under `directory`, creating and migrating it on first
    /// use.
    ///
    /// The shell supplies the directory because only the shell knows its
    /// sandbox; the **file name inside it** stays the core's, because the
    /// two-database layout of data-model §A.0 is core-owned and a shell that
    /// named the file could point two vaults at one database.
    ///
    /// Migrations are forward only and keep every row they find (§A.0). This is
    /// the call that runs them, which is why it is not free.
    ///
    /// `vault_id` is recorded rather than derived from the path. A directory
    /// name is a shell convention; the id is chapter 05 §5.1's, and it is what
    /// `X-Memry-Vault-Id` will carry.
    #[uniffi::constructor]
    pub fn open(vault_id: String, directory: String) -> Result<Self, StorageError> {
        let db = open_data(&PathBuf::from(&directory).join("data.db"))?;
        Ok(Self {
            id: vault_id,
            db,
            directory,
        })
    }

    /// The id this vault was opened under, so a handle passed around the shell
    /// says which vault it is rather than relying on the caller to remember.
    pub fn id(&self) -> String {
        self.id.clone()
    }

    /// The read-only sync that **fills** this vault's database (T236,
    /// spec-defect 136).
    ///
    /// Takes the session rather than holding one, so [`Vault::open`] stays a
    /// local, offline, blocking open. The session supplies the authenticated
    /// client and the master key; nothing of either crosses the FFI.
    ///
    /// Building this makes no request and takes no lock.
    pub fn sync(&self, session: Arc<AuthSession>) -> Arc<VaultSync> {
        Arc::new(VaultSync::over(
            self.id.clone(),
            self.db.clone(),
            session,
            self.directory.clone(),
        ))
    }

    /// The note and folder reads over **this** vault's database.
    ///
    /// A clone of the same handle, not a second connection: see the module doc.
    pub fn notes(&self) -> Arc<Notes> {
        Arc::new(Notes::over(self.db.clone()))
    }

    /// The note **writes** over this vault's database.
    ///
    /// Separate from [`Vault::notes`] and not free, because a write needs a
    /// device identity and a read does not: the store is read once here to
    /// derive it, so the per-write path stays a local SQLite call.
    ///
    /// Fails rather than writing under a borrowed identity when the keychain
    /// is locked or this device has never registered. Either way nothing is
    /// written, so there is nothing for the shell to undo.
    pub fn notes_writer(&self, store: Arc<dyn SecureStore>) -> Result<Arc<NotesWriter>, AuthError> {
        Ok(Arc::new(NotesWriter::over(self.db.clone(), &store)?))
    }

    /// Every task, project, saved filter, reminder and activity read and write
    /// over this vault (spec 004). Needs the keychain for the same reason
    /// [`Vault::notes_writer`] does: a write ticks this device's clock.
    pub fn tasks(&self, store: Arc<dyn SecureStore>) -> Result<Arc<Tasks>, AuthError> {
        Ok(Arc::new(Tasks::over(self.db.clone(), &store)?))
    }

    /// The synced settings item over this vault (spec 006 ST10). Needs the
    /// keychain for the device identity its writes tick.
    pub fn settings(
        &self,
        store: Arc<dyn SecureStore>,
    ) -> Result<Arc<crate::api::settings::Settings>, AuthError> {
        Ok(Arc::new(crate::api::settings::Settings::over(
            self.db.clone(),
            &store,
        )?))
    }

    /// The journal: days read and written by calendar date (spec
    /// 005-journal). Needs the keychain for the same reason
    /// [`Vault::notes_writer`] does: a write ticks this device's clock.
    pub fn journal(&self, store: Arc<dyn SecureStore>) -> Result<Arc<Journal>, AuthError> {
        Ok(Arc::new(Journal::over(self.db.clone(), &store)?))
    }

    /// Every inbox read and write over this vault (spec 006). Needs the
    /// keychain for the same reason [`Vault::tasks`] does.
    pub fn inbox(&self, store: Arc<dyn SecureStore>) -> Result<Arc<Inbox>, AuthError> {
        Ok(Arc::new(Inbox::over(self.db.clone(), &store)?))
    }

    /// The full-text search over this vault.
    ///
    /// **Opens `index.db`, which [`Vault::open`] does not**, and rebuilds it
    /// when the file cannot be trusted — so this one is not free, and a vault
    /// that is never searched never opens it. Hold the handle rather than
    /// rebuilding it per keystroke.
    pub fn search(&self) -> Result<Arc<Search>, StorageError> {
        Ok(Arc::new(Search::over(self.db.clone(), &self.directory)?))
    }
}
