//! What the embedding lane owes is read from `index.db` and `note_files`, never from an event
//! (VERIFY-4656): each vector records the hash of the bytes it was built from and the title it
//! was built with, and the reconcile embeds every note whose file hash or title moved since. An
//! edit or a rename whose event a close dropped, one made while the app was closed, and an
//! index from before the hashes are each embedded on the next open.
//!
//! | Test                                                      | Owed because                     |
//! | --------------------------------------------------------- | -------------------------------- |
//! | an edit closed within the write-back debounce is embedded | the close's write-back moved it  |
//! | an edit on disk while closed is embedded on reopen        | the open's walk moved it         |
//! | a rename on disk while closed is embedded on reopen       | the open's walk retitled it      |
//! | a rename whose event embedded nothing before the close    | the rename retitled it           |
//! | a refused outside edit records the bytes it embedded      | (not owed: the hash names them)  |
//! | an index from before the hashes embeds once, keeps all    | no hash recorded                 |

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use memry_desktop::session::OpenStage;
use memry_desktop::vault::consumer::Applied;

use memry_desktop::vault::hash::content_hash;
use rusqlite::OptionalExtension as _;

use crate::embedding_lane::{ALPHA, BETA, Lane, lane};
use crate::vault_env::{WAIT, indexed};

const EDITED: &str = "Alpha now holds an edited body instead.";

/// Holds the next open until the tier's walk has told `walked`: the feed drops that fact, so
/// only the reconcile can embed what it reports.
fn hold_open_until_walked(l: &Lane, walked: impl Fn(&Applied) -> bool + Send + Sync + 'static) {
    let facts = Mutex::new(l.e.tier.subscribe());
    l.e.session.on_open(
        "embedding-owed-walk",
        OpenStage::Defaults,
        Arc::new(move |_| {
            let mut facts = facts.lock().unwrap();
            let deadline = Instant::now() + WAIT;
            while Instant::now() < deadline {
                match facts.try_recv() {
                    Ok(fact) if walked(&fact) => {
                        std::thread::sleep(Duration::from_millis(300));
                        return Ok(());
                    }
                    Ok(_) => {}
                    Err(_) => std::thread::sleep(Duration::from_millis(20)),
                }
            }
            Ok(())
        }),
    );
}

fn until_titled(l: &Lane, id: &str, title: &str) {
    let header = format!("title: {title} |");
    l.until("the renamed note's vector", |l| {
        l.head_text(id).is_some_and(|text| text.contains(&header))
    });
}

fn reopen(l: &mut Lane) {
    l.e.open();
    l.e.facts_until(indexed);
}

fn until_edited(l: &Lane, id: &str) {
    l.until("the edit's vector", |l| {
        l.head_text(id)
            .is_some_and(|text| text.contains("edited body"))
    });
}

#[test]
fn an_edit_closed_within_the_write_back_debounce_is_embedded_on_reopen() {
    let mut l = lane();
    let id = l.write("a.md", ALPHA);
    l.embedded(&id);
    l.all_embedded();

    // The close flushes the scheduled pass after the session let go of the vault, so the
    // write-back's own fact reaches no lane.
    l.edit(&id, EDITED);
    l.e.close();
    assert!(
        l.e.read("a.md").contains("edited body"),
        "the close wrote the edit"
    );

    reopen(&mut l);
    until_edited(&l, &id);
}

#[test]
fn an_edit_on_disk_while_closed_is_embedded_on_reopen() {
    let mut l = lane();
    let id = l.write("a.md", ALPHA);
    l.embedded(&id);
    l.all_embedded();
    l.e.close();
    l.e.write("a.md", &format!("{EDITED}\n"));

    // The reopen's walk reports the edit before the vault is open, and the feed drops it.
    hold_open_until_walked(
        &l,
        |fact| matches!(fact, Applied::Changed { path, .. } if path == "a.md"),
    );
    reopen(&mut l);
    until_edited(&l, &id);
}

