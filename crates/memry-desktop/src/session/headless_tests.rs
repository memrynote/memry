use super::fixture::*;
use memry_core::storage::recovery::marker_path;

fn wal(vault: &Path) -> PathBuf {
    vault.join(".memry/core/data.db-wal")
}

fn created(vault: &Path) -> PathBuf {
    let opened = open_headless(vault).expect("first open");
    assert!(matches!(opened, HeadlessOpen::Opened(_)));
    drop(opened);
    for side in ["data.db-wal", "data.db-shm"] {
        let _ = std::fs::remove_file(vault.join(".memry/core").join(side));
    }
    data_db(vault)
}

/// The app leaves a damaged `data.db` byte for byte as found until the user chooses Repair; the
/// command line's open does the same instead of migrating and writing into it.
#[test]
fn a_damaged_data_db_is_reported_and_left_as_found() {
    let f = fixture();
    let vault = f.vault("v");
    let path = created(&vault);
    let mut bytes = std::fs::read(&path).expect("read");
    bytes[..64].copy_from_slice(&[0xAB; 64]);
    std::fs::write(&path, &bytes).expect("damage");
    let before = sha(&path);

    assert!(matches!(
        open_headless(&vault).expect("decided"),
        HeadlessOpen::Damaged
    ));
    assert_eq!(sha(&path), before, "the damaged file is left as found");
    assert!(!wal(&vault).exists(), "no journal created beside it");
}

/// A recovery the app started and has not finished: the command line never runs the rescue.
#[test]
fn a_leftover_recovery_is_never_run_by_the_command_line() {
    let f = fixture();
    let vault = f.vault("v");
    let path = created(&vault);
    let parked = vault.join(".memry/core/data.db.corrupt-1");
    std::fs::rename(&path, &parked).expect("quarantine");
    std::fs::write(marker_path(&path), parked.to_string_lossy().as_bytes()).expect("marker");
    let before = sha(&parked);

    assert!(matches!(
        open_headless(&vault).expect("decided"),
        HeadlessOpen::Recovering | HeadlessOpen::Damaged
    ));
    assert_eq!(sha(&parked), before, "the quarantine is the app's");
    assert!(marker_path(&path).exists(), "the marker is the app's");
    assert!(!path.exists(), "no rescue built a new data.db");
}
