//! Links and search across notes and journal days (spec 005-journal JP026).
//!
//! | Test                                                   | Rule                              |
//! | ------------------------------------------------------ | --------------------------------- |
//! | a day is linked to by its date, from notes and days    | desktop titles a journal by date  |
//! | a note is linked to from a journal day                 | journal bodies project links      |
//! | the j<date> form links to the day                      | desktop `dateFromJournalId`       |
//! | a link written before the day existed counts           | title match, nullable target_id   |
//! | a note titled with the date wins the link              | notes resolve first               |
//! | outgoing links name note, journal and missing targets  | resolved against data.db now      |
//! | wiki resolution: note, then day, then j<date>          | desktop wikilink resolution       |
//! | a journal body hit carries its date                    | §A.5, `SearchHit` journal date    |

use std::sync::Arc;

use memry_core::api::search::BacklinkOrder;
use memry_core::crdt::registry::UpdateSink;
use memry_core::crdt::{DocumentRegistry, update_log};
use memry_core::domain::journal;
use memry_core::domain::journal_ops::links::{self, BacklinkRow, OutgoingLink};
use memry_core::domain::note_meta::{self, WikiTargetMatch};
use memry_core::domain::notes::{self, NewNote};
use memry_core::domain::search::{self, HitKind};
use memry_core::storage::migrations::{self, DATA_MIGRATIONS, INDEX_MIGRATIONS};
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use rusqlite::Connection;
use yrs::{ReadTxn as _, Xml as _, XmlElementPrelim, XmlFragment as _, XmlTextPrelim};

const NOW: i64 = 1_760_000_000_000;
const DEVICE: &str = "device-a";
const DAY: &str = "2099-06-15";

fn databases() -> (Connection, Connection) {
    let mut data = Connection::open_in_memory().expect("data.db");
    migrations::run(&mut data, DATA_MIGRATIONS).expect("data migrations");
    let mut index = Connection::open_in_memory().expect("index.db");
    migrations::run(&mut index, INDEX_MIGRATIONS).expect("index migrations");
    (data, index)
}

