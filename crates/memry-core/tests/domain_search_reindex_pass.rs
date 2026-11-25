//! `ReindexPass` driven one step at a time, with writes landing between the
//! steps the way a sync pass's do while `data.db` is let go (#5842).
//!
//! Real SQLite, the vault's own `Db`, a real `index.db`. Each test controls
//! the clock a step reads, so the same-millisecond cases are exact.
//!
//! | Test                                                      | Rule                                  |
//! | --------------------------------------------------------- | ------------------------------------- |
//! | an edit in the millisecond its batch read is indexed again | a stamp not older than the read relists |
//! | an unstamped row renamed during a pass is indexed again   | NULL `synced_at` is never skipped      |
//! | a pass dropped after one step leaves the next one full    | stamps move only with the last step    |
//! | a rename and a delete between steps leave search right    | no stale row, links follow the rename  |
//! | a vault that keeps changing still ends the pass           | catch-up rounds are bounded            |

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use memry_core::api::search::BacklinkOrder;
use memry_core::api::vault::Vault;
use memry_core::crdt::DocumentRegistry;
use memry_core::crdt::epoch::HeldBody;
use memry_core::crdt::registry::UpdateSink;
use memry_core::domain::notes::{self, NewNote};
use memry_core::domain::search::{
    CATCH_UP_ROUNDS, NOTES_WATERMARK_KEY, ReindexPass, ReindexStep, STAMPS_KEY,
};
use memry_core::storage::{Db, open_index};
use rusqlite::{Connection, OptionalExtension as _};
use yrs::{ReadTxn as _, Xml as _, XmlElementPrelim, XmlFragment as _, XmlTextPrelim};

const T: i64 = 1_760_000_000_000;
const DEVICE: &str = "device-a";

static SCRATCH: AtomicU64 = AtomicU64::new(0);

struct Fixture {
    vault: Vault,
    data: Db,
    index: Db,
}

