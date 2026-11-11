//! The editor host over a vault whose `data.db` is read-only (#4190): the launches in a row
//! that could not store their edits are counted across launches, in the app config, so the
//! renderer's notice can wait for three of them.

use std::fs;
use std::os::unix::fs::PermissionsExt as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use memry_core::seams::secure_store::SecureStore;
use memry_desktop::editor::{EditorHealth, EditorHost};
use memry_desktop::registry::{AppConfig, VaultRegistry};
use memry_desktop::session::{OpenSource, Session};

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
        let config = AppConfig::load(self.dir.path().join("app/memry-config.json"));
        let session = Session::new(VaultRegistry::new(Arc::new(config)));
        let host = EditorHost::new(self.store.clone(), |_| {});
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
