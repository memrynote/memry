//! The vault tier over a real session, a temp vault and the shipped watcher, for the
//! end-to-end tests of the consumer and the write-back.

#![allow(dead_code, reason = "each test binary uses a part of it")]

use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use memry_core::api::vault::Vault;
use memry_core::crdt::body_edit::BlockEdit;
use memry_core::seams::secure_store::SecureStore;
use memry_desktop::registry::{AppConfig, VaultRegistry};
use memry_desktop::session::{OpenSource, Session};
use memry_desktop::vault::consumer::identity::{
    Adoption, Candidate, IdentityCtx, IdentityError, NoteIdentity, Removal,
};
use memry_desktop::vault::consumer::{Applied, VaultTier};
use tokio::sync::broadcast::Receiver;
use tokio::sync::broadcast::error::TryRecvError;

use crate::device_key;

pub const WAIT: Duration = Duration::from_secs(25);
pub const QUIET: Duration = Duration::from_millis(2500);

/// Makes a note for every file it is offered, and remembers which. Fails the first
/// `failures` offers.
pub struct Creates {
    pub store: Arc<dyn SecureStore>,
    pub offered: Mutex<Vec<String>>,
    pub failures: Mutex<usize>,
}

impl NoteIdentity for Creates {
    fn adopt_or_create(
        &self,
        ctx: &IdentityCtx<'_>,
        file: &Candidate<'_>,
    ) -> Result<Adoption, IdentityError> {
        self.offered.lock().unwrap().push(file.path.to_owned());
        {
            let mut failures = self.failures.lock().unwrap();
            if *failures > 0 {
                *failures -= 1;
                return Err(IdentityError::Other("not yet".into()));
            }
        }
        let writer = ctx
            .vault
            .notes_writer(self.store.clone())
            .map_err(|error| IdentityError::Other(error.to_string()))?;
        Ok(Adoption::Created(writer.create(file.path.into(), None)?))
    }

    fn on_removed(&self, _: &IdentityCtx<'_>, _: &str, _: &str) -> Result<Removal, IdentityError> {
        Ok(Removal::Kept)
    }

    fn on_renamed(
        &self,
        _: &IdentityCtx<'_>,
        _: &str,
        _: &str,
        _: &str,
    ) -> Result<(), IdentityError> {
        Ok(())
    }
}

pub struct Env {
    pub _dir: tempfile::TempDir,
    pub vault: PathBuf,
    pub session: Session,
    pub tier: Arc<VaultTier>,
    /// The open vault's database.
    pub core: Option<Arc<Vault>>,
    pub facts: Receiver<Applied>,
}

pub fn env(identity: impl FnOnce(Arc<dyn SecureStore>) -> Option<Arc<dyn NoteIdentity>>) -> Env {
    let dir = tempfile::tempdir().unwrap();
    let vault = dir.path().join("vault");
    fs::create_dir_all(&vault).unwrap();
    fs::create_dir_all(dir.path().join("app")).unwrap();
    let store = device_key::with_device_key();
    let registry = VaultRegistry::new(Arc::new(AppConfig::load(
        dir.path().join("app/memry-config.json"),
    )));
    let session = Session::new(registry);
    let tier = VaultTier::new(store.clone());
    if let Some(identity) = identity(store) {
        tier.set_identity(identity);
    }
    tier.register(&session);
    Env {
        facts: tier.subscribe(),
        _dir: dir,
        vault,
        session,
        tier,
        core: None,
    }
}

pub fn creates(store: Arc<dyn SecureStore>) -> Arc<Creates> {
    Arc::new(Creates {
        store,
        offered: Mutex::default(),
        failures: Mutex::new(0),
    })
}

impl Env {
    pub fn open(&mut self) {
        let opened = self.session.open(&self.vault, OpenSource::Select).unwrap();
        self.core = Some(opened.vault.vault.clone());
    }

    pub fn close(&mut self) {
        self.core = None;
        self.session.close();
    }

    pub fn write(&self, rel: &str, text: &str) {
        let path = self.vault.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    /// The facts up to and including the first that `until` accepts.
    pub fn facts_until(&mut self, until: impl Fn(&Applied) -> bool) -> Vec<Applied> {
        let deadline = Instant::now() + WAIT;
        let mut seen = Vec::new();
        loop {
            match self.facts.try_recv() {
                Ok(fact) => {
                    let done = until(&fact);
                    seen.push(fact);
                    if done {
                        return seen;
                    }
                }
                Err(TryRecvError::Empty) => {
                    assert!(Instant::now() < deadline, "still waiting after {seen:?}");
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(error) => panic!("{error}"),
            }
        }
    }

    pub fn drain(&mut self) -> Vec<Applied> {
        std::iter::from_fn(|| self.facts.try_recv().ok()).collect()
    }

    pub fn rows(&self) -> Vec<(String, String)> {
        let core = self.core.as_ref().expect("opened");
        let mut rows = core.note_files().list_paths().unwrap();
        rows.sort_by(|a, b| a.1.cmp(&b.1));
        rows
    }

    pub fn read(&self, rel: &str) -> String {
        fs::read_to_string(self.vault.join(rel)).unwrap()
    }

    pub fn core(&self) -> Arc<Vault> {
        self.core.clone().expect("opened")
    }

    /// The note's first block, retyped in the app's editor.
    pub fn edit_in_app(&self, store: &Arc<dyn SecureStore>, id: &str, text: &str) {
        edit_in_app(&self.core(), store, id, text);
    }

    /// The text of the note's body, block by block.
    pub fn body(&self, id: &str) -> String {
        let blocks = self.core().notes().blocks(id.to_owned()).unwrap().unwrap();
        blocks
            .iter()
            .map(|b| {
                b.inline
                    .iter()
                    .map(|run| run.text.as_str())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// The versions kept for the note.
    pub fn versions(&self, id: &str) -> Vec<String> {
        let id = id.to_owned();
        self.core()
            .db_handle()
            .call_blocking(move |conn| {
                let mut statement = conn
                    .prepare("SELECT content FROM note_snapshots WHERE note_id = ?1")
                    .unwrap();
                Ok(statement
                    .query_map([id], |row| row.get(0))
                    .unwrap()
                    .collect::<Result<Vec<String>, _>>()
                    .unwrap())
            })
            .unwrap()
    }
}

/// The note's first block, retyped in the app's editor.
pub fn edit_in_app(core: &Vault, store: &Arc<dyn SecureStore>, id: &str, text: &str) {
    let blocks = core.notes().blocks(id.to_owned()).unwrap().unwrap();
    let block_id = blocks
        .iter()
        .find_map(|b| b.id.clone())
        .expect("a block id");
    let edit = BlockEdit::SetText {
        block_id,
        text: text.to_owned(),
    };
    let writer = core.notes_writer(store.clone()).unwrap();
    assert!(writer.edit_block(id.to_owned(), edit).unwrap());
}

pub fn indexed(fact: &Applied) -> bool {
    matches!(fact, Applied::Indexed { .. })
}
