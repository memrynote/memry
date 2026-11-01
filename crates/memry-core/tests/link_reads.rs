//! The link reads of desktop's note surface (#3530 13i): who links to a note, and what a
//! title or a wiki-link target names, with the path of its file. Real SQLite, both databases
//! migrated; rows written as the projections and the index hold them.
//!
//! | Test                                                    | Rule                                   |
//! | ------------------------------------------------------- | -------------------------------------- |
//! | each live source once, never the target                 | one card per source, no self link      |
//! | a deleted source with stale index rows reaches no reader | the index may lag, the answer may not |
//! | titles, aliases, paths and days resolve with their rows  | `resolveLinkTargets`                  |
//! | a target's heading and block reference                  | `resolveWikiTarget`                    |
//! | the Search surface reads the same                       | the API wrappers                       |

#![cfg(feature = "markdown")]

use std::sync::Arc;

use memry_core::api::search::BacklinkOrder;
use memry_core::api::vault::Vault;
use memry_core::crdt::registry::UpdateSink;
use memry_core::crdt::{DocumentRegistry, update_log};
use memry_core::domain::journal_ops::links;
use memry_core::domain::link_reads::{self, LinkTarget};
use memry_core::domain::notes::{self, NewNote};
use memry_core::domain::unlinked_mentions::unlinked_mentions;
use memry_core::domain::wiki_target::{MatchedBy, settle_name_keys};
use memry_core::storage::migrations::{self, DATA_MIGRATIONS, INDEX_MIGRATIONS};
use memry_core::storage::{Db, open_data};
use rusqlite::{Connection, params};
use yrs::{ReadTxn as _, Xml as _, XmlElementPrelim, XmlFragment as _, XmlTextPrelim};

const NOW: i64 = 1_760_000_000_000;

fn dbs() -> (Connection, Connection) {
    let mut data = Connection::open_in_memory().expect("data.db");
    migrations::run(&mut data, DATA_MIGRATIONS).expect("data migrations");
    let mut index = Connection::open_in_memory().expect("index.db");
    migrations::run(&mut index, INDEX_MIGRATIONS).expect("index migrations");
    (data, index)
}

fn note(data: &Connection, id: &str, title: &str, folder: Option<&str>, file_type: &str) {
    data.execute(
        "INSERT INTO notes (id, title, folder_path, file_type, created_at, modified_at) \
         VALUES (?1, ?2, ?3, ?4, 1, 1)",
        params![id, title, folder, file_type],
    )
    .expect("note");
}

fn file(data: &Connection, id: &str, path: &str) {
    data.execute(
        "INSERT INTO note_files (note_id, path, file_type, indexed_at) VALUES (?1, ?2, 'markdown', 0)",
        params![id, path],
    )
    .expect("file row");
}

fn aliases(data: &Connection, id: &str, aliases: &str) {
    data.execute(
        "UPDATE notes SET aliases = ?2 WHERE id = ?1",
        params![id, aliases],
    )
    .expect("aliases");
}

fn day(data: &Connection, date: &str, aliases: Option<&str>) {
    let id = format!("j{date}");
    data.execute(
        "INSERT INTO journal_entries (id, date, created_at, modified_at) VALUES (?1, ?2, 1, 1)",
        params![id, date],
    )
    .expect("day");
    if let Some(aliases) = aliases {
        data.execute(
            "INSERT INTO journal_aliases (journal_id, aliases) VALUES (?1, ?2)",
            params![id, aliases],
        )
        .expect("day aliases");
    }
}

fn link(index: &Connection, source: &str, target: &str, title: &str) {
    index
        .execute(
            "INSERT INTO note_links (source_id, target_id, target_title) VALUES (?1, ?2, ?3)",
            params![source, target, title],
        )
        .expect("link");
}

fn text(index: &Connection, id: &str, content: &str) {
    index
        .execute(
            "INSERT INTO fts_notes (id, title, content, tags) VALUES (?1, '', ?2, '')",
            params![id, content],
        )
        .expect("fts row");
}

fn tombstone(data: &Connection, id: &str) {
    data.execute("UPDATE notes SET deleted_at = 2 WHERE id = ?1", params![id])
        .expect("tombstone");
}

