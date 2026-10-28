//! The lane: who may write rows, for which session, and what a missing device key costs.

use std::sync::atomic::Ordering;

use super::*;
use crate::vault::consumer::rows::RowError;

/// An app operation that started in one vault session and finishes after it closed (another
/// vault opened, or the same one again) writes nothing.
#[test]
fn an_app_operation_writes_no_row_once_its_session_closed() {
    let f = fixture();
    let id = f.note();
    let started_in = f.session();
    f.rows.close_session(started_in);
    f.rows.open(f.vault.clone()).unwrap();
    let error = f
        .rows
        .reserve(started_in, &id, "late.md", Fixture::stat(1))
        .expect_err("a row from a closed session");
    assert!(matches!(error, RowError::Closed), "{error}");
    assert!(f.row("late.md").is_none());
    assert!(matches!(
        f.rows.remove(started_in, &id),
        Err(RowError::Closed)
    ));
    f.rows
        .reserve(f.session(), &id, "late.md", Fixture::stat(1))
        .unwrap();
}

/// A move the record refused leaves record and row where they were: the next open's rescan
/// reports it again.
#[test]
fn a_move_the_record_refused_leaves_the_row_at_the_old_path() {
    let mut f = fixture();
    f.write("a.md", "x\n");
    f.added("a.md");
    let id = only_note(&f, "a.md");
    f.facts();
    f.identity.rename_fails.store(true, Ordering::SeqCst);
    let renamed = VaultEvent::Renamed {
        note_id: id.clone(),
        old_path: "a.md".into(),
        new_path: "b.md".into(),
        content_hash: None,
    };
    assert_eq!(f.applier.apply(renamed), Step::Done);
    assert_eq!(only_note(&f, "a.md"), id);
    assert!(f.row("b.md").is_none());
    assert!(f.facts().is_empty());
}

/// Without a signing key no text reaches a note. The note the identity named still gets its
/// row, so it is not named again, and the row has no hash. The next open seeds it.
#[test]
fn without_a_signing_key_a_new_file_gets_a_row_without_a_hash_and_no_retry() {
    let mut f = fixture();
    f.applier.feed = None;
    f.write("a.md", "x\n");
    assert_eq!(f.added("a.md"), Step::Done);
    assert_eq!(f.hash_of("a.md"), None);
    f.write("b.md", "y\n");
    assert_eq!(f.added("b.md"), Step::Done);
    assert_eq!(f.adopted().len(), 2);
}

/// An identity that adopts nothing never reads a file no row names: the open walk and a
/// watcher's `Added` pass over it. Here the file cannot be read at all.
#[test]
fn an_identity_that_adopts_nothing_reads_no_new_file() {
    let f = fixture();
    f.identity.adopts.store(false, Ordering::SeqCst);
    std::fs::write(f.root.join("bad.md"), [0xff, 0xfe, 0x00]).unwrap();
    assert_eq!(f.added("bad.md"), Step::Done, "the file was read");
    assert_eq!(f.walked("bad.md"), Step::Done);
    assert!(f.adopted().is_empty());
}

/// A tripwire, not a proof: it scans the source of this crate and of the Tauri app for calls
/// that write `note_files` rows outside the lane, by name. `note_files` rows are written
/// through the lane only, so its path index and its facts never miss a write. A new writer
/// elsewhere is a bug: take the lane (`RowOwner`) instead.
#[test]
fn note_files_is_written_only_through_the_lane() {
    let crate_src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let app_src = crate_src.join("../../../apps/desktop-tauri/src-tauri/src");
    let writers = [
        ".upsert_stat(",
        ".rename_path(",
        ".rename_prefix(",
        ".set_hash(",
        "note_files().remove(",
        "files.remove(",
    ];
    let mut found = Vec::new();
    for root in [crate_src, app_src] {
        for file in rust_files(&root) {
            let text = std::fs::read_to_string(&file).unwrap();
            // The lane itself, and this list.
            if file.ends_with("consumer/rows.rs") || file.ends_with("consumer/tests/lane.rs") {
                continue;
            }
            // Test fixtures plant rows directly.
            let code = text.split("#[cfg(test)]").next().unwrap_or_default();
            for writer in writers {
                if code.contains(writer) {
                    found.push(format!("{} calls {writer}", file.display()));
                }
            }
        }
    }
    assert!(
        found.is_empty(),
        "write rows through vault::consumer::rows::RowOwner: {found:?}"
    );
}

fn rust_files(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut files = Vec::new();
    for entry in std::fs::read_dir(dir).unwrap().flatten() {
        let path = entry.path();
        if path.is_dir() {
            files.extend(rust_files(&path));
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            files.push(path);
        }
    }
    files
}

/// A session is handed out for the vault that is open, and only with its handle: an operation
/// for vault A cannot take the session of vault B.
#[test]
fn a_session_is_had_only_with_the_handle_of_the_open_vault() {
    let f = fixture();
    let other_dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(other_dir.path().join("core")).unwrap();
    let other = Arc::new(
        Vault::open_with(
            other_dir.path().join("core").to_string_lossy().into_owned(),
            OpenOptions::default(),
        )
        .unwrap(),
    );
    assert!(f.rows.session_for(&f.vault).is_ok());
    assert!(matches!(f.rows.session_for(&other), Err(RowError::Closed)));
    let in_a = f.rows.session_for(&f.vault).unwrap();
    f.rows.close_session(in_a);
    f.rows.open(other.clone()).unwrap();
    assert!(matches!(
        f.rows.session_for(&f.vault),
        Err(RowError::Closed)
    ));
    let id = f.note();
    assert!(matches!(
        f.rows.reserve(in_a, &id, "a.md", Fixture::stat(1)),
        Err(RowError::Closed)
    ));
    assert!(other.note_files().by_path("a.md").unwrap().is_none());
}
