use std::sync::Weak;

use super::*;
use crate::crdt::markdown_seed::append_markdown_in;
use crate::crdt::{DocumentRegistry, epoch::HeldBody, extract_text, update_log};
use crate::domain::body_write::author_with;
use crate::storage::{nested_tx, open_data, test_support::temp_dir};

const DAY: &str = "j2026-04-16";
const DEVICE: &str = "device-a";

fn storage(error: CrdtError) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

/// Writes `markdown` as this device and answers the update with the body
/// text the write saw before it. Authored in a transaction rolled back
/// here: [`commit`] stores it, as a body write does.
fn write(conn: &Connection, markdown: &str) -> Result<(Vec<u8>, String), StorageError> {
    let mut seen = String::new();
    let tx = nested_tx::begin(conn).map_err(|e| StorageError::Failed {
        what: e.to_string(),
    })?;
    let update = author_with(&tx, DAY, DEVICE, |document| {
        seen = extract_text(document)?;
        document.write(|txn| append_markdown_in(txn, markdown).map(|_| ()))?
    })
    .map_err(storage)?
    .expect("authored an update");
    Ok((update, seen))
}

fn commit(conn: &Connection, update: &[u8]) -> Result<(), StorageError> {
    let failed = |e: rusqlite::Error| StorageError::Failed {
        what: e.to_string(),
    };
    let tx = nested_tx::begin(conn).map_err(failed)?;
    update_log::append_local_update_in(&tx, DAY, update, 1).map_err(storage)?;
    tx.commit().map_err(failed)
}

/// An update another device authored over `base`, holding `markdown`.
fn peer_update(base: Option<&[u8]>, markdown: &str) -> Vec<u8> {
    let authored: Authored = Arc::new(Mutex::new(Vec::new()));
    let sink: UpdateSink = {
        let authored = Arc::clone(&authored);
        Arc::new(move |_, bytes: &[u8]| lock(&authored).push(bytes.to_vec()))
    };
    let peer = DocumentRegistry::new("device-b", sink)
        .get_or_open(DAY)
        .unwrap();
    if let Some(base) = base {
        peer.apply_durable_update(base).unwrap();
    }
    peer.write(|txn| append_markdown_in(txn, markdown).map(|_| ()))
        .unwrap()
        .unwrap();
    lock(&authored).remove(0)
}

/// A kept body serves the next write while the log holds its update.
#[test]
fn a_write_sees_every_committed_write_before_it() {
    let dir = temp_dir("resident-chain");
    let db = open_data(&dir.path().join("data.db")).expect("open data.db");
    let seen = db
        .call_blocking(|conn| {
            for text in ["one", "two"] {
                let (update, _) = write(conn, text)?;
                commit(conn, &update)?;
            }
            Ok(write(conn, "three")?.1)
        })
        .expect("write");
    assert!(seen.contains("one") && seen.contains("two"), "{seen}");
}

/// A pull between two writes lands in the second one's body.
#[test]
fn a_server_row_after_a_write_is_in_the_next_one() {
    let dir = temp_dir("resident-pull");
    let db = open_data(&dir.path().join("data.db")).expect("open data.db");
    let seen = db
        .call_blocking(|conn| {
            let (update, _) = write(conn, "mine")?;
            commit(conn, &update)?;
            HeldBody::never_purged(conn, DAY)
                .and_then(|body| {
                    body.append_server_update(1, &peer_update(Some(&update), "pulled"), 2)
                })
                .map_err(storage)?;
            Ok(write(conn, "next")?.1)
        })
        .expect("write");
    assert!(seen.contains("mine") && seen.contains("pulled"), "{seen}");
}

/// A write whose update never committed leaves nothing in the next body.
#[test]
fn an_update_that_never_committed_is_not_in_the_next_write() {
    let dir = temp_dir("resident-abandoned");
    let db = open_data(&dir.path().join("data.db")).expect("open data.db");
    let seen = db
        .call_blocking(|conn| {
            write(conn, "dropped")?;
            Ok(write(conn, "next")?.1)
        })
        .expect("write");
    assert!(!seen.contains("dropped"), "{seen}");
}

