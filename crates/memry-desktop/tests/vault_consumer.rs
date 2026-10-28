//! The vault tier end to end: a session opens a vault, the watcher reports, the consumer
//! applies, and the facts it publishes say what the rows hold. The single-fact rules are the
//! unit tests in `src/vault/consumer/tests.rs`; these cover what only the running pair does:
//! the order of the start rescan and the open walk, and the stop with the vault.

use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use memry_core::api::vault::Vault;
use memry_core::crdt::body_edit::BlockEdit;
use memry_core::crypto::sodium;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_desktop::profile_store::ProfileDeviceKeyStore;
use memry_desktop::registry::{AppConfig, VaultRegistry};
use memry_desktop::session::{OpenSource, Session};
use memry_desktop::vault::consumer::identity::{
    Adoption, Candidate, IdentityCtx, IdentityError, NoteIdentity, Removal,
};
use memry_desktop::vault::consumer::rows::{RowError, RowStat};
use memry_desktop::vault::consumer::{Applied, ChangeSource, VaultTier};
use memry_desktop::vault::file_types::FileType;
use memry_desktop::vault::watch::VaultEvent;
use tokio::sync::broadcast::Receiver;
use tokio::sync::broadcast::error::TryRecvError;

const WAIT: Duration = Duration::from_secs(25);
const QUIET: Duration = Duration::from_millis(2500);