#[test]
fn a_rename_on_disk_while_closed_is_embedded_on_reopen() {
    let mut l = lane();
    let id = l.write("alpha-note.md", ALPHA);
    l.embedded(&id);
    l.all_embedded();
    until_titled(&l, &id, "alpha-note");
    l.e.close();
    std::fs::rename(
        l.e.vault.join("alpha-note.md"),
        l.e.vault.join("renamed-note.md"),
    )
    .unwrap();

    hold_open_until_walked(
        &l,
        |fact| matches!(fact, Applied::Renamed { new_path, .. } if new_path == "renamed-note.md"),
    );
    reopen(&mut l);
    until_titled(&l, &id, "renamed-note");
}

#[test]
fn a_rename_whose_event_embedded_nothing_before_the_close_is_embedded_on_reopen() {
    let mut l = lane();
    let id = l.write("alpha-note.md", ALPHA);
    l.embedded(&id);
    l.all_embedded();

    // The rename's event reaches the lane while it defers (an index build), and the close
    // drops what the drain would have run.
    l.indexing.store(true, std::sync::atomic::Ordering::SeqCst);
    std::fs::rename(
        l.e.vault.join("alpha-note.md"),
        l.e.vault.join("renamed-note.md"),
    )
    .unwrap();
    l.e.facts_until(
        |fact| matches!(fact, Applied::Renamed { new_path, .. } if new_path == "renamed-note.md"),
    );
    l.settled();
    l.e.close();
    l.indexing.store(false, std::sync::atomic::Ordering::SeqCst);

    reopen(&mut l);
    until_titled(&l, &id, "renamed-note");
}

/// The hash a note's vectors record, from `note_embedding_hashes`.
fn recorded_hash(l: &Lane, id: &str) -> Option<String> {
    let id = id.to_owned();
    l.query(move |conn| {
        conn.query_row(
            "SELECT content_hash FROM note_embedding_hashes WHERE note_id = ?1",
            [id],
            |row| row.get(0),
        )
        .optional()
        .map(Option::flatten)
    })
}

#[test]
fn a_refused_outside_edit_records_the_hash_of_the_bytes_it_embedded() {
    let mut l = lane();
    let id = l.write("a.md", ALPHA);
    l.embedded(&id);
    l.all_embedded();

    // As the tier leaves a file whose outside edit the document refused: the document's hash
    // in `note_files`, the file's bytes in `note_file_hashes`.
    let note = id.clone();
    l.e.core()
        .db_handle()
        .call_blocking(move |conn| {
            Ok(conn
                .execute(
                    "UPDATE note_files SET content_hash = 'refused0' WHERE note_id = ?1",
                    [note],
                )
                .unwrap())
        })
        .unwrap();
    let embeds = l.embeds();
    l.publish(&id);
    l.until("the lane embedded the published note", |l| {
        l.embeds() > embeds
    });
    l.all_embedded();

    assert_eq!(
        recorded_hash(&l, &id),
        Some(content_hash(&l.e.read("a.md"))),
        "the hash names the bytes the vectors were built from"
    );
    assert!(l.owed().is_empty(), "the embedded bytes are on disk");
}

#[test]
fn an_index_from_before_the_hashes_embeds_once_and_keeps_every_vector() {
    let mut l = lane();
    let ids: Vec<String> = [("a.md", ALPHA), ("b.md", BETA)]
        .into_iter()
        .map(|(rel, text)| l.write(rel, text))
        .collect();
    for id in &ids {
        l.embedded(id);
    }
    l.all_embedded();
    l.e.close();

    // As a build without migration 0011 left it: vectors and state rows, no hashes.
    let index = rusqlite::Connection::open(l.e.vault.join(".memry/core/index.db")).unwrap();
    index
        .execute_batch("DROP TABLE IF EXISTS note_embedding_hashes; PRAGMA user_version = 10;")
        .unwrap();
    drop(index);

    let (gate, reached) = l.hold_next();
    let embeds = l.embeds();
    reopen(&mut l);
    reached
        .recv_timeout(WAIT)
        .expect("the upgrade embedded the notes again");
    for id in &ids {
        assert!(l.head(id).is_some(), "{id} lost its vector while owed");
    }
    gate.release();
    l.all_embedded();
    let upgraded = l.embeds();
    assert_eq!(
        upgraded - embeds,
        2 * ids.len(),
        "one head and one similarity vector each"
    );

    l.e.close();
    reopen(&mut l);
    l.all_embedded();
    assert_eq!(l.embeds(), upgraded, "the next open embedded again");
}