/// One row from another writer in place of the expected update is a
/// moved log, though it grows the log by the same one row.
#[test]
fn another_row_in_place_of_the_kept_update_is_a_moved_log() {
    let dir = temp_dir("resident-swapped");
    let db = open_data(&dir.path().join("data.db")).expect("open data.db");
    let seen = db
        .call_blocking(|conn| {
            write(conn, "dropped")?;
            commit(conn, &peer_update(None, "other"))?;
            Ok(write(conn, "next")?.1)
        })
        .expect("write");
    assert!(
        seen.contains("other") && !seen.contains("dropped"),
        "{seen}"
    );
}

/// A purge between two writes leaves the next one an empty body.
#[test]
fn a_purge_after_a_write_empties_the_next_one() {
    let dir = temp_dir("resident-purge");
    let db = open_data(&dir.path().join("data.db")).expect("open data.db");
    let seen = db
        .call_blocking(|conn| {
            let (update, _) = write(conn, "gone")?;
            commit(conn, &update)?;
            update_log::purge_in(conn, DAY).map_err(storage)?;
            Ok(write(conn, "new")?.1)
        })
        .expect("write");
    assert!(!seen.contains("gone"), "{seen}");
}

/// Writes `markdown` to `doc_id` and keeps the body, answering a handle
/// that lives exactly as long as the kept document.
fn kept(conn: &Connection, doc_id: &str, markdown: &str) -> Result<Weak<Document>, StorageError> {
    let failed = |e: rusqlite::Error| StorageError::Failed {
        what: e.to_string(),
    };
    let tx = nested_tx::begin(conn).map_err(failed)?;
    let body = checkout(&tx, DEVICE, doc_id).map_err(storage)?;
    body.document()
        .write(|txn| append_markdown_in(txn, markdown).map(|_| ()))
        .map_err(storage)?
        .map_err(storage)?;
    let update = body.take_authored().remove(0);
    update_log::append_local_update_in(&tx, doc_id, &update, 1).map_err(storage)?;
    tx.commit().map_err(failed)?;
    let weak = Arc::downgrade(&body.document);
    body.keep(Some(update));
    Ok(weak)
}

/// A database keeps the four bodies written last: the fifth write
/// releases the first, whose next write is rebuilt from its log.
#[test]
fn a_fifth_body_releases_the_first() {
    let dir = temp_dir("resident-evict");
    let db = open_data(&dir.path().join("data.db")).expect("open data.db");
    db.call_blocking(|conn| {
        let docs: Vec<String> = (0..5).map(|n| format!("note-{n}")).collect();
        let mut weak = Vec::new();
        for doc in &docs {
            weak.push(kept(conn, doc, &format!("text of {doc}"))?);
        }
        assert!(weak[0].upgrade().is_none(), "first body still held");
        assert!(weak[1..].iter().all(|kept| kept.upgrade().is_some()));

        let tx = nested_tx::begin(conn).map_err(|e| StorageError::Failed {
            what: e.to_string(),
        })?;
        let rebuilt = checkout(&tx, DEVICE, &docs[0]).map_err(storage)?;
        let text = extract_text(rebuilt.document()).map_err(storage)?;
        assert!(text.contains("text of note-0"), "{text}");
        Ok(())
    })
    .expect("write");
}

/// A purge releases the document it purges (chapter 07 §7.15.1).
#[test]
fn a_purge_releases_the_kept_body() {
    let dir = temp_dir("resident-purge-release");
    let db = open_data(&dir.path().join("data.db")).expect("open data.db");
    db.call_blocking(|conn| {
        let purged = kept(conn, DAY, "gone")?;
        let other = kept(conn, "note-other", "stays")?;
        update_log::purge_in(conn, DAY).map_err(storage)?;
        assert!(purged.upgrade().is_none(), "purged body still held");
        assert!(other.upgrade().is_some());
        Ok(())
    })
    .expect("purge");
}

/// The body text a write would see, authoring nothing.
fn text(conn: &Connection) -> Result<String, StorageError> {
    let mut seen = String::new();
    let tx = nested_tx::begin(conn).map_err(|e| StorageError::Failed {
        what: e.to_string(),
    })?;
    author_with(&tx, DAY, DEVICE, |document| {
        seen = extract_text(document)?;
        Ok(())
    })
    .map_err(storage)?;
    Ok(seen)
}

