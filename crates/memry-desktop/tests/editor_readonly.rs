//! The editor host over a vault whose `data.db` is read-only (#4190): every note opens
//! read-only and a window's edit is refused as `database_read_only`, so the renderer stops the
//! typing it cannot save. The launches in a row that could not store their edits are counted
//! across launches, in the app config.

use std::fs;
use std::os::unix::fs::PermissionsExt as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use memry_core::api::editor::ReadOnly;
use memry_core::seams::secure_store::SecureStore;
use memry_desktop::editor::{EditorHealth, EditorHost, HostEvent, Subscriber, read_only_name};
use memry_desktop::error::{FailureKind, map_core};
use memry_desktop::registry::{AppConfig, VaultRegistry};
use memry_desktop::session::{OpenSource, Session};
use yrs::updates::decoder::Decode as _;
use yrs::{Doc, ReadTxn as _, Text as _, Transact as _, Update};

use crate::device_key;

struct Profile {
    dir: tempfile::TempDir,
    store: Arc<dyn SecureStore>,
}

impl Profile {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("vault")).unwrap();
        fs::create_dir_all(dir.path().join("app")).unwrap();
        Self {
            dir,
            store: device_key::with_device_key(),
        }
    }

    fn vault(&self) -> PathBuf {
        self.dir.path().join("vault")
    }

    /// One launch of the app: a new host over the same app config, which opens the vault, then
    /// quits. Answers the health a window asks for after the open.
    fn launch(&self) -> EditorHealth {
        self.launch_with(|_, _| {})
    }

    fn launch_with(&self, during: impl FnOnce(&Session, &EditorHost)) -> EditorHealth {
        self.launch_heard(during, |_| {})
    }

    fn launch_heard(
        &self,
        during: impl FnOnce(&Session, &EditorHost),
        notify: impl Fn(HostEvent) + Send + Sync + 'static,
    ) -> EditorHealth {
        let config = AppConfig::load(self.dir.path().join("app/memry-config.json"));
        let session = Session::new(VaultRegistry::new(Arc::new(config)));
        let host = EditorHost::new(self.store.clone(), notify);
        host.register(&session);
        session.open(&self.vault(), OpenSource::Select).unwrap();
        during(&session, &host);
        let health = host.health().unwrap();
        session.close();
        health
    }
}

/// Write-protects the file, as a read-only volume or a copied profile does; SQLite then opens it
/// read-only. Unix only: the permission bits are the switch.
fn set_read_only(database: &Path, read_only: bool) {
    let mode = if read_only { 0o444 } else { 0o644 };
    fs::set_permissions(database, fs::Permissions::from_mode(mode)).unwrap();
}

/// Gives the file its write permission back when the test ends, pass or fail.
struct Writable(PathBuf);

impl Drop for Writable {
    fn drop(&mut self) {
        set_read_only(&self.0, false);
    }
}

#[test]
fn three_read_only_launches_in_a_row_count_three_and_a_writable_one_ends_the_streak() {
    let profile = Profile::new();
    let first = profile.launch();
    assert_eq!(
        (first.persistent, first.in_memory_sessions),
        (true, 0),
        "a writable database stores every edit"
    );

    let database = profile.vault().join(".memry/core/data.db");
    set_read_only(&database, true);
    let writable = Writable(database);
    let streak: Vec<(bool, u32)> = (0..3)
        .map(|_| profile.launch())
        .map(|health| (health.persistent, health.in_memory_sessions))
        .collect();
    assert_eq!(streak, [(false, 1), (false, 2), (false, 3)]);

    drop(writable);
    let healed = profile.launch();
    assert_eq!((healed.persistent, healed.in_memory_sessions), (true, 0));
}

#[test]
fn a_launch_counts_once_however_often_it_is_asked_or_reopens_the_vault() {
    let profile = Profile::new();
    profile.launch();
    let database = profile.vault().join(".memry/core/data.db");
    set_read_only(&database, true);
    let _writable = Writable(database);

    let health = profile.launch_with(|session, host| {
        assert_eq!(host.health().unwrap().in_memory_sessions, 1);
        session.close();
        session.open(&profile.vault(), OpenSource::Select).unwrap();
        assert_eq!(host.health().unwrap().in_memory_sessions, 1);
    });
    assert_eq!(health.in_memory_sessions, 1);
    assert_eq!(profile.launch().in_memory_sessions, 2);
}

fn window(label: &str) -> Subscriber {
    Subscriber {
        window_label: label.to_owned(),
        channel: Arc::new(|_| true),
    }
}

/// What the window types into its copy of `state`: one insert at the end of a text root.
fn typed(state: &[u8]) -> Vec<u8> {
    let doc = Doc::new();
    doc.transact_mut()
        .apply_update(Update::decode_v1(state).unwrap())
        .unwrap();
    let before = doc.transact().state_vector();
    let root = doc.get_or_insert_text("t");
    let mut txn = doc.transact_mut();
    let end = root.len(&txn);
    root.insert(&mut txn, end, "typed while read-only");
    drop(txn);
    doc.transact().encode_diff_v1(&before)
}

#[test]
fn a_read_only_database_opens_every_note_read_only_and_refuses_its_edits() {
    let profile = Profile::new();
    let note = Mutex::new(String::new());
    profile.launch_with(|session, host| {
        let core = session.current().unwrap().vault;
        let id = core
            .notes_writer(profile.store.clone())
            .unwrap()
            .create("A note".into(), None)
            .unwrap();
        let opened = host.open(&id, None, window("main")).unwrap();
        assert_eq!(opened.read_only, None, "a writable database takes edits");
        *note.lock().unwrap() = id;
    });
    let note = note.into_inner().unwrap();

    let database = profile.vault().join(".memry/core/data.db");
    set_read_only(&database, true);
    let _writable = Writable(database);
    let events: Arc<Mutex<Vec<HostEvent>>> = Arc::default();
    let heard = Arc::clone(&events);
    profile.launch_heard(
        |_, host| {
            let opened = host.open(&note, None, window("main")).unwrap();
            assert_eq!(opened.read_only, Some(ReadOnly::Database));
            assert_eq!(read_only_name(ReadOnly::Database), "database-read-only");

            let refused = host
                .apply_update(&note, &typed(&opened.state), "main")
                .unwrap_err();
            let failure = map_core(&refused);
            assert_eq!(
                (failure.kind, failure.code),
                (FailureKind::Storage, "database_read_only")
            );
        },
        move |event| heard.lock().unwrap().push(event),
    );
    assert!(
        !events
            .lock()
            .unwrap()
            .iter()
            .any(|event| matches!(event, HostEvent::Edited { .. })),
        "no write-back is asked for"
    );
}
