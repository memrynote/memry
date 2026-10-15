use std::sync::Arc;

use memry_core::crdt::registry::UpdateSink;
use memry_core::crdt::{DocumentRegistry, update_log};
use memry_core::domain::note_meta;
use memry_core::domain::notes::{self, NewNote};
use memry_core::domain::search;
use memry_core::domain::wiki_target;
use memry_core::storage::migrations::{self, DATA_MIGRATIONS, INDEX_MIGRATIONS};
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use rusqlite::{Connection, OptionalExtension as _};
use serde_json::{Value, json};
use yrs::{ReadTxn as _, Xml as _, XmlElementPrelim, XmlFragment as _, XmlTextPrelim};

const NOW: i64 = 1_760_000_000_000;
const DEVICE: &str = "device-a";

fn databases() -> (Connection, Connection) {
    let mut data = Connection::open_in_memory().expect("data.db");
    migrations::run(&mut data, DATA_MIGRATIONS).expect("data migrations");
    let mut index = Connection::open_in_memory().expect("index.db");
    migrations::run(&mut index, INDEX_MIGRATIONS).expect("index migrations");
    (data, index)
}

fn pull(data: &Connection, item_type: &str, id: &str, payload: Value, at: i64) {
    let record = InboundRecord {
        item_type: item_type.to_owned(),
        item_id: id.to_owned(),
        payload_json: payload.to_string(),
        server_cursor: Some(1),
        signer_device_id: Some("device-b".to_owned()),
        updated_at: at,
        deleted_at: None,
    };
    sync_items::apply_remote(data, &record, at).expect("apply");
}

fn note(data: &Connection, id: &str, title: &str, at: i64) {
    let new = NewNote {
        id,
        title,
        folder_path: None,
        content: "",
        tags: &[],
        properties: None,
        emoji: None,
    };
    notes::create(data, &new, DEVICE, at).expect("create the note");
}

fn linking(data: &Connection, id: &str, target: &str, at: i64) {
    note(data, id, id, at);
    let captured: Arc<std::sync::Mutex<Vec<Vec<u8>>>> = Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink: UpdateSink = {
        let captured = Arc::clone(&captured);
        Arc::new(move |_, bytes: &[u8]| captured.lock().expect("lock").push(bytes.to_vec()))
    };
    let document = DocumentRegistry::new("device-peer", sink)
        .get_or_open(id)
        .expect("open");
    document
        .write(|txn| {
            let fragment = txn
                .get_xml_fragment("prosemirror")
                .expect("the root is typed at open");
            let group = fragment.push_back(txn, XmlElementPrelim::empty("blockGroup"));
            let container = group.push_back(txn, XmlElementPrelim::empty("blockContainer"));
            let paragraph = container.push_back(txn, XmlElementPrelim::empty("paragraph"));
            let link = paragraph.push_back(txn, XmlElementPrelim::empty("wikiLink"));
            link.insert_attribute(txn, "target", target);
            link.push_back(txn, XmlTextPrelim::new(target));
        })
        .expect("a write transaction");
    let update = captured
        .lock()
        .expect("lock")
        .first()
        .cloned()
        .expect("one update");
    update_log::append_server_update(data, id, 1, &update, at).expect("the body update");
}

fn set_aliases(data: &Connection, id: &str, aliases: &[&str], at: i64) {
    let aliases: Vec<String> = aliases.iter().map(|alias| (*alias).to_owned()).collect();
    notes::set_aliases(data, id, &aliases, DEVICE, at).expect("set aliases");
}

fn linked(index: &Connection, source: &str) -> Option<String> {
    index
        .query_row(
            "SELECT target_id FROM note_links WHERE source_id = ?1",
            [source],
            |row| row.get(0),
        )
        .optional()
        .expect("read note_links")
        .expect("one link row")
}

fn reindex(data: &Connection, index: &Connection, at: i64) -> search::Reindexed {
    search::reindex(data, index, at).expect("reindex")
}

fn aliases(data: &Connection, id: &str) -> Vec<String> {
    note_meta::metadata(data, id)
        .expect("read")
        .expect("the note")
        .aliases
}

#[test]
fn a_payload_without_aliases_keeps_them_and_an_empty_list_clears_them() {
    let (data, _index) = databases();
    pull(
        &data,
        "note",
        "n1",
        json!({ "title": "Kaan", "aliases": ["K."] }),
        NOW,
    );
    pull(&data, "note", "n1", json!({ "title": "Kaan" }), NOW + 1);
    assert_eq!(aliases(&data, "n1"), ["K."], "absent keeps");
    pull(
        &data,
        "note",
        "n1",
        json!({ "title": "Kaan", "aliases": null }),
        NOW + 2,
    );
    assert_eq!(aliases(&data, "n1"), ["K."], "null keeps");
    pull(
        &data,
        "note",
        "n1",
        json!({ "title": "Kaan", "aliases": [] }),
        NOW + 3,
    );
    assert!(aliases(&data, "n1").is_empty(), "[] clears");
}

