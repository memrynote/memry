//! Inbound wiki links follow a note rename, a note move and a folder rename
//! (desktop's `rewriteWikiLinksToNote`, #1711), through the `NotesWriter`
//! the iOS shell calls.
//!
//! Real SQLite, real Yjs documents. A source body is seeded as a peer's
//! update; the rewrite must land as a local update queued for sync, with the
//! node's `alias` and the paragraph's text untouched.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use memry_core::api::errors::{SecureStoreError, StorageError};
use memry_core::api::notes_write::NotesWriter;
use memry_core::api::vault::Vault;
use memry_core::crdt::registry::UpdateSink;
use memry_core::crdt::{DocumentRegistry, update_log};
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_core::storage::{Db, open_data};
use rusqlite::Connection;
use yrs::{Any, ReadTxn as _, Xml as _, XmlElementPrelim, XmlFragment as _, XmlTextPrelim};

struct MemoryStore(Mutex<HashMap<String, Vec<u8>>>);

impl SecureStore for MemoryStore {
    fn get(&self, key: SecureStoreKey) -> Result<Option<Vec<u8>>, SecureStoreError> {
        Ok(self
            .0
            .lock()
            .expect("lock")
            .get(&format!("{key:?}"))
            .cloned())
    }
    fn set(&self, key: SecureStoreKey, value: Vec<u8>) -> Result<(), SecureStoreError> {
        self.0
            .lock()
            .expect("lock")
            .insert(format!("{key:?}"), value);
        Ok(())
    }
    fn delete(&self, key: SecureStoreKey) -> Result<(), SecureStoreError> {
        self.0.lock().expect("lock").remove(&format!("{key:?}"));
        Ok(())
    }
    fn clear(&self) -> Result<(), SecureStoreError> {
        self.0.lock().expect("lock").clear();
        Ok(())
    }
}

struct Fixture {
    vault: Vault,
    writer: Arc<NotesWriter>,
    db: Db,
}

fn fixture(label: &str) -> Fixture {
    let dir: PathBuf = tempfile::Builder::new()
        .prefix(&format!("memry-link-rewrite-{label}-"))
        .tempdir()
        .expect("the scratch directory")
        .keep();
    std::fs::create_dir_all(&dir).expect("the scratch directory");
    let vault = Vault::open("vault-1".to_string(), dir.display().to_string()).expect("open");
    let mut secret = vec![7u8; 32];
    secret.extend_from_slice(&[9u8; 32]);
    let store: Arc<dyn SecureStore> = Arc::new(MemoryStore(Mutex::new(HashMap::from([(
        format!("{:?}", SecureStoreKey::DeviceSigningKey),
        secret,
    )]))));
    let writer = vault.notes_writer(store).expect("a writer");
    let db = open_data(&dir.join("data.db")).expect("second open");
    Fixture { vault, writer, db }
}

impl Fixture {
    fn note(&self, title: &str, folder: Option<&str>) -> String {
        self.writer
            .create(title.to_string(), folder.map(str::to_string))
            .expect("create")
    }

    /// A note whose one paragraph is `before [link] middle [link] after`,
    /// each link carrying `(target, alias)`.
    fn linking(&self, links: &[(&str, &str)]) -> String {
        let id = self.note("Source", None);
        let update = paragraph_update(&id, links);
        self.db
            .call_blocking(|conn: &mut Connection| {
                update_log::append_server_update(conn, &id, 1, &update, 1).map_err(|error| {
                    StorageError::Failed {
                        what: error.to_string(),
                    }
                })
            })
            .expect("the body");
        id
    }

    /// `(text, target, alias)` for every run of the note's first block.
    fn runs(&self, id: &str) -> Vec<(String, Option<String>, Option<String>)> {
        let blocks = self
            .vault
            .notes()
            .blocks(id.to_string())
            .expect("blocks")
            .expect("a body");
        blocks[0]
            .inline
            .iter()
            .map(|run| {
                (
                    run.text.clone(),
                    run.target.clone(),
                    run.mark_attrs.get("wikiLink.alias").cloned(),
                )
            })
            .collect()
    }

