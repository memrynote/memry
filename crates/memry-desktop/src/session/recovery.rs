use super::fixture::*;

#[test]
fn corrupt_data_db_is_reported_untouched_then_repaired_on_request() {
    let f = fixture();
    let vault = f.vault("v");
    let opened = f.session.open(&vault, OpenSource::Select).expect("open");
    put_meta(&opened, "keep", "me");
    drop(opened);
    f.session.close();
    let path = data_db(&vault);
    let mut bytes = std::fs::read(&path).expect("read");
    bytes[..64].copy_from_slice(&[0xAB; 64]);
    std::fs::write(&path, &bytes).expect("damage");
    let before = sha(&path);

    assert!(matches!(
        f.session.open(&vault, OpenSource::Select),
        Err(SessionError::Corrupt { .. })
    ));
    assert_eq!(
        sha(&path),
        before,
        "a damaged database is left byte for byte as found"
    );
    assert!(!f.session.status().is_open);
    assert_eq!(
        f.session.registry().current().as_deref(),
        Some(&*vault.to_string_lossy()),
        "a damaged vault stays registered for the recovery prompt"
    );

    let outcome = f.session.repair(&vault).expect("repair");
    let RepairOutcome::Rebuilt(report) = outcome else {
        panic!("expected a rebuild")
    };
    assert_eq!(sha(&report.quarantined), before, "the damaged file is kept");
    f.session
        .open(&vault, OpenSource::Select)
        .expect("reopens after repair");
    // A second repair finds nothing wrong and moves nothing.
    f.session.close();
    assert!(matches!(
        f.session.repair(&vault).expect("again"),
        RepairOutcome::NotCorrupt
    ));
}

#[test]
fn corrupt_a_leftover_marker_never_resalvages_or_moves_a_live_db_aside() {
    let f = fixture();
    let vault = f.vault("v");
    let opened = f.session.open(&vault, OpenSource::Select).expect("open");
    put_meta(&opened, "live", "row");
    drop(opened);
    f.session.close();
    let path = data_db(&vault);
    // A marker naming a quarantine that is gone (pruned, or the app died before the move).
    let marker = vault.join(".memry/core/data.db.recovering");
    std::fs::write(
        &marker,
        vault
            .join(".memry/core/data.db.corrupt-1")
            .display()
            .to_string(),
    )
    .expect("marker");
    f.session
        .open(&vault, OpenSource::Select)
        .expect("opens the live database");
    f.session.close();
    assert_eq!(meta(&vault, "live").as_deref(), Some("row"));
    assert!(
        std::fs::read_dir(vault.join(".memry/core"))
            .expect("dir")
            .all(|e| {
                !e.expect("entry")
                    .file_name()
                    .to_string_lossy()
                    .contains("corrupt")
            })
    );
    assert!(path.is_file());
}

#[test]
fn corrupt_pruning_keeps_the_newest_settled_quarantines() {
    let f = fixture();
    let vault = f.vault("v");
    f.session.open(&vault, OpenSource::Select).expect("open");
    f.session.close();
    let path = data_db(&vault);
    let made: Vec<_> = (0..4)
        .map(|_| {
            memry_core::storage::recovery::quarantine_and_rebuild(&path)
                .expect("recover")
                .quarantined
        })
        .collect();
    std::fs::write(
        vault.join(".memry/core/data.db.recovering"),
        made[0].display().to_string(),
    )
    .expect("marker");
    f.session
        .open(&vault, OpenSource::Select)
        .expect("open prunes");
    let left: Vec<bool> = made.iter().map(|p| p.exists()).collect();
    // The open proved the marker's recovery settled and removed it, so the oldest quarantine
    // is an ordinary settled one. Core's own tests cover a marker that stays.
    assert_eq!(left, [false, false, true, true]);
}

#[test]
fn electron_databases_beside_the_core_directory_are_never_touched() {
    let f = fixture();
    let vault = f.vault("v");
    std::fs::create_dir_all(vault.join(".memry")).expect(".memry");
    for name in ["data.db", "index.db"] {
        let conn =
            rusqlite::Connection::open(vault.join(".memry").join(name)).expect("electron db");
        conn.execute_batch(
            "CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT);
             CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, modified_at TEXT);
             INSERT INTO settings VALUES ('theme', 'dark', 'x');",
        )
        .expect("seed");
    }
    let before: Vec<String> = ["data.db", "index.db"]
        .iter()
        .map(|n| sha(&vault.join(".memry").join(n)))
        .collect();
    f.session.open(&vault, OpenSource::Select).expect("open");
    f.session.close();
    let after: Vec<String> = ["data.db", "index.db"]
        .iter()
        .map(|n| sha(&vault.join(".memry").join(n)))
        .collect();
    assert_eq!(before, after);
    assert!(data_db(&vault).is_file());
}
