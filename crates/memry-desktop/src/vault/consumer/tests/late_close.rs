//! A close hook that ends after its deadline: the session has opened the next vault by then,
//! and the late stop must touch only what belonged to the vault it stopped.

use std::sync::Condvar;
use std::time::{Duration, Instant};

use memry_core::crdt::body_edit::BlockEdit;

use super::super::rows::RowError;
use super::*;
use crate::registry::{AppConfig, VaultRegistry};
use crate::session::{OpenSource, Session};
use crate::vault::consumer::{Hold, VaultTier};

const WAIT: Duration = Duration::from_secs(20);

/// A note for every new file.
struct MakesNotes(Arc<dyn SecureStore>);

impl NoteIdentity for MakesNotes {
    fn adopt_or_create(
        &self,
        ctx: &IdentityCtx<'_>,
        file: &Candidate<'_>,
    ) -> Result<Adoption, IdentityError> {
        let writer = ctx
            .vault
            .notes_writer(self.0.clone())
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

fn eventually<T>(what: &str, mut probe: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + WAIT;
    loop {
        if let Some(value) = probe() {
            return value;
        }
        assert!(Instant::now() < deadline, "never: {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Two vaults, `a` empty and `b` with one file, on one session whose close hooks get 300 ms.
struct Two {
    _dir: tempfile::TempDir,
    a: PathBuf,
    b: PathBuf,
    session: Session,
    store: Arc<dyn SecureStore>,
    tier: Arc<VaultTier>,
}

fn two() -> Two {
    let dir = tempfile::tempdir().unwrap();
    let (a, b) = (dir.path().join("a"), dir.path().join("b"));
    std::fs::create_dir_all(&a).unwrap();
    std::fs::create_dir_all(&b).unwrap();
    std::fs::write(b.join("n.md"), "first words\n").unwrap();
    let registry = VaultRegistry::new(Arc::new(AppConfig::load(
        dir.path().join("memry-config.json"),
    )));
    let session = Session::with_hook_deadline(registry, Duration::from_millis(300));
    let store = with_device_key();
    let tier = VaultTier::new(store.clone());
    tier.set_identity(Arc::new(MakesNotes(store.clone())));
    tier.register(&session);
    Two {
        _dir: dir,
        a,
        b,
        session,
        store,
        tier,
    }
}

/// A stop held at `at` until it is let go, and whether it went on after that.
struct Gate {
    open: Arc<(Mutex<bool>, Condvar)>,
    resumed: Arc<AtomicBool>,
}

impl Gate {
    fn at(tier: &VaultTier, at: Hold) -> Self {
        let gate = Self {
            open: Arc::default(),
            resumed: Arc::default(),
        };
        let (open, resumed) = (gate.open.clone(), gate.resumed.clone());
        tier.hold_at(at, move || {
            let (done, signal) = &*open;
            let held = done.lock().unwrap();
            let _ = signal
                .wait_timeout_while(held, WAIT, |done| !*done)
                .unwrap();
            resumed.store(true, Ordering::SeqCst);
        });
        gate
    }

    /// Lets the stop go on and gives it time to finish.
    fn release(self) {
        let (done, signal) = &*self.open;
        *done.lock().unwrap() = true;
        signal.notify_all();
        eventually("the held stop", || {
            self.resumed.load(Ordering::SeqCst).then_some(())
        });
        // What the late stop does after the hold.
        std::thread::sleep(Duration::from_millis(500));
    }
}

/// Closes `a` with its close hook held at `at` past its deadline, opens `b`, lets the hook go
/// on, then checks `b`'s rows are open, its own-write record kept and its write-back writes.
fn a_late_close_of_a_leaves_b_alone(at: Hold) {
    let t = two();
    t.session.open(&t.a, OpenSource::Select).unwrap();
    let gate = Gate::at(&t.tier, at);
    t.session.close();
    let opened = t.session.open(&t.b, OpenSource::Select).unwrap();
    let vault = opened.vault.vault.clone();
    let id = eventually("B's note", || {
        vault
            .note_files()
            .by_path("n.md")
            .unwrap()
            .filter(|row| row.content_hash.is_some())
            .map(|row| row.note_id)
    });
    t.tier.echo().will_write("probe.md", "h");
    gate.release();

    assert!(
        t.tier.rows().session_for(&vault).is_ok(),
        "A's late stop closed B's rows"
    );
    assert_eq!(
        t.tier.echo().expected_hash("probe.md").as_deref(),
        Some("h"),
        "A's late stop dropped B's own-write record"
    );
    let blocks = vault.notes().blocks(id.clone()).unwrap().unwrap();
    let block_id = blocks.iter().find_map(|b| b.id.clone()).unwrap();
    let edit = BlockEdit::SetText {
        block_id,
        text: "typed in B".into(),
    };
    let writer = vault.notes_writer(t.store.clone()).unwrap();
    assert!(writer.edit_block(id.clone(), edit).unwrap());
    t.tier.schedule(&id);
    assert!(t.tier.flush(WAIT));
    assert_eq!(
        std::fs::read_to_string(t.b.join("n.md")).unwrap(),
        "typed in B\n",
        "A's late stop stopped B's write-back"
    );
    t.session.close();
}

#[test]
fn a_close_held_after_its_consumer_stopped_leaves_the_next_open_alone() {
    a_late_close_of_a_leaves_b_alone(Hold::ConsumerStopped);
}

#[test]
fn a_close_hook_that_starts_after_the_next_open_leaves_it_alone() {
    a_late_close_of_a_leaves_b_alone(Hold::SlotRead);
}

/// A file the app writes while the vault opens is its own write to the watcher that starts.
#[test]
fn a_record_made_while_the_vault_opens_belongs_to_that_open() {
    let t = two();
    let hash = content_hash("written as the vault opens\n");
    let tier = t.tier.clone();
    let recorded = hash.clone();
    t.tier.hold_at(Hold::WatcherStart, move || {
        tier.echo().will_write("n.md", &recorded);
    });
    t.session.open(&t.b, OpenSource::Select).unwrap();
    assert_eq!(t.tier.echo().expected_hash("n.md"), Some(hash));
    t.session.close();
}

/// A start that fails leaves no rows open for a vault without a watcher.
#[test]
fn a_watcher_that_cannot_start_leaves_the_rows_closed() {
    let t = two();
    let (root, aside) = (t.b.clone(), t.b.with_extension("aside"));
    let moved = (root.clone(), aside.clone());
    t.tier.hold_at(Hold::WatcherStart, move || {
        std::fs::rename(&moved.0, &moved.1).unwrap();
    });
    let opened = t.session.open(&t.b, OpenSource::Select).unwrap();
    std::fs::rename(&aside, &root).unwrap();
    assert!(matches!(
        t.tier.rows().session_for(&opened.vault.vault),
        Err(RowError::Closed)
    ));
    t.session.close();
}

/// A consumer whose stop ran late writes nothing into the rows of the vault opened since.
#[test]
fn a_consumer_that_outlives_its_vault_writes_nothing_into_the_next_vaults_rows() {
    let f = fixture();
    let core = f.root.parent().unwrap().join("next/.memry/core");
    std::fs::create_dir_all(&core).unwrap();
    let next = Arc::new(
        Vault::open_with(core.to_string_lossy().into_owned(), OpenOptions::default()).unwrap(),
    );
    f.rows.close_session(f.applier.session);
    f.rows.open(next.clone()).unwrap();
    f.write("a.md", "written as the vault closed\n");
    assert_eq!(f.added("a.md"), Step::Done);
    assert!(
        next.note_files().list_paths().unwrap().is_empty(),
        "the event wrote a row"
    );
    assert_eq!(f.walked("a.md"), Step::Done);
    assert!(
        next.note_files().list_paths().unwrap().is_empty(),
        "the walk wrote a row"
    );
}