    fn targets(&self, id: &str) -> Vec<String> {
        self.runs(id).into_iter().filter_map(|run| run.1).collect()
    }

    fn queued_body_updates(&self, id: &str) -> i64 {
        self.db
            .call_blocking(|conn: &mut Connection| {
                conn.query_row(
                    "SELECT COUNT(*) FROM outbox WHERE item_id = ?1 AND payload IS NOT NULL",
                    [id],
                    |row| row.get(0),
                )
                .map_err(|error| StorageError::Failed {
                    what: error.to_string(),
                })
            })
            .expect("the count")
    }
}

/// desktop's wikiLink atom: `target` and `alias` attributes, no text child.
fn paragraph_update(doc_id: &str, links: &[(&str, &str)]) -> Vec<u8> {
    let captured: Arc<Mutex<Vec<Vec<u8>>>> = Arc::new(Mutex::new(Vec::new()));
    let sink: UpdateSink = {
        let captured = Arc::clone(&captured);
        Arc::new(move |_, bytes: &[u8]| captured.lock().expect("lock").push(bytes.to_vec()))
    };
    let document = DocumentRegistry::new("device-peer", sink)
        .get_or_open(doc_id)
        .expect("open");
    document
        .write(|txn| {
            let fragment = txn.get_xml_fragment("prosemirror").expect("typed at open");
            let group = fragment.push_back(txn, XmlElementPrelim::empty("blockGroup"));
            let container = group.push_back(txn, XmlElementPrelim::empty("blockContainer"));
            container.insert_attribute(txn, "id", "b1");
            let paragraph = container.push_back(txn, XmlElementPrelim::empty("paragraph"));
            paragraph.push_back(txn, XmlTextPrelim::new("before "));
            for (target, alias) in links {
                let link = paragraph.push_back(txn, XmlElementPrelim::empty("wikiLink"));
                link.insert_attribute(txn, "target", *target);
                link.insert_attribute(txn, "alias", *alias);
                paragraph.push_back(txn, XmlTextPrelim::new(" middle "));
            }
            paragraph.push_back(txn, XmlTextPrelim::new("after"));
        })
        .expect("a write");
    captured.lock().expect("lock").remove(0)
}

#[test]
fn a_title_link_follows_a_rename_keeping_heading_alias_and_text() {
    let f = fixture("title");
    let plan = f.note("Plan", None);
    let source = f.linking(&[("plan#Goals#Q1", "the plan"), ("Other", "")]);
    let before = f.runs(&source);
    assert_eq!(f.queued_body_updates(&source), 0);

    f.writer
        .rename(plan, "Roadmap".to_string())
        .expect("rename");

    let after = f.runs(&source);
    assert_eq!(f.targets(&source), ["Roadmap#Goals#Q1", "Other"]);
    // Everything but the one target is byte-for-byte what it was.
    let strip = |runs: Vec<(String, Option<String>, Option<String>)>| -> Vec<_> {
        runs.into_iter()
            .map(|(text, _, alias)| (text, alias))
            .collect()
    };
    assert_eq!(strip(after), strip(before));
    assert_eq!(f.queued_body_updates(&source), 1, "the rewrite must sync");
}

#[test]
fn a_path_link_follows_a_move_in_the_form_it_was_written() {
    let f = fixture("move");
    let plan = f.note("Plan", Some("Work"));
    let source = f.linking(&[
        ("/work/plan.md#Goals", "goals"),
        ("Work/Plan#A#B", ""),
        ("Plan", "by title"),
    ]);

    f.writer
        .move_to_folder(plan, Some("Archive/2026".to_string()))
        .expect("move");

    assert_eq!(
        f.targets(&source),
        [
            "/Archive/2026/Plan.md#Goals",
            "Archive/2026/Plan#A#B",
            "Plan"
        ]
    );
    let aliases: Vec<_> = f
        .runs(&source)
        .into_iter()
        .filter_map(|run| run.2)
        .collect();
    assert_eq!(aliases, ["goals", "", "by title"]);
}