#[test]
fn a_journal_day_keeps_and_clears_its_aliases_the_same_way() {
    let (data, _index) = databases();
    let day = |payload: Value, at: i64| pull(&data, "journal", "j2099-06-15", payload, at);
    let named = |data: &Connection| {
        wiki_target::resolve(data, "Kickoff Day")
            .expect("resolve")
            .map(|found| found.id)
    };
    day(
        json!({ "date": "2099-06-15", "aliases": ["Kickoff Day"] }),
        NOW,
    );
    day(json!({ "date": "2099-06-15" }), NOW + 1);
    assert_eq!(named(&data).as_deref(), Some("j2099-06-15"), "absent keeps");
    day(json!({ "date": "2099-06-15", "aliases": null }), NOW + 2);
    assert_eq!(named(&data).as_deref(), Some("j2099-06-15"), "null keeps");
    day(json!({ "date": "2099-06-15", "aliases": [] }), NOW + 3);
    assert_eq!(named(&data), None, "[] clears");
}

#[test]
fn a_link_follows_an_alias_added_and_removed() {
    let (data, index) = databases();
    linking(&data, "source", "Herbert", NOW);
    note(&data, "herbert", "Frank Herbert", NOW + 1);
    assert!(reindex(&data, &index, NOW).full);
    assert_eq!(linked(&index, "source"), None);

    set_aliases(&data, "herbert", &["Herbert"], NOW + 10);
    assert!(!reindex(&data, &index, NOW + 10).full);
    assert_eq!(linked(&index, "source").as_deref(), Some("herbert"));

    set_aliases(&data, "herbert", &[], NOW + 20);
    reindex(&data, &index, NOW + 20);
    assert_eq!(linked(&index, "source"), None);
}

#[test]
fn a_link_follows_a_title_renamed_by_a_peer() {
    let (data, index) = databases();
    linking(&data, "source", "Plan", NOW);
    pull(&data, "note", "plan", json!({ "title": "Plan" }), NOW + 1);
    reindex(&data, &index, NOW);
    assert_eq!(linked(&index, "source").as_deref(), Some("plan"));

    pull(
        &data,
        "note",
        "plan",
        json!({ "title": "Roadmap" }),
        NOW + 10,
    );
    reindex(&data, &index, NOW + 10);
    assert_eq!(linked(&index, "source"), None);

    pull(&data, "note", "plan", json!({ "title": "PLAN" }), NOW + 20);
    reindex(&data, &index, NOW + 20);
    assert_eq!(linked(&index, "source").as_deref(), Some("plan"));
}

#[test]
fn a_new_title_takes_a_link_from_an_alias_holder() {
    let (data, index) = databases();
    linking(&data, "source", "team", NOW);
    note(&data, "a-shared", "Shared", NOW + 1);
    set_aliases(&data, "a-shared", &["Team"], NOW + 1);
    reindex(&data, &index, NOW);
    assert_eq!(linked(&index, "source").as_deref(), Some("a-shared"));

    note(&data, "z-team", "Team", NOW + 10);
    reindex(&data, &index, NOW + 10);
    assert_eq!(linked(&index, "source").as_deref(), Some("z-team"));
}

#[test]
fn a_link_follows_a_deleted_note_to_the_next_holder() {
    let (data, index) = databases();
    linking(&data, "source", "Team", NOW);
    note(&data, "a-first", "First", NOW + 1);
    note(&data, "b-second", "Second", NOW + 1);
    set_aliases(&data, "a-first", &["Team"], NOW + 1);
    set_aliases(&data, "b-second", &["team"], NOW + 1);
    reindex(&data, &index, NOW);
    assert_eq!(linked(&index, "source").as_deref(), Some("a-first"));

    notes::delete(&data, "a-first", DEVICE, NOW + 10).expect("delete");
    reindex(&data, &index, NOW + 10);
    assert_eq!(linked(&index, "source").as_deref(), Some("b-second"));
}

#[test]
fn a_path_link_follows_a_move_and_a_new_attachment() {
    let (data, index) = databases();
    linking(&data, "source", "Work/Plan", NOW);
    linking(&data, "file-source", "/Docs/spec.pdf", NOW);
    note(&data, "plan", "Plan", NOW + 1);
    reindex(&data, &index, NOW + 1);
    assert_eq!(linked(&index, "source"), None);

    notes::move_to_folder(&data, "plan", Some("Work"), DEVICE, NOW + 10).expect("move");
    let file = json!({ "title": "spec", "folderPath": "Docs", "fileType": "pdf" });
    pull(&data, "note", "spec", file, NOW + 10);
    reindex(&data, &index, NOW + 10);
    assert_eq!(linked(&index, "source").as_deref(), Some("plan"));
    assert_eq!(linked(&index, "file-source").as_deref(), Some("spec"));
}