/// Makes a note for every file it is offered, and remembers which. Fails the first
/// `failures` offers.
struct Creates {
    store: Arc<dyn SecureStore>,
    offered: Mutex<Vec<String>>,
    failures: Mutex<usize>,
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

struct Env {
    _dir: tempfile::TempDir,
    vault: PathBuf,
    session: Session,
    tier: Arc<VaultTier>,
    /// The open vault's database.
    core: Option<Arc<Vault>>,
    facts: Receiver<Applied>,
}

fn env(identity: impl FnOnce(Arc<dyn SecureStore>) -> Option<Arc<dyn NoteIdentity>>) -> Env {
    let dir = tempfile::tempdir().unwrap();
    let vault = dir.path().join("vault");
    fs::create_dir_all(&vault).unwrap();
    fs::create_dir_all(dir.path().join("app")).unwrap();
    let store = ProfileDeviceKeyStore::shared(&dir.path().join("app"));
    let (_, secret) = sodium::sign_seed_keypair(&[7u8; 32]).unwrap();
    store
        .set(SecureStoreKey::DeviceSigningKey, secret.to_vec())
        .unwrap();
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

fn creates(store: Arc<dyn SecureStore>) -> Arc<Creates> {
    Arc::new(Creates {
        store,
        offered: Mutex::default(),
        failures: Mutex::new(0),
    })
}

impl Env {
    fn open(&mut self) {
        let opened = self.session.open(&self.vault, OpenSource::Select).unwrap();
        self.core = Some(opened.vault.vault.clone());
    }

    fn close(&mut self) {
        self.core = None;
        self.session.close();
    }

    fn write(&self, rel: &str, text: &str) {
        let path = self.vault.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    /// The facts up to and including the first that `until` accepts.
    fn facts_until(&mut self, until: impl Fn(&Applied) -> bool) -> Vec<Applied> {
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

    fn drain(&mut self) -> Vec<Applied> {
        std::iter::from_fn(|| self.facts.try_recv().ok()).collect()
    }

    fn rows(&self) -> Vec<(String, String)> {
        let core = self.core.as_ref().expect("opened");
        let mut rows = core.note_files().list_paths().unwrap();
        rows.sort_by(|a, b| a.1.cmp(&b.1));
        rows
    }
}

fn indexed(fact: &Applied) -> bool {
    matches!(fact, Applied::Indexed { .. })
}

fn position(facts: &[Applied], what: impl Fn(&Applied) -> bool) -> usize {
    facts
        .iter()
        .position(what)
        .unwrap_or_else(|| panic!("not in {facts:?}"))
}

/// The open walk offers the files no row names. Run before the start rescan's removals and
/// moves are applied, it would take a file moved while the app was closed for a new note and
/// give it a second id beside the one its row still holds.
#[test]
fn a_file_moved_while_closed_keeps_its_note_and_the_walk_offers_only_new_files() {
    let identity = Mutex::new(None);
    let mut e = env(|store| {
        let made = creates(store);
        *identity.lock().unwrap() = Some(made.clone());
        Some(made)
    });
    let identity = identity.into_inner().unwrap().unwrap();
    e.write("old.md", "a note that will move\n");
    e.open();
    e.facts_until(indexed);
    let before = e.rows();
    assert_eq!(before.len(), 1, "{before:?}");
    let id = before[0].0.clone();
    e.close();

    fs::create_dir_all(e.vault.join("dir")).unwrap();
    fs::rename(e.vault.join("old.md"), e.vault.join("dir/moved.md")).unwrap();
    e.write("fresh.md", "new while closed\n");
    e.drain();
    e.open();
    let facts = e.facts_until(indexed);
    let renamed = position(
        &facts,
        |f| matches!(f, Applied::Renamed { new_path, .. } if new_path == "dir/moved.md"),
    );
    let rescanned = position(&facts, |f| {
        matches!(f, Applied::Vault(VaultEvent::Rescanned { .. }))
    });
    assert!(renamed < rescanned, "{facts:?}");
    assert!(
        facts
            .iter()
            .any(|f| matches!(f, Applied::Added { path, created: true, .. } if path == "fresh.md"))
    );
    assert_eq!(
        *identity.offered.lock().unwrap(),
        vec!["old.md".to_owned(), "fresh.md".to_owned()],
        "a moved file was offered as a new one"
    );
    let rows = e.rows();
    assert_eq!(rows.len(), 2, "{rows:?}");
    assert!(rows.contains(&(id, "dir/moved.md".to_owned())), "{rows:?}");
}

#[test]
fn a_file_written_while_open_gets_a_note_and_the_tier_stops_with_the_vault() {
    let mut e = env(|store| Some(creates(store) as Arc<dyn NoteIdentity>));
    e.open();
    e.facts_until(indexed);
    std::thread::sleep(Duration::from_millis(300));
    e.write("hello.md", "hi\n");
    e.facts_until(|f| matches!(f, Applied::Added { path, .. } if path == "hello.md"));
    let session = e.tier.rows().session_for(e.core.as_ref().unwrap()).unwrap();
    e.close();

    e.write("late.md", "x\n");
    std::thread::sleep(QUIET);
    assert!(
        e.drain().is_empty(),
        "the tier kept working after the close"
    );
    let stat = RowStat {
        file_type: FileType::Markdown,
        size: 1,
        content_hash: None,
    };
    assert!(
        matches!(
            e.tier.rows().reserve(session, "n1", "late.md", stat),
            Err(RowError::Closed)
        ),
        "a row was written into a closed vault"
    );
    // The next open's walk finds what was written while the vault was closed.
    e.open();
    e.facts_until(|f| matches!(f, Applied::Added { path, .. } if path == "late.md"));
    e.facts_until(indexed);
    std::thread::sleep(Duration::from_millis(300));
    e.write("again.md", "y\n");
    e.facts_until(|f| matches!(f, Applied::Added { path, .. } if path == "again.md"));
}

/// What ships until Step 13 sets its identity: the tier runs and indexes nothing, as the app
/// behaved before it.
#[test]
fn the_shipped_tier_records_no_row_until_step_13_names_notes() {
    let mut e = env(|_| None);
    e.write("a.md", "x\n");
    e.open();
    let facts = e.facts_until(indexed);
    assert!(
        facts.contains(&Applied::Indexed { complete: false }),
        "{facts:?}"
    );
    assert!(
        !facts.iter().any(|f| matches!(f, Applied::Added { .. })),
        "{facts:?}"
    );
    assert!(e.rows().is_empty());
}

/// A file whose note could not be named is reported again by the watcher, after a delay that
/// doubles, until it gets its note.
#[test]
fn a_file_whose_note_could_not_be_named_is_offered_again_until_it_has_one() {
    let identity = Mutex::new(None);
    let mut e = env(|store| {
        let made = creates(store);
        *made.failures.lock().unwrap() = 2;
        *identity.lock().unwrap() = Some(made.clone());
        Some(made)
    });
    let identity = identity.into_inner().unwrap().unwrap();
    e.open();
    e.facts_until(indexed);
    std::thread::sleep(Duration::from_millis(300));
    e.write("a.md", "x\n");
    e.facts_until(|f| matches!(f, Applied::Added { path, .. } if path == "a.md"));
    assert_eq!(identity.offered.lock().unwrap().len(), 3);
    assert_eq!(e.rows().len(), 1);
}

/// The write-back seam end to end: an edit made in the app, scheduled the way the editor and
/// the sync driver do, reaches the file, and the watcher takes that write for the app's own.
#[test]
fn a_scheduled_edit_reaches_the_file_and_the_watcher_takes_it_for_the_apps() {
    let identity = Mutex::new(None);
    let mut e = env(|store| {
        let made = creates(store);
        *identity.lock().unwrap() = Some(made.clone());
        Some(made)
    });
    let identity = identity.into_inner().unwrap().unwrap();
    e.write("n.md", "first words\n");
    e.open();
    e.facts_until(indexed);
    let id = e.rows()[0].0.clone();
    let core = e.core.clone().unwrap();
    let blocks = core.notes().blocks(id.clone()).unwrap().unwrap();
    let block_id = blocks
        .iter()
        .find_map(|b| b.id.clone())
        .expect("a block id");
    let edit = BlockEdit::SetText {
        block_id,
        text: "typed in the app".into(),
    };
    let writer = core.notes_writer(identity.store.clone()).unwrap();
    assert!(writer.edit_block(id.clone(), edit).unwrap());

    e.tier.schedule(&id);
    e.facts_until(|f| {
        matches!(f, Applied::Changed { note_id, source: ChangeSource::App, .. } if *note_id == id)
    });
    assert_eq!(
        fs::read_to_string(e.vault.join("n.md")).unwrap(),
        "typed in the app\n"
    );
    std::thread::sleep(QUIET);
    let later = e.drain();
    assert!(
        !later.iter().any(|f| matches!(
            f,
            Applied::Changed {
                source: ChangeSource::Watcher,
                ..
            }
        )),
        "the app's write came back as an outside edit: {later:?}"
    );
    e.close();
    e.tier.schedule(&id);
}