/// One lib0 update: a paragraph of `text`, then one wiki link per target.
fn body_update(doc_id: &str, text: &str, targets: &[&str]) -> Vec<u8> {
    let captured: Arc<std::sync::Mutex<Vec<Vec<u8>>>> = Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink: UpdateSink = {
        let captured = Arc::clone(&captured);
        Arc::new(move |_, bytes: &[u8]| captured.lock().expect("lock").push(bytes.to_vec()))
    };
    let document = DocumentRegistry::new("device-peer", sink)
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
            paragraph.push_back(txn, XmlTextPrelim::new(text));
            for target in targets {
                let link = paragraph.push_back(txn, XmlElementPrelim::empty("wikiLink"));
                link.insert_attribute(txn, "target", *target);
                link.push_back(txn, XmlTextPrelim::new(*target));
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

fn write_body(data: &Connection, id: &str, text: &str, targets: &[&str]) {
    update_log::append_server_update(data, id, 1, &body_update(id, text, targets), NOW)
        .expect("the body update");
}

fn note(data: &Connection, id: &str, title: &str, targets: &[&str], at: i64) {
    let new = NewNote {
        id,
        title,
        folder_path: None,
        content: "",
        tags: &[],
        properties: None,
    };
    notes::create(data, &new, DEVICE, at).expect("create the note");
    if !targets.is_empty() {
        write_body(data, id, "", targets);
    }
}

/// Creates the day through the domain (id `j<date>`) and writes its body.
fn day(data: &Connection, date: &str, text: &str, targets: &[&str], at: i64) -> String {
    let opened = journal::open_day(data, date, DEVICE, at).expect("open the day");
    if !text.is_empty() || !targets.is_empty() {
        write_body(data, &opened.id, text, targets);
    }
    opened.id
}

fn reindex(data: &Connection, index: &Connection) {
    search::reindex(data, index, NOW).expect("reindex");
}

fn backlinks(data: &Connection, index: &Connection, id: &str) -> Vec<BacklinkRow> {
    links::backlinks(data, index, id, BacklinkOrder::Title).expect("backlinks")
}

fn sources(rows: &[BacklinkRow]) -> Vec<&str> {
    rows.iter().map(|row| row.source_id.as_str()).collect()
}

#[test]
fn a_day_is_linked_to_by_its_date_from_notes_and_days() {
    let (data, index) = databases();
    let target = day(&data, DAY, "the target day", &[], NOW);
    note(&data, "n1", "Plans", &[DAY], NOW + 1);
    let other = day(&data, "2099-06-16", "", &[DAY], NOW + 2);
    reindex(&data, &index);

    let stored: Option<String> = index
        .query_row(
            "SELECT target_id FROM note_links WHERE source_id = 'n1'",
            [],
            |row| row.get(0),
        )
        .expect("the projected link");
    assert_eq!(stored.as_deref(), Some(target.as_str()));

    let found = backlinks(&data, &index, &target);
    assert_eq!(sources(&found), [other.as_str(), "n1"], "{found:?}");
    let journal_source = &found[0];
    assert_eq!(journal_source.source_kind, "journal");
    assert_eq!(journal_source.source_title, "2099-06-16");
    assert_eq!(journal_source.source_date.as_deref(), Some("2099-06-16"));
    assert_eq!(journal_source.target_title, DAY);
    assert!(!journal_source.via_property);
    assert_eq!(found[1].source_kind, "note");
    assert_eq!(found[1].source_title, "Plans");
    assert_eq!(found[1].source_date, None);
}

#[test]
fn a_note_is_linked_to_from_a_journal_day() {
    let (data, index) = databases();
    note(&data, "target", "Cardamom", &[], NOW);
    let source = day(&data, DAY, "", &["Cardamom"], NOW + 1);
    note(&data, "n2", "Groceries", &["Cardamom"], NOW + 2);
    reindex(&data, &index);

    let found = links::backlinks(&data, &index, "target", BacklinkOrder::Recent).expect("links");
    assert_eq!(sources(&found), ["n2", source.as_str()], "{found:?}");
    assert_eq!(found[1].source_kind, "journal");
    assert_eq!(found[1].source_title, DAY);

    let oldest = links::backlinks(&data, &index, "target", BacklinkOrder::Oldest).expect("links");
    assert_eq!(sources(&oldest), [source.as_str(), "n2"]);
}

#[test]
fn the_j_date_form_links_to_the_day() {
    let (data, index) = databases();
    let target = day(&data, DAY, "", &[], NOW);
    note(&data, "n1", "Plans", &["j2099-06-15"], NOW + 1);
    reindex(&data, &index);

    let found = backlinks(&data, &index, &target);
    assert_eq!(sources(&found), ["n1"]);
    assert_eq!(found[0].target_title, "j2099-06-15");
}

#[test]
fn a_link_written_before_the_day_existed_counts() {
    let (data, index) = databases();
    note(&data, "n1", "Plans", &[DAY], NOW);
    reindex(&data, &index);
    assert!(
        links::outgoing_links(&data, &index, "n1").expect("out")[0]
            .target_id
            .is_none()
    );

    // The day is created after the link was indexed; the source is not
    // re-indexed, so only the title match can find it.
    let target = day(&data, DAY, "", &[], NOW + 1);
    assert_eq!(sources(&backlinks(&data, &index, &target)), ["n1"]);
}

#[test]
fn a_note_titled_with_the_date_wins_the_link() {
    let (data, index) = databases();
    let target = day(&data, DAY, "", &[], NOW);
    note(&data, "dated", DAY, &[], NOW + 1);
    note(&data, "n1", "Plans", &[DAY], NOW + 2);
    reindex(&data, &index);

    assert_eq!(sources(&backlinks(&data, &index, "dated")), ["n1"]);
    assert!(backlinks(&data, &index, &target).is_empty());
    let resolved = note_meta::resolve_wiki_target_kind(&data, DAY).expect("resolve");
    assert_eq!(resolved.map(|found| found.kind).as_deref(), Some("note"));
}

#[test]
fn a_missing_or_deleted_target_and_a_self_link_have_no_backlinks() {
    let (data, index) = databases();
    let target = day(&data, DAY, "", &[DAY], NOW);
    note(&data, "n1", "Plans", &[DAY], NOW + 1);
    reindex(&data, &index);

    assert_eq!(sources(&backlinks(&data, &index, &target)), ["n1"]);
    assert!(backlinks(&data, &index, "nothing").is_empty());

    let gone = InboundRecord {
        item_type: "journal".to_owned(),
        item_id: target.clone(),
        payload_json: "{}".to_owned(),
        server_cursor: Some(2),
        signer_device_id: Some("device-b".to_owned()),
        updated_at: NOW + 5,
        deleted_at: Some(NOW + 5),
    };
    sync_items::apply_remote(&data, &gone, NOW + 5).expect("tombstone the day");
    assert!(backlinks(&data, &index, &target).is_empty());
    assert!(
        links::outgoing_links(&data, &index, &target)
            .expect("out")
            .is_empty()
    );
}

#[test]
fn outgoing_links_name_note_journal_and_missing_targets() {
    let (data, index) = databases();
    note(&data, "cardamom", "Cardamom", &[], NOW);
    let linked = day(&data, "2099-06-14", "", &[], NOW);
    let source = day(
        &data,
        DAY,
        "",
        &["Cardamom", "2099-06-14", "Nowhere", "j2099-07-01"],
        NOW + 1,
    );
    reindex(&data, &index);

    let found = links::outgoing_links(&data, &index, &source).expect("outgoing");
    assert_eq!(
        found,
        vec![
            OutgoingLink {
                target_title: "2099-06-14".to_owned(),
                target_id: Some(linked),
                target_kind: "journal".to_owned(),
                target_date: Some("2099-06-14".to_owned()),
            },
            OutgoingLink {
                target_title: "Cardamom".to_owned(),
                target_id: Some("cardamom".to_owned()),
                target_kind: "note".to_owned(),
                target_date: None,
            },
            OutgoingLink {
                target_title: "j2099-07-01".to_owned(),
                target_id: Some("j2099-07-01".to_owned()),
                target_kind: "journal".to_owned(),
                target_date: Some("2099-07-01".to_owned()),
            },
            OutgoingLink {
                target_title: "Nowhere".to_owned(),
                target_id: None,
                target_kind: "missing".to_owned(),
                target_date: None,
            },
        ]
    );
    // Reading links wrote nothing: the j<date> day was not created (D2).
    assert_eq!(journal::entry_for(&data, "2099-07-01").expect("read"), None);
}

#[test]
fn wiki_resolution_prefers_a_note_then_the_day_then_the_j_date_form() {
    let (data, _index) = databases();
    note(&data, "n1", "Cardamom", &[], NOW);
    let target = day(&data, DAY, "", &[], NOW);
    let resolve = |text: &str| note_meta::resolve_wiki_target_kind(&data, text).expect("resolve");

    assert_eq!(
        resolve("cardamom"),
        Some(WikiTargetMatch {
            id: "n1".to_owned(),
            kind: "note".to_owned(),
            date: None,
        })
    );
    let journal_match = Some(WikiTargetMatch {
        id: target.clone(),
        kind: "journal".to_owned(),
        date: Some(DAY.to_owned()),
    });
    assert_eq!(resolve(DAY), journal_match);
    assert_eq!(resolve(" j2099-06-15 "), journal_match);
    // A bare date with no entry is a broken link; the id form opens the day.
    assert_eq!(resolve("2099-06-20"), None);
    assert_eq!(
        resolve("j2099-06-20").map(|found| (found.id, found.kind)),
        Some(("j2099-06-20".to_owned(), "journal".to_owned()))
    );
    assert_eq!(resolve("2099-02-30"), None);
    assert_eq!(resolve("Nowhere"), None);
    // The note-only resolver keeps its answer.
    assert_eq!(
        note_meta::resolve_wiki_target(&data, DAY).expect("resolve"),
        None
    );
}

#[test]
fn a_journal_body_hit_carries_its_date() {
    let (data, index) = databases();
    let id = day(&data, DAY, "saffron risotto for dinner", &[], NOW);
    reindex(&data, &index);

    let hits = search::search_notes(&data, &index, "saffron", 10).expect("search");
    assert_eq!(hits.len(), 1, "{hits:?}");
    assert_eq!(hits[0].id, id);
    assert_eq!(
        hits[0].kind,
        HitKind::Journal {
            date: DAY.to_owned()
        }
    );
}