/// Deletes the database at `path`, as a sign-out wipe does, and hands back
/// `open`, a handle on it, where it can outlive the file. Windows refuses to
/// delete a file SQLite holds open, so a wipe there closes the handle first,
/// and the old handle living on is a unix-only sequence.
fn remove_database(path: &std::path::Path, open: crate::storage::Db) -> Option<crate::storage::Db> {
    let open = (!cfg!(windows)).then_some(open);
    for suffix in ["", "-wal", "-shm"] {
        let mut file = path.as_os_str().to_owned();
        file.push(suffix);
        match std::fs::remove_file(&file) {
            Err(err) if err.kind() != std::io::ErrorKind::NotFound => {
                panic!("remove {}: {err}", file.display())
            }
            _ => {}
        }
    }
    open
}

/// A data.db deleted and recreated at the same path, on unix while a handle
/// on the old one lives, as a sign-out wipe and a re-sign-in do, is a new log: a
/// write to it never sees the old body, and survives a replay.
#[test]
fn a_database_recreated_at_the_same_path_never_sees_the_old_body() {
    let dir = temp_dir("resident-recreated");
    let path = dir.path().join("data.db");
    let old = open_data(&path).expect("open old data.db");
    old.call_blocking(|conn| {
        let (update, _) = write(conn, "oldsecret")?;
        commit(conn, &update)?;
        text(conn).map(drop)
    })
    .expect("write old");

    let old = remove_database(&path, old);
    let new = open_data(&path).expect("open new data.db");
    let seen = new
        .call_blocking(|conn| {
            commit(conn, &peer_update(None, "newvault"))?;
            let (update, seen) = write(conn, "edit")?;
            commit(conn, &update)?;
            Ok(seen)
        })
        .expect("write new");
    assert!(!seen.contains("oldsecret"), "{seen}");
    drop(new);

    let replayed = open_data(&path)
        .expect("reopen data.db")
        .call_blocking(|conn| text(conn))
        .expect("replay");
    assert!(
        replayed.contains("newvault") && replayed.contains("edit"),
        "{replayed}"
    );
    drop(old);
}

/// Sign-out wipe and re-sign-in, a vault switch there and back, and two
/// handles on one path: each write sees exactly its own database's log.
#[test]
fn every_reopen_sees_only_its_own_log() {
    let dir = temp_dir("resident-cross");
    let a = dir.path().join("a.db");
    let b = dir.path().join("b.db");
    let append = |db: &crate::storage::Db, markdown: &str| {
        db.call_blocking(|conn| {
            let (update, seen) = write(conn, markdown)?;
            commit(conn, &update)?;
            Ok(seen)
        })
        .expect("write")
    };

    let first = open_data(&a).expect("open a");
    append(&first, "a-one");
    let switched = open_data(&b).expect("open b");
    let seen = append(&switched, "b-one");
    assert!(!seen.contains("a-one"), "{seen}");
    let back = open_data(&a).expect("reopen a");
    let seen = append(&back, "a-two");
    assert!(seen.contains("a-one") && !seen.contains("b-one"), "{seen}");
    let seen = append(&first, "a-three");
    assert!(seen.contains("a-one") && seen.contains("a-two"), "{seen}");
    let seen = append(&back, "a-four");
    assert!(seen.contains("a-three"), "{seen}");

    switched.call_blocking(|conn| text(conn)).expect("read b");
    let switched = remove_database(&b, switched);
    let signed_in = open_data(&b).expect("recreate b");
    let seen = signed_in
        .call_blocking(|conn| {
            commit(conn, &peer_update(None, "pulled"))?;
            Ok(write(conn, "fresh")?.1)
        })
        .expect("write recreated b");
    assert!(seen.contains("pulled") && !seen.contains("b-one"), "{seen}");
    drop(switched);
}

/// Closing a database, as a vault close or a sign-out does, releases
/// every body kept for it.
#[test]
fn closing_the_database_releases_its_bodies() {
    let dir = temp_dir("resident-close");
    let db = open_data(&dir.path().join("data.db")).expect("open data.db");
    let clone = db.clone();
    let weak = db
        .call_blocking(|conn| kept(conn, DAY, "plaintext"))
        .expect("write");
    drop(db);
    assert!(weak.upgrade().is_some(), "released while a handle is open");
    drop(clone);
    assert!(weak.upgrade().is_none(), "body outlived its database");
}