#[test]
fn a_folder_rename_rewrites_path_links_to_the_notes_inside_it() {
    let f = fixture("folder");
    f.note("Plan", Some("Work"));
    f.note("Deep", Some("Work/Sub"));
    let source = f.linking(&[
        ("Work/Plan", ""),
        ("/Work/Sub/Deep#H", "deep"),
        ("Workshop/Plan", ""),
    ]);

    f.writer
        .rename_folder("Work".to_string(), "Office".to_string())
        .expect("rename folder");

    assert_eq!(
        f.targets(&source),
        ["Office/Plan", "/Office/Sub/Deep#H", "Workshop/Plan"]
    );
}

#[test]
fn a_link_to_another_note_is_left_alone() {
    let f = fixture("other");
    let work = f.note("Plan", Some("Work"));
    f.note("Plan", Some("Home"));
    let sprint4 = f.note("Sprint #4", None);
    f.note("Sprint", None);
    let source = f.linking(&[("Home/Plan", ""), ("Sprint #4", "")]);

    f.writer
        .move_to_folder(work, Some("Archive".to_string()))
        .expect("move");
    // `Sprint #4` resolves to heading `4` of `Sprint`, so it never named
    // the note being renamed.
    f.writer
        .rename(sprint4, "Sprint #5".to_string())
        .expect("rename");

    assert_eq!(f.targets(&source), ["Home/Plan", "Sprint #4"]);
    assert_eq!(
        f.queued_body_updates(&source),
        0,
        "nothing changed, nothing ships"
    );
}

/// A paragraph holding only a wikiLink with the display attributes of #2845:
/// `size` as a string, `cover` and `preview` as booleans, the way the editor
/// writes them.
fn card_update(doc_id: &str, target: &str) -> Vec<u8> {
    let captured: Arc<Mutex<Vec<Vec<u8>>>> = Arc::new(Mutex::new(Vec::new()));
    let sink: UpdateSink = {
        let captured = Arc::clone(&captured);
        Arc::new(move |_, bytes: &[u8]| captured.lock().expect("lock").push(bytes.to_vec()))
    };
    let document = DocumentRegistry::new("device-peer", sink)
        .get_or_open(doc_id)
        .expect("open");
    document
        .write(|txn| {
            let fragment = txn.get_xml_fragment("prosemirror").expect("typed at open");
            let group = fragment.push_back(txn, XmlElementPrelim::empty("blockGroup"));
            let container = group.push_back(txn, XmlElementPrelim::empty("blockContainer"));
            container.insert_attribute(txn, "id", "b1");
            let paragraph = container.push_back(txn, XmlElementPrelim::empty("paragraph"));
            let link = paragraph.push_back(txn, XmlElementPrelim::empty("wikiLink"));
            link.insert_attribute(txn, "target", target);
            link.insert_attribute(txn, "size", "medium");
            link.insert_attribute(txn, "cover", Any::Bool(true));
            link.insert_attribute(txn, "preview", Any::Bool(true));
        })
        .expect("a write");
    captured.lock().expect("lock").remove(0)
}

/// #2845: a rename re-points `target` and leaves the card's display attributes.
#[test]
fn a_rename_keeps_a_link_cards_display_attributes() {
    let f = fixture("card");
    let plan = f.note("Plan", None);
    let source = f.note("Source", None);
    let update = card_update(&source, "Plan");
    f.db.call_blocking(|conn: &mut Connection| {
        update_log::append_server_update(conn, &source, 1, &update, 1).map_err(|error| {
            StorageError::Failed {
                what: error.to_string(),
            }
        })
    })
    .expect("the body");

    f.writer
        .rename(plan, "Roadmap".to_string())
        .expect("rename");

    let blocks = f
        .vault
        .notes()
        .blocks(source)
        .expect("blocks")
        .expect("a body");
    let run = &blocks[0].inline[0];
    assert_eq!(run.target.as_deref(), Some("Roadmap"));
    let attr = |name: &str| run.mark_attrs.get(&format!("wikiLink.{name}")).cloned();
    assert_eq!(attr("size").as_deref(), Some("medium"));
    assert_eq!(attr("cover").as_deref(), Some("true"));
    assert_eq!(attr("preview").as_deref(), Some("true"));
}
