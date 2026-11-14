//! What the embedding lane owes is read from `index.db` and `note_files`, never from an event
//! (VERIFY-4656): each vector records the `note_files` content hash it was built from, and the
//! reconcile embeds every note whose hash moved since. An edit whose event a close dropped, an
//! edit made while the app was closed, and an index from before the hashes are each embedded
//! on the next open.
//!
//! | Test                                                      | Owed because                     |
//! | --------------------------------------------------------- | -------------------------------- |
//! | an edit closed within the write-back debounce is embedded | the close's write-back moved it  |
//! | an edit on disk while closed is embedded on reopen        | the open's walk moved it         |
//! | an index from before the hashes embeds once, keeps all    | no hash recorded                 |

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use memry_desktop::session::OpenStage;
use memry_desktop::vault::consumer::Applied;

use crate::embedding_lane::{ALPHA, BETA, Lane, lane};
use crate::vault_env::{WAIT, indexed};

const EDITED: &str = "Alpha now holds an edited body instead.";

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
    l.settled();

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
    l.settled();
    l.e.close();
    l.e.write("a.md", &format!("{EDITED}\n"));

    // The reopen's walk reports the edit before the vault is open, and the feed drops it: this
    // hook holds the open until the feed has seen the fact.
    let walked = Mutex::new(l.e.tier.subscribe());
    l.e.session.on_open(
        "embedding-owed-walk",
        OpenStage::Defaults,
        Arc::new(move |_| {
            let mut walked = walked.lock().unwrap();
            let deadline = Instant::now() + WAIT;
            while Instant::now() < deadline {
                match walked.try_recv() {
                    Ok(Applied::Changed { path, .. }) if path == "a.md" => {
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
    reopen(&mut l);
    until_edited(&l, &id);
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
    l.settled();
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
    l.until("every note embedded again", |l| l.owed().is_empty());
    l.settled();
    let upgraded = l.embeds();
    assert_eq!(
        upgraded - embeds,
        2 * ids.len(),
        "one head and one similarity vector each"
    );

    l.e.close();
    reopen(&mut l);
    l.settled();
    assert_eq!(l.embeds(), upgraded, "the next open embedded again");
}
