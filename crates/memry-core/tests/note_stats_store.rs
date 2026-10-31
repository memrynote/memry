//! `note_stats` on real `data.db` and `index.db` files (desktop Step 13e): which notes a scan
//! lists, what a reopen keeps, and what a deleted, newer or older `index.db` leaves.

#![cfg(feature = "markdown")]

use std::path::Path;
use std::sync::Arc;

use memry_core::api::search::Search;
use memry_core::api::vault::Vault;
use memry_core::domain::note_files::NoteFileStat;
use memry_core::domain::note_stats::{MeasuredFile, measure};

const TEXT: &str = "---\ntags: [a]\n---\nsome words here\n- [ ] a task {task:t1}\n";

fn scratch() -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix("memry-note-stats-")
        .tempdir()
        .expect("the scratch directory")
}

fn open_vault(dir: &Path) -> Vault {
    Vault::open("vault-1".to_owned(), dir.display().to_string()).expect("open")
}

fn open(dir: &Path) -> (Vault, Arc<Search>) {
    let vault = open_vault(dir);
    let search = vault.search().expect("index.db");
    (vault, search)
}

/// A `note_files` row, with `file_hash` as the bytes the tier last read.
fn row(vault: &Vault, id: &str, path: &str, file_type: &str, size: i64, file_hash: Option<&str>) {
    let files = vault.note_files();
    files
        .upsert_stat(NoteFileStat {
            note_id: id.to_owned(),
            path: path.to_owned(),
            file_type: file_type.to_owned(),
            mime_type: None,
            file_size: Some(size),
            content_hash: None,
            file_hash: file_hash.map(str::to_owned),
            indexed_at: 1,
        })
        .expect("row");
    files.set_file_hash(id, file_hash).expect("file hash");
}

fn measured(id: &str, hash: &str) -> MeasuredFile {
    MeasuredFile {
        note_id: id.to_owned(),
        file_hash: hash.to_owned(),
        date: None,
        text: TEXT.to_owned(),
    }
}

fn listed(search: &Search, all: bool) -> Vec<String> {
    search
        .unindexed_notes(all)
        .expect("list")
        .into_iter()
        .map(|note| note.note_id)
        .collect()
}

fn seed_three(vault: &Vault) {
    row(vault, "big", "big.md", "markdown", 300, Some("h-big"));
    row(vault, "small", "small.md", "markdown", 10, Some("h-small"));
    row(vault, "picture", "picture.png", "image", 5, Some("h-png"));
    row(vault, "mid", "mid.md", "markdown", 50, Some("h-mid"));
}

fn index_all(search: &Search) {
    let files = ["big", "small", "mid"]
        .map(|id| measured(id, &format!("h-{id}")))
        .to_vec();
    assert_eq!(search.index_note_files(files).expect("write"), 3);
}

fn index_db(dir: &Path) -> rusqlite::Connection {
    rusqlite::Connection::open(dir.join("index.db")).expect("index.db")
}

#[test]
fn a_fresh_or_deleted_index_lists_every_markdown_note_smallest_first() {
    let dir = scratch();
    let (vault, search) = open(dir.path());
    seed_three(&vault);
    assert_eq!(listed(&search, false), ["small", "mid", "big"]);
    index_all(&search);
    assert!(listed(&search, false).is_empty());
    drop((search, vault));

    for name in ["index.db", "index.db-wal", "index.db-shm"] {
        let _ = std::fs::remove_file(dir.path().join(name));
    }
    let (_vault, search) = open(dir.path());
    assert_eq!(listed(&search, false), ["small", "mid", "big"]);
}

#[test]
fn the_stored_hash_against_the_file_hash_decides_what_is_listed() {
    let dir = scratch();
    let (vault, search) = open(dir.path());
    row(&vault, "same", "same.md", "markdown", 10, Some("h1"));
    row(
        &vault,
        "moved-on",
        "moved-on.md",
        "markdown",
        20,
        Some("h2"),
    );
    row(&vault, "unread", "unread.md", "markdown", 30, None);
    let files = vec![
        measured("same", "h1"),
        measured("moved-on", "h1"),
        measured("unread", "h1"),
    ];
    search.index_note_files(files).expect("write");

    // A file the tier never hashed has nothing to compare, so only a missing row lists it.
    assert_eq!(listed(&search, false), ["moved-on"]);
    assert_eq!(listed(&search, true), ["same", "moved-on", "unread"]);
}

#[test]
fn rows_survive_a_reopen() {
    let dir = scratch();
    let (vault, search) = open(dir.path());
    seed_three(&vault);
    index_all(&search);
    drop((search, vault));

    let (_vault, search) = open(dir.path());
    let stored = search.note_stats("mid").expect("read").expect("a row");
    assert_eq!(stored.stats, measure(TEXT));
    assert_eq!(stored.file_hash.as_deref(), Some("h-mid"));
    assert!(listed(&search, false).is_empty());
}

#[test]
fn a_newer_index_is_set_aside_and_rebuilt() {
    let dir = scratch();
    let (vault, search) = open(dir.path());
    seed_three(&vault);
    index_all(&search);
    drop((search, vault));
    index_db(dir.path())
        .execute_batch("PRAGMA user_version = 4")
        .expect("a newer build wrote this");

    let vault = open_vault(dir.path());
    let (search, reason) = vault.search_reporting().expect("index.db");
    assert!(reason.is_some_and(|reason| reason.contains("newer")));
    let set_aside = std::fs::read_dir(dir.path())
        .expect("list")
        .filter_map(Result::ok)
        .any(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("index.db.newer-")
        });
    assert!(set_aside, "the newer file is kept beside");
    assert_eq!(search.note_stats("mid").expect("read"), None);
    assert_eq!(listed(&search, false), ["small", "mid", "big"]);
}

#[test]
fn a_version_2_index_migrates_in_place_to_note_stats() {
    let dir = scratch();
    let (vault, search) = open(dir.path());
    seed_three(&vault);
    drop((search, vault));
    // The file an earlier build left: everything but this migration's table.
    index_db(dir.path())
        .execute_batch("DROP TABLE note_stats; PRAGMA user_version = 2;")
        .expect("back to version 2");

    let vault = open_vault(dir.path());
    let (search, reason) = vault.search_reporting().expect("index.db");
    assert_eq!(reason, None, "migrated in place, not rebuilt");
    let version: u32 = index_db(dir.path())
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .expect("version");
    assert_eq!(version, 3);
    assert_eq!(listed(&search, false), ["small", "mid", "big"]);
    index_all(&search);
    assert!(listed(&search, false).is_empty());
}