fn fixture(label: &str) -> Fixture {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir: PathBuf = std::env::temp_dir().join(format!(
        "memry-reindex-pass-{label}-{}-{unique}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("the scratch directory");
    let vault = Vault::open("vault-1".to_string(), dir.display().to_string()).expect("open");
    Fixture {
        data: vault.db_handle(),
        index: open_index(&dir.join("index.db")).expect("index.db").db,
        vault,
    }
}

impl Fixture {
    fn step(&self, pass: &mut ReindexPass, now: i64, batch: usize) -> ReindexStep {
        self.data
            .call_blocking(|data| {
                self.index
                    .call_blocking(|index| pass.step(data, index, now, batch))
            })
            .expect("a step")
    }

    fn write(&self, f: impl FnOnce(&Connection)) {
        self.data
            .call_blocking(|conn: &mut Connection| {
                f(conn);
                Ok(())
            })
            .expect("the write");
    }

    fn note(&self, id: &str, title: &str, body: Option<Vec<u8>>) {
        self.write(|conn| {
            let note = NewNote {
                id,
                title,
                folder_path: None,
                content: "",
                tags: &[],
                properties: None,
                emoji: None,
            };
            notes::create(conn, &note, DEVICE, T).expect("create");
            if let Some(body) = body {
                append(conn, id, 1, &body, T);
            }
        });
    }

    fn meta(&self, key: &str) -> Option<String> {
        self.index
            .call_blocking(|index| {
                index
                    .query_row(
                        "SELECT value FROM index_meta WHERE key = ?1",
                        [key],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(|error| memry_core::api::errors::StorageError::Failed {
                        what: error.to_string(),
                    })
            })
            .expect("index_meta")
    }

    fn found(&self, word: &str) -> Vec<String> {
        let search = self.vault.search(None).expect("search");
        let hits = search.search(word.to_string(), None, 10).expect("search");
        hits.notes.into_iter().map(|hit| hit.id).collect()
    }
}

fn run_to_end(fx: &Fixture, pass: &mut ReindexPass, now: i64, batch: usize) {
    while let ReindexStep::More = fx.step(pass, now, batch) {}
}

fn append(conn: &Connection, id: &str, sequence: i64, update: &[u8], at: i64) {
    HeldBody::never_purged(conn, id)
        .and_then(|held| held.append_server_update(sequence, update, at))
        .expect("the body update");
}

/// A real lib0 v1 update with one paragraph, from a peer named for its text so
/// two updates to one document are never duplicates of each other.
fn paragraph(doc_id: &str, text: &str, link: Option<&str>) -> Vec<u8> {
    let captured: Arc<std::sync::Mutex<Vec<Vec<u8>>>> = Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink: UpdateSink = {
        let captured = Arc::clone(&captured);
        Arc::new(move |_, bytes: &[u8]| captured.lock().expect("lock").push(bytes.to_vec()))
    };
    let document = DocumentRegistry::new(&format!("peer-{text}"), sink)
        .get_or_open(doc_id)
        .expect("open");
    document
        .write(|txn| {
            let fragment = txn
                .get_xml_fragment("prosemirror")
                .expect("the root is typed at open");
            let group = fragment.push_back(txn, XmlElementPrelim::empty("blockGroup"));
            let container = group.push_back(txn, XmlElementPrelim::empty("blockContainer"));
            let paragraph = container.push_back(txn, XmlElementPrelim::empty("paragraph"));
            match link {
                Some(target) => {
                    let link = paragraph.push_back(txn, XmlElementPrelim::empty("wikiLink"));
                    link.insert_attribute(txn, "target", target);
                    link.push_back(txn, XmlTextPrelim::new(text));
                }
                None => {
                    paragraph.push_back(txn, XmlTextPrelim::new(text));
                }
            }
        })
        .expect("a write transaction");
    captured
        .lock()
        .expect("lock")
        .first()
        .cloned()
        .expect("one update")
}

#[test]
fn an_edit_in_the_millisecond_its_batch_read_is_indexed_again() {
    let fx = fixture("same-ms");
    for id in ["n0", "n1", "n2"] {
        fx.note(id, id, Some(paragraph(id, "cardamom", None)));
    }
    let mut pass = ReindexPass::default();
    // The first batch reads n0 at T, the millisecond its rows are stamped.
    assert!(matches!(fx.step(&mut pass, T, 1), ReindexStep::More));
    // An edit in that same millisecond, after the batch let go.
    fx.write(|conn| append(conn, "n0", 2, &paragraph("n0", "saffron", None), T));
    run_to_end(&fx, &mut pass, T + 5, 1);

    assert_eq!(fx.found("saffron"), ["n0"]);
}

#[test]
fn an_unstamped_row_renamed_during_a_pass_is_indexed_again() {
    let fx = fixture("unstamped");
    for id in ["a-unstamped", "b", "c"] {
        fx.note(id, id, None);
    }
    let unstamp = |conn: &Connection| {
        conn.execute(
            "UPDATE notes SET synced_at = NULL WHERE id = 'a-unstamped'",
            [],
        )
        .expect("unstamp");
    };
    fx.write(unstamp);
    let mut pass = ReindexPass::default();
    assert!(matches!(fx.step(&mut pass, T + 10, 1), ReindexStep::More));
    // Renamed after its batch, and left with no stamp to say so.
    fx.write(|conn| {
        notes::rename(conn, "a-unstamped", "Zanzibar", DEVICE, T + 11).expect("rename");
        unstamp(conn);
    });
    run_to_end(&fx, &mut pass, T + 20, 1);

    assert_eq!(fx.found("Zanzibar"), ["a-unstamped"]);
}

#[test]
fn a_pass_dropped_after_its_first_step_leaves_the_next_one_full() {
    let fx = fixture("dropped");
    for id in ["n0", "n1", "n2"] {
        fx.note(id, id, Some(paragraph(id, "cardamom", None)));
    }
    let mut pass = ReindexPass::default();
    assert!(matches!(fx.step(&mut pass, T + 10, 1), ReindexStep::More));
    drop(pass);

    assert_eq!(fx.meta(STAMPS_KEY), None, "no stamps before the last step");
    assert_eq!(fx.meta(NOTES_WATERMARK_KEY), None, "no watermark either");
    let summary = fx
        .vault
        .search(None)
        .expect("search")
        .reindex()
        .expect("reindex");
    assert!(summary.full, "the next pass rebuilds");
    assert_eq!(summary.notes_indexed, 3);
    assert_eq!(fx.found("cardamom").len(), 3);
}

#[test]
fn a_rename_and_a_delete_between_steps_leave_search_and_links_right() {
    let fx = fixture("rename-delete");
    // Indexed in the first batch, before its target is named.
    fx.note(
        "a-source",
        "Groceries",
        Some(paragraph("a-source", "Saffron", Some("Saffron"))),
    );
    fx.note("b-target", "Cardamom", None);
    fx.note("c-gone", "Nutmeg", None);
    fx.note("d-other", "Clove", None);
    let mut pass = ReindexPass::default();
    assert!(matches!(fx.step(&mut pass, T + 10, 3), ReindexStep::More));
    fx.write(|conn| {
        notes::rename(conn, "b-target", "Saffron", DEVICE, T + 11).expect("rename");
        notes::delete(conn, "c-gone", DEVICE, T + 11).expect("delete");
    });
    run_to_end(&fx, &mut pass, T + 20, 3);

    assert!(fx.found("Nutmeg").is_empty(), "the deleted note is gone");
    assert!(fx.found("Cardamom").is_empty(), "the old title is gone");
    assert_eq!(
        fx.found("Saffron").first().map(String::as_str),
        Some("b-target")
    );
    let search = fx.vault.search(None).expect("search");
    let backlinks: Vec<String> = search
        .backlinks("b-target".to_string(), BacklinkOrder::Recent)
        .expect("backlinks")
        .into_iter()
        .map(|link| link.source_id)
        .collect();
    assert_eq!(backlinks, ["a-source"], "the link follows the rename");
}

#[test]
fn a_vault_that_keeps_changing_still_ends_the_pass() {
    let fx = fixture("busy");
    let ids = ["n0", "n1", "n2"];
    for id in ids {
        fx.note(id, id, Some(paragraph(id, "cardamom", None)));
    }
    let batch = 1;
    let mut pass = ReindexPass::default();
    let mut steps = 0;
    let mut edits = 0;
    loop {
        steps += 1;
        let now = T + 100 * steps as i64;
        if let ReindexStep::Done(_) = fx.step(&mut pass, now, batch) {
            break;
        }
        // Two notes move after every step: more than one batch per listing.
        for id in &ids[..2] {
            edits += 1;
            fx.write(|conn| {
                append(
                    conn,
                    id,
                    1 + edits,
                    &paragraph(id, &format!("edit{edits}"), None),
                    now + 1,
                )
            });
        }
        assert!(steps < 100, "the pass never ended");
    }

    // The plan takes a step per note. Every catch-up listing finds the two
    // edited notes, a step each, and the listing after CATCH_UP_ROUNDS ends it.
    assert!(
        steps <= ids.len() + 2 * CATCH_UP_ROUNDS + 1,
        "{steps} steps"
    );
    assert_eq!(
        fx.found(&format!("edit{edits}")).len(),
        1,
        "the last edit is indexed"
    );
}
