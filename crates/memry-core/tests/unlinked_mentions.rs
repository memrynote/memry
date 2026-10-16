//! Unlinked mentions (#3320): the `unlinked-mentions` vectors, and the query
//! over a reindexed vault.

mod support;

use std::sync::Arc;

use memry_core::crdt::registry::UpdateSink;
use memry_core::crdt::{DocumentRegistry, update_log};
use memry_core::domain::notes::{self, NewNote};
use memry_core::domain::search;
use memry_core::domain::unlinked_mentions::{find_plain_mentions, unlinked_mentions};
use memry_core::storage::migrations::{self, DATA_MIGRATIONS, INDEX_MIGRATIONS};
use rusqlite::Connection;
use serde_json::Value;
use support::vector_file;
use yrs::{ReadTxn as _, Xml as _, XmlElementPrelim, XmlFragment as _, XmlTextPrelim};

const NOW: i64 = 1_760_000_000_000;
const DEVICE: &str = "device-a";

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .expect("an array")
        .iter()
        .map(|item| item.as_str().expect("a string").to_owned())
        .collect()
}

#[test]
fn mentions_match_the_committed_vectors() {
    let file = vector_file("unlinked-mentions");
    let cases = file["cases"].as_array().expect("cases");
    assert_eq!(Some(cases.len() as u64), file["meta"]["caseCount"].as_u64());
    for case in cases {
        let name = case["name"].as_str().expect("named");
        let text = case["text"].as_str().expect("text");
        let found: Vec<String> = find_plain_mentions(text, &strings(&case["names"]))
            .into_iter()
            .map(|mention| mention.text)
            .collect();
        assert_eq!(found, strings(&case["expected"]), "{name}");
    }
}

/// One paragraph of `text`, then one wiki link per target.
fn write_body(data: &Connection, id: &str, text: &str, targets: &[&str]) {
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
            paragraph.push_back(txn, XmlTextPrelim::new(text));
            for target in targets {
                let link = paragraph.push_back(txn, XmlElementPrelim::empty("wikiLink"));
                link.insert_attribute(txn, "target", *target);
                link.push_back(txn, XmlTextPrelim::new(*target));
            }
        })
        .expect("a write transaction");
    let update = captured
        .lock()
        .expect("lock")
        .first()
        .cloned()
        .expect("one update");
    update_log::append_server_update(data, id, 1, &update, NOW).expect("the body update");
}

fn note(data: &Connection, id: &str, title: &str, text: &str, targets: &[&str]) {
    let new = NewNote {
        id,
        title,
        folder_path: None,
        content: "",
        tags: &[],
        properties: None,
        emoji: None,
    };
    notes::create(data, &new, DEVICE, NOW).expect("create the note");
    if !text.is_empty() || !targets.is_empty() {
        write_body(data, id, text, targets);
    }
}

#[test]
fn lists_sources_that_mention_without_linking() {
    let mut data = Connection::open_in_memory().expect("data.db");
    migrations::run(&mut data, DATA_MIGRATIONS).expect("data migrations");
    let mut index = Connection::open_in_memory().expect("index.db");
    migrations::run(&mut index, INDEX_MIGRATIONS).expect("index migrations");

    note(&data, "target", "Project Plan", "", &[]);
    notes::set_aliases(&data, "target", &["Roadmap".to_owned()], DEVICE, NOW).expect("aliases");
    note(
        &data,
        "mentions",
        "Standup",
        "Talked about the project plan and the roadmap.",
        &[],
    );
    note(
        &data,
        "links",
        "Linked",
        "The project plan again ",
        &["Project Plan"],
    );
    note(
        &data,
        "partial",
        "Planner",
        "Projects planned: roadmaps.",
        &[],
    );
    note(&data, "self", "Other", "", &[]);
    search::reindex(&data, &index, NOW).expect("reindex");

    let found = unlinked_mentions(&data, &index, "target").expect("unlinked mentions");
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].source_id, "mentions");
    assert_eq!(found[0].source_title, "Standup");
    assert_eq!(found[0].source_kind, "note");
    assert_eq!(found[0].mentions, ["project plan", "roadmap"]);

    assert!(
        unlinked_mentions(&data, &index, "missing")
            .expect("nothing")
            .is_empty()
    );
}