fn incoming_ids(data: &Connection, index: &Connection, target: &str) -> Vec<String> {
    link_reads::incoming(data, index, target)
        .expect("incoming")
        .sources
        .into_iter()
        .map(|source| source.source_id)
        .collect()
}

#[test]
fn incoming_lists_each_live_source_once_and_never_the_target() {
    let (data, index) = dbs();
    note(&data, "n1", "Plan", None, "markdown");
    note(&data, "n2", "beta", Some("Work"), "markdown");
    file(&data, "n2", "Work/beta.md");
    note(&data, "n3", "Alpha", None, "markdown");
    day(&data, "2026-01-02", None);
    file(&data, "j2026-01-02", "Journal/2026-01-02.md");
    // Two spellings from one source are two rows, and one card.
    link(&index, "n2", "n1", "Plan");
    link(&index, "n2", "n1", "plan");
    link(&index, "n1", "n1", "Plan");
    link(&index, "n3", "n1", "Plan");
    link(&index, "j2026-01-02", "n1", "Plan");

    let found = link_reads::incoming(&data, &index, "n1").expect("incoming");
    assert_eq!(found.target_title.as_deref(), Some("Plan"));
    let shown: Vec<(&str, &str, &str, Option<&str>)> = found
        .sources
        .iter()
        .map(|s| {
            (
                s.source_id.as_str(),
                s.source_title.as_str(),
                s.source_kind.as_str(),
                s.source_path.as_deref(),
            )
        })
        .collect();
    assert_eq!(
        shown,
        [
            (
                "j2026-01-02",
                "2026-01-02",
                "journal",
                Some("Journal/2026-01-02.md")
            ),
            ("n3", "Alpha", "note", None),
            ("n2", "beta", "note", Some("Work/beta.md")),
        ]
    );
    let missing = link_reads::incoming(&data, &index, "nope").expect("incoming");
    assert_eq!(missing.target_title, None);
}

#[test]
fn a_deleted_source_with_stale_index_rows_reaches_no_reader() {
    let (data, index) = dbs();
    note(&data, "n1", "Plan", None, "markdown");
    note(&data, "n2", "Live", None, "markdown");
    note(&data, "n3", "Gone", None, "markdown");
    link(&index, "n2", "n1", "Plan");
    link(&index, "n3", "n1", "Plan");
    text(&index, "n4", "the plan again");
    text(&index, "n5", "the plan once more");
    note(&data, "n4", "Mentions", None, "markdown");
    note(&data, "n5", "Mentioned once", None, "markdown");
    let backlinks = |data: &Connection| -> Vec<String> {
        links::backlinks(data, &index, "n1", BacklinkOrder::Title)
            .expect("backlinks")
            .into_iter()
            .map(|row| row.source_id)
            .collect()
    };
    let mentions = |data: &Connection| -> Vec<String> {
        unlinked_mentions(data, &index, "n1")
            .expect("mentions")
            .into_iter()
            .map(|row| row.source_id)
            .collect()
    };
    // Every reader sees the sources while they are live.
    assert_eq!(incoming_ids(&data, &index, "n1"), ["n3", "n2"]);
    assert_eq!(backlinks(&data), ["n3", "n2"]);
    assert_eq!(mentions(&data), ["n5", "n4"]);

    // The index still holds their rows; the records are gone.
    tombstone(&data, "n3");
    tombstone(&data, "n5");
    assert_eq!(incoming_ids(&data, &index, "n1"), ["n2"]);
    assert_eq!(backlinks(&data), ["n2"]);
    assert_eq!(mentions(&data), ["n4"]);
}

