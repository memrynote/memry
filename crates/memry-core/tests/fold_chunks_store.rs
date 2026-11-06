//! `note_fold_chunks` on a real `index.db` (desktop Step 14h): the note fold cache a reader
//! of one key never sees another key's row through, and that keeps what it wrote across a
//! reopen until a prune drops it.

#![cfg(feature = "markdown")]

use std::path::Path;
use std::sync::Arc;

use memry_core::api::search::Search;
use memry_core::api::vault::Vault;
use memry_core::domain::fold_chunks::ChunkKey;

fn scratch() -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix("memry-fold-chunks-")
        .tempdir()
        .expect("the scratch directory")
}

fn open(dir: &Path) -> (Vault, Arc<Search>) {
    let vault = Vault::open("vault-1".to_owned(), dir.display().to_string()).expect("open");
    let search = vault.search().expect("index.db");
    (vault, search)
}

fn key(chunk_hash: &str, language: &str, model_id: &str) -> ChunkKey {
    ChunkKey {
        chunk_hash: chunk_hash.to_owned(),
        language: language.to_owned(),
        model_id: model_id.to_owned(),
    }
}

#[test]
fn a_written_chunk_reads_back_under_its_own_key_only() {
    let dir = scratch();
    let (_vault, search) = open(dir.path());
    let local = key("c1", "en", "local");
    assert_eq!(search.fold_chunk(&local).expect("read"), None);

    search
        .put_fold_chunk(&local, "{\"a\":1}", 10)
        .expect("write");
    assert_eq!(
        search.fold_chunk(&local).expect("read").as_deref(),
        Some("{\"a\":1}")
    );
    for other in [
        key("c2", "en", "local"),
        key("c1", "tr", "local"),
        key("c1", "en", "m"),
    ] {
        assert_eq!(search.fold_chunk(&other).expect("read"), None, "{other:?}");
    }
}

#[test]
fn a_second_write_replaces_the_row_and_its_age() {
    let dir = scratch();
    let (_vault, search) = open(dir.path());
    let local = key("c1", "en", "local");
    search.put_fold_chunk(&local, "old", 10).expect("write");
    search.put_fold_chunk(&local, "new", 500).expect("rewrite");
    assert_eq!(
        search.fold_chunk(&local).expect("read").as_deref(),
        Some("new")
    );

    // Stamped 500 now, so a prune at 100 keeps it.
    assert_eq!(search.prune_fold_chunks(100).expect("prune"), 0);
    assert_eq!(
        search.fold_chunk(&local).expect("read").as_deref(),
        Some("new")
    );
}

#[test]
fn a_forgotten_chunk_is_a_miss_and_its_neighbours_stay() {
    let dir = scratch();
    let (_vault, search) = open(dir.path());
    let gone = key("c1", "en", "local");
    // Another chunk, the same chunk in another language, and the same chunk by another model.
    let kept = [
        key("c2", "en", "local"),
        key("c1", "tr", "local"),
        key("c1", "en", "m"),
    ];
    search.put_fold_chunk(&gone, "x", 10).expect("write");
    for other in &kept {
        search.put_fold_chunk(other, "y", 10).expect("write");
    }

    search.forget_fold_chunk(&gone).expect("forget");
    assert_eq!(search.fold_chunk(&gone).expect("read"), None);
    for other in &kept {
        assert_eq!(
            search.fold_chunk(other).expect("read").as_deref(),
            Some("y"),
            "{other:?}"
        );
    }
}

#[test]
fn the_cache_survives_a_reopen_and_a_prune_drops_only_older_rows() {
    let dir = scratch();
    let (old, fresh) = (key("c1", "en", "local"), key("c2", "ja", "local"));
    {
        let (_vault, search) = open(dir.path());
        search.put_fold_chunk(&old, "old", 100).expect("write");
        search.put_fold_chunk(&fresh, "fresh", 200).expect("write");
    }

    let (_vault, search) = open(dir.path());
    assert_eq!(
        search.fold_chunk(&old).expect("read").as_deref(),
        Some("old")
    );
    assert_eq!(search.prune_fold_chunks(200).expect("prune"), 1);
    assert_eq!(search.fold_chunk(&old).expect("read"), None);
    assert_eq!(
        search.fold_chunk(&fresh).expect("read").as_deref(),
        Some("fresh")
    );
}
