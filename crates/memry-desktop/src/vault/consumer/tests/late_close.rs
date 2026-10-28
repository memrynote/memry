//! A close hook that ends after its deadline: the session has opened the next vault by then,
//! and the late stop must touch only what belonged to the vault it stopped.

use std::sync::Condvar;
use std::time::{Duration, Instant};

use memry_core::crdt::body_edit::BlockEdit;

use super::*;
use crate::registry::{AppConfig, VaultRegistry};
use crate::session::{OpenSource, Session};
use crate::vault::consumer::VaultTier;

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

#[test]
fn a_close_that_ends_after_the_next_open_leaves_that_opens_write_back_and_rows_alone() {
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

    session.open(&a, OpenSource::Select).unwrap();
    // A's stop waits after its consumer stopped until B's write-back is installed.
    let installed: Arc<(Mutex<bool>, Condvar)> = Arc::default();
    let resumed = Arc::new(AtomicBool::new(false));
    {
        let (installed, resumed) = (installed.clone(), resumed.clone());
        *tier.after_consumer_stop.lock().unwrap() = Some(Box::new(move || {
            let (done, signal) = &*installed;
            let held = done.lock().unwrap();
            let _ = signal
                .wait_timeout_while(held, WAIT, |done| !*done)
                .unwrap();
            resumed.store(true, Ordering::SeqCst);
        }));
    }
    session.close();
    let opened = session.open(&b, OpenSource::Select).unwrap();
    let vault = opened.vault.vault.clone();
    let id = eventually("B's note", || {
        vault
            .note_files()
            .by_path("n.md")
            .unwrap()
            .filter(|row| row.content_hash.is_some())
            .map(|row| row.note_id)
    });
    {
        let (done, signal) = &*installed;
        *done.lock().unwrap() = true;
        signal.notify_all();
    }
    eventually("A's late stop", || {
        resumed.load(Ordering::SeqCst).then_some(())
    });
    // What the late stop does after the hold.
    std::thread::sleep(Duration::from_millis(500));

    assert!(
        tier.rows().session_for(&vault).is_ok(),
        "A's late stop closed B's rows"
    );
    let blocks = vault.notes().blocks(id.clone()).unwrap().unwrap();
    let block_id = blocks.iter().find_map(|b| b.id.clone()).unwrap();
    let edit = BlockEdit::SetText {
        block_id,
        text: "typed in B".into(),
    };
    let writer = vault.notes_writer(store).unwrap();
    assert!(writer.edit_block(id.clone(), edit).unwrap());
    tier.schedule(&id);
    assert!(tier.flush(WAIT));
    assert_eq!(
        std::fs::read_to_string(b.join("n.md")).unwrap(),
        "typed in B\n",
        "A's late stop stopped B's write-back"
    );
    session.close();
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