/// A vault with each kind of name: a markdown note in a folder with a file row, a note with
/// an alias and no file row, an attachment, a day with an alias and a file row (13m), and a
/// title holding `#`.
fn names_vault() -> Connection {
    let (data, _) = dbs();
    note(&data, "n1", "Plan", Some("Work"), "markdown");
    file(&data, "n1", "Work/Plan.md");
    note(&data, "n2", "Roadmap", None, "markdown");
    aliases(&data, "n2", r#"["Q3 Goals"]"#);
    note(&data, "n3", "diagram", None, "image");
    note(&data, "n4", "Sprint #4", None, "markdown");
    day(&data, "2026-01-02", Some(r#"["Kickoff"]"#));
    file(&data, "j2026-01-02", "Journal/2026-01-02.md");
    data
}

fn shown(found: &Option<LinkTarget>) -> Option<(&str, &str, Option<&str>, &str, MatchedBy)> {
    found.as_ref().map(|t| {
        (
            t.id.as_str(),
            t.title.as_str(),
            t.path.as_deref(),
            t.file_type.as_str(),
            t.matched_by,
        )
    })
}

#[test]
fn titles_aliases_paths_and_days_resolve_with_their_rows() {
    let data = names_vault();
    let queries: Vec<String> = [
        "plan",
        "Work/Plan",
        "q3 goals",
        "2026-01-02",
        "kickoff",
        "/diagram.png",
        "missing",
    ]
    .map(str::to_owned)
    .into();
    let check = |data: &Connection| {
        let found = link_reads::resolve_titles(data, &queries).expect("resolve");
        let shown: Vec<_> = found.iter().map(shown).collect();
        assert_eq!(
            shown,
            [
                Some((
                    "n1",
                    "Plan",
                    Some("Work/Plan.md"),
                    "markdown",
                    MatchedBy::Title
                )),
                Some((
                    "n1",
                    "Plan",
                    Some("Work/Plan.md"),
                    "markdown",
                    MatchedBy::Path
                )),
                Some(("n2", "Roadmap", None, "markdown", MatchedBy::Alias)),
                Some((
                    "j2026-01-02",
                    "2026-01-02",
                    Some("Journal/2026-01-02.md"),
                    "markdown",
                    MatchedBy::Title
                )),
                Some((
                    "j2026-01-02",
                    "2026-01-02",
                    Some("Journal/2026-01-02.md"),
                    "markdown",
                    MatchedBy::Alias
                )),
                Some(("n3", "diagram", None, "image", MatchedBy::Path)),
                None,
            ]
        );
        assert_eq!(
            found[0].as_ref().map(|t| t.folder_path.as_deref()),
            Some(Some("Work"))
        );
        let day = found[3].as_ref().expect("the day");
        assert_eq!(
            (day.journal_date.as_deref(), day.folder_path.as_deref()),
            (Some("2026-01-02"), None)
        );
    };
    // Answered while every row is owed its keys, and again from the stored keys.
    check(&data);
    assert!(settle_name_keys(&data).expect("settle") > 0);
    check(&data);
    assert!(
        link_reads::resolve_titles(&data, &[])
            .expect("resolve")
            .is_empty()
    );
}

#[test]
fn a_target_names_its_heading_but_not_a_block_reference() {
    let data = names_vault();
    settle_name_keys(&data).expect("settle");
    let target = |raw: &str| {
        link_reads::resolve_target(&data, raw)
            .expect("resolve")
            .map(|(target, heading)| (target.id, heading))
    };
    assert_eq!(
        target("Plan#Goals"),
        Some(("n1".to_owned(), Some("Goals".to_owned())))
    );
    assert_eq!(
        target("Work/Plan#A#B"),
        Some(("n1".to_owned(), Some("B".to_owned())))
    );
    assert_eq!(target("Plan#^abc"), Some(("n1".to_owned(), None)));
    assert_eq!(target("Sprint #4"), Some(("n4".to_owned(), None)));
    assert_eq!(target("#Goals"), None);
    assert_eq!(target("Nope#Goals"), None);
}

#[test]
fn a_rename_is_seen_before_the_keys_are_settled() {
    let data = names_vault();
    settle_name_keys(&data).expect("settle");
    data.execute("UPDATE notes SET title = 'Strategy' WHERE id = 'n1'", [])
        .expect("rename");
    let one = |title: &str| {
        link_reads::resolve_titles(&data, &[title.to_owned()])
            .expect("resolve")
            .pop()
            .flatten()
            .map(|t| t.id)
    };
    assert_eq!(one("strategy").as_deref(), Some("n1"));
    assert_eq!(one("plan"), None);
    tombstone(&data, "n2");
    assert_eq!(one("q3 goals"), None);
    settle_name_keys(&data).expect("settle");
    assert_eq!(one("strategy").as_deref(), Some("n1"));
    assert_eq!(one("plan"), None);
}

fn vault(label: &str) -> (Db, Vault) {
    let dir = tempfile::Builder::new()
        .prefix(&format!("memry-link-reads-{label}-"))
        .tempdir()
        .expect("the scratch directory")
        .keep();
    let opened = Vault::open("vault-1".to_string(), dir.display().to_string()).expect("open");
    (
        open_data(&dir.join("data.db")).expect("second open"),
        opened,
    )
}

/// A real lib0 v1 update: one paragraph of `text`, then a wiki link to `target` when given.
fn body_update(doc_id: &str, text: &str, target: Option<&str>) -> Vec<u8> {
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
            if let Some(target) = target {
                let link = paragraph.push_back(txn, XmlElementPrelim::empty("wikiLink"));
                link.insert_attribute(txn, "target", target);
                link.push_back(txn, XmlTextPrelim::new(target));
            }
        })
        .expect("a write transaction");
    let update = captured.lock().expect("lock").first().cloned();
    update.expect("one update")
}

fn write_note(db: &Db, id: &str, title: &str, body: &str, target: Option<&str>) {
    db.call_blocking(|conn: &mut Connection| {
        let note = NewNote {
            id,
            title,
            folder_path: None,
            content: "",
            tags: &[],
            properties: None,
            emoji: None,
        };
        notes::create(conn, &note, "device-a", NOW)?;
        update_log::append_server_update(conn, id, 1, &body_update(id, body, target), NOW)
            .expect("the body update");
        Ok(())
    })
    .expect("the write");
}

#[test]
fn the_search_surface_reads_links_and_names() {
    let (db, vault) = vault("surface");
    write_note(&db, "target", "Cardamom", "the spice itself", None);
    write_note(&db, "linker", "Groceries", "buy ", Some("Cardamom"));
    write_note(&db, "mentioner", "Recipes", "add cardamom last", None);
    let search = vault.search().expect("search");
    search.reindex().expect("the reindex");
    // The reindex stored every name's lookup keys.
    let owed: i64 = db
        .read_blocking(|conn| {
            conn.query_row("SELECT COUNT(*) FROM wiki_names_owed", [], |row| row.get(0))
                .map_err(|error| memry_core::api::errors::StorageError::Failed {
                    what: error.to_string(),
                })
        })
        .expect("owed");
    assert_eq!(owed, 0);

    let incoming = search.incoming_links("target").expect("incoming");
    assert_eq!(incoming.target_title.as_deref(), Some("Cardamom"));
    let sources: Vec<&str> = incoming
        .sources
        .iter()
        .map(|s| s.source_id.as_str())
        .collect();
    assert_eq!(sources, ["linker"]);

    let found = search
        .resolve_link_titles(vec!["cardamom".to_owned(), "nutmeg".to_owned()])
        .expect("titles");
    let ids: Vec<Option<&str>> = found
        .iter()
        .map(|t| t.as_ref().map(|t| t.id.as_str()))
        .collect();
    assert_eq!(ids, [Some("target"), None]);
    let (target, heading) = search
        .resolve_link_target("Cardamom#Uses")
        .expect("target")
        .expect("found");
    assert_eq!(
        (target.id.as_str(), heading.as_deref()),
        ("target", Some("Uses"))
    );

    let backlinks = |search: &memry_core::api::search::Search| -> Vec<String> {
        search
            .backlinks("target".to_owned(), BacklinkOrder::Title)
            .expect("backlinks")
            .into_iter()
            .map(|row| row.source_id)
            .collect()
    };
    let mentions = |search: &memry_core::api::search::Search| -> Vec<String> {
        search
            .unlinked_mentions("target".to_owned())
            .expect("mentions")
            .into_iter()
            .map(|row| row.source_id)
            .collect()
    };
    assert_eq!(backlinks(&search), ["linker"]);
    assert_eq!(mentions(&search), ["mentioner"]);

    // Deleted after the reindex: the index still holds both rows.
    db.call_blocking(|conn: &mut Connection| {
        conn.execute(
            "UPDATE notes SET deleted_at = ?1 WHERE id IN ('linker', 'mentioner')",
            params![NOW + 1],
        )
        .map(|_| ())
        .map_err(|error| memry_core::api::errors::StorageError::Failed {
            what: error.to_string(),
        })
    })
    .expect("tombstones");
    assert!(backlinks(&search).is_empty());
    assert!(mentions(&search).is_empty());
    assert!(
        search
            .incoming_links("target")
            .expect("incoming")
            .sources
            .is_empty()
    );
}
