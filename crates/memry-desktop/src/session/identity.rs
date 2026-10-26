use std::sync::atomic::{AtomicBool, Ordering};

use super::fixture::*;

fn stored_id(vault: &Path) -> Option<String> {
    let conn = rusqlite::Connection::open(vault.join(".memry/core/data.db")).expect("open");
    conn.query_row("SELECT value FROM meta WHERE key = 'vault.id'", [], |row| {
        row.get(0)
    })
    .ok()
}

#[test]
fn identity_survives_moving_the_folder_and_is_not_path_derived() {
    let f = fixture();
    let vault = f.vault("before");
    let first = f
        .session
        .open(&vault, OpenSource::Select)
        .expect("open")
        .vault
        .vault_id;
    assert_eq!(stored_id(&vault).as_deref(), Some(first.as_str()));
    assert!(!first.starts_with("local:"), "{first}");
    f.session.close();

    let moved = f.dir.path().join("elsewhere").join("After");
    std::fs::create_dir_all(moved.parent().expect("parent")).expect("parent");
    std::fs::rename(&vault, &moved).expect("move the folder");
    let second = f
        .session
        .open(&moved, OpenSource::Select)
        .expect("open")
        .vault
        .vault_id;
    assert_eq!(first, second, "a rename or move does not change the id");
}

#[test]
fn identity_survives_a_recovery_that_can_read_the_file() {
    // A damaged header leaves nothing to salvage (every row stays in the quarantine, the id
    // with them). When the file can be read, the rebuild carries `meta` over and the open
    // that follows reads the same id instead of minting a second one.
    let f = fixture();
    let vault = f.vault("v");
    let id = f
        .session
        .open(&vault, OpenSource::Select)
        .expect("open")
        .vault
        .vault_id;
    f.session.close();
    let path = vault.join(".memry/core/data.db");
    memry_core::storage::recovery::quarantine_and_rebuild(&path).expect("recover");
    let after = f
        .session
        .open(&vault, OpenSource::Select)
        .expect("reopen")
        .vault
        .vault_id;
    assert_eq!(id, after);
}

#[test]
fn held_vaults_are_remembered_per_path_not_one_slot() {
    let f = fixture_with(Duration::from_millis(100));
    let release = Arc::new(AtomicBool::new(false));
    let flag = release.clone();
    let stuck_path = f.vault("a");
    let watched = stuck_path.clone();
    f.session.on_close(
        "stuck",
        Arc::new(move |view| {
            if view.path != watched {
                return;
            }
            let _held = view.vault.clone();
            while !flag.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(5));
            }
        }),
    );
    f.session.open(&stuck_path, OpenSource::Select).expect("a");
    f.session.close();
    // B is opened and closed in between: A's stuck holder must still be remembered.
    let other = f.vault("b");
    f.session.open(&other, OpenSource::Select).expect("b");
    f.session.close();
    assert!(matches!(
        f.session.open(&stuck_path, OpenSource::Select),
        Err(SessionError::Held(_))
    ));
    release.store(true, Ordering::SeqCst);
    f.session
        .open(&stuck_path, OpenSource::Select)
        .expect("opens once the holder let go");
}

#[test]
fn background_tasks_get_the_cancel_token_and_close_joins_them() {
    let f = fixture();
    let stopped = Arc::new(AtomicBool::new(false));
    let done = stopped.clone();
    f.session.on_background(
        "index-build",
        Arc::new(move |_, cancel| {
            while !cancel.is_cancelled() {
                std::thread::sleep(Duration::from_millis(2));
            }
            done.store(true, Ordering::SeqCst);
            Ok(())
        }),
    );
    let vault = f.vault("v");
    f.session.open(&vault, OpenSource::Select).expect("open");
    assert!(
        !stopped.load(Ordering::SeqCst),
        "it runs while the vault is open"
    );
    f.session.close();
    assert!(
        stopped.load(Ordering::SeqCst),
        "close cancelled it and waited for it"
    );
    f.session
        .open(&vault, OpenSource::Select)
        .expect("reopens: nothing holds the vault");
}
