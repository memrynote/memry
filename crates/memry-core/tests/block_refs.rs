//! References into other notes' blocks (#3531 14j-1): `portal_refs` and `block_link_refs`,
//! derived by the reindex from each note's document and read back as edges.
//!
//! | Test                                                      | Rule (Electron reference)               |
//! | --------------------------------------------------------- | --------------------------------------- |
//! | portal rows per fence kind, ordinals count unreadable ones | `derivePortalRefs`                      |
//! | block links from nodes, text and note addresses            | `extractBlockLinks`, `setBlockLinkRefs` |
//! | a reindex writes, replaces and drops the edges             | the projectors, per note event          |
//! | an index migrated from version 5 fills them                | rows for notes that never change again  |

#![cfg(feature = "markdown")]

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use memry_core::crdt::blocks::{Block, BlockProp, InlineRun};
use memry_core::crdt::markdown_seed::seed_document;
use memry_core::crdt::registry::{Document, UpdateSink};
use memry_core::crdt::{DocumentRegistry, update_log};
use memry_core::domain::notes::{self, NewNote};
use memry_core::domain::search::block_refs::{
    self, BlockLink, BlockRefEdge, BlockRefKind, PortalRef,
};
use memry_core::domain::search::reindex;
use memry_core::storage::migrations::{self, DATA_MIGRATIONS, INDEX_MIGRATIONS};
use rusqlite::Connection;
use yrs::{Any, ReadTxn as _, Text as _, XmlElementPrelim, XmlFragment as _, XmlTextPrelim};

const NOW: i64 = 1_760_000_000_000;

fn run(text: &str, marks: &[&str], target: Option<&str>) -> InlineRun {
    InlineRun {
        text: text.to_owned(),
        marks: marks.iter().map(|mark| (*mark).to_owned()).collect(),
        mark_attrs: HashMap::new(),
        target: target.map(str::to_owned),
    }
}

fn block(kind: &str, language: Option<&str>, inline: Vec<InlineRun>) -> Block {
    Block {
        id: None,
        kind: kind.to_owned(),
        depth: 0,
        props: language
            .map(|value| BlockProp {
                name: "language".to_owned(),
                value: value.to_owned(),
            })
            .into_iter()
            .collect(),
        inline,
    }
}

fn portal(json: &str) -> Block {
    block(
        "codeBlock",
        Some("memry-portal"),
        vec![run(json, &[], None)],
    )
}

fn paragraph(inline: Vec<InlineRun>) -> Block {
    block("paragraph", None, inline)
}

fn fence(ordinal: u32, kind: &'static str, source: Option<&str>, anchors: &[&str]) -> PortalRef {
    PortalRef {
        ordinal,
        kind,
        source: source.map(str::to_owned),
        anchors: anchors.iter().map(|anchor| (*anchor).to_owned()).collect(),
    }
}

#[test]
fn portal_rows_follow_each_fence_kind_and_ordinals_count_unreadable_fences() {
    let blocks = [
        portal(
            r#"{"v":1,"note":"src","blocks":["root1","root2"],"open":{"root2":{"show":["kid9","root1"]},"root1":{"hide":["gone1"]}}}"#,
        ),
        portal("not json"),
        block(
            "codeBlock",
            Some("markdown"),
            vec![run(r#"{"note":"src"}"#, &[], None)],
        ),
        portal(r#"{"note":"whole"}"#),
        portal(r#"{"search":{"tag":"bio"}}"#),
        portal(&format!(r#"{{"note":"{}"}}"#, "x".repeat(129))),
        portal(r#"{"note":"not an id","blocks":["abcd"]}"#),
    ];
    let refs = block_refs::derive(&blocks);
    assert_eq!(
        refs.portals,
        [
            fence(0, "blocks", Some("src"), &["root1", "root2", "kid9"]),
            fence(2, "note", Some("whole"), &[]),
            fence(3, "search", None, &[]),
        ]
    );
    assert!(refs.links.is_empty());
}

#[test]
fn block_links_come_from_nodes_text_and_note_addresses_once_per_target_key() {
    let link = |target: &str, anchor: &str| BlockLink {
        target: target.to_owned(),
        anchor: anchor.to_owned(),
    };
    let blocks = [
        paragraph(vec![
            run("Plan", &["wikiLink"], Some("Plan#^step1")),
            run(
                " and [[Labs/Lab 4#^ x9 ]] and [[plan#^step1]] [[Plan#Heading]] [[#^self1]] [[Plan#^]]",
                &[],
                None,
            ),
        ]),
        paragraph(vec![
            run("id", &["link"], Some("MEMRY://note/n-42?label=Hi#^abc1")),
            run("path", &["link"], Some("Folder/My%20Note.md#^def2")),
            run("bad escape", &["link"], Some("Odd%zz.md#^ghi3")),
            run("web", &["link"], Some("https://example.com/a#^web1")),
            run("mail", &["link"], Some("mailto:a@b.c#^mail")),
            run("[[Code#^no]]", &["code"], None),
        ]),
        block(
            "codeBlock",
            Some("text"),
            vec![run("[[Fenced#^no]]", &[], None)],
        ),
    ];
    assert_eq!(
        block_refs::derive(&blocks).links,
        [
            link("Plan", "step1"),
            link("Labs/Lab 4", "x9"),
            link("memry://note/n-42", "abc1"),
            link("Folder/My Note.md", "def2"),
            link("Odd%zz.md", "ghi3"),
        ]
    );
}

#[test]
fn a_link_mention_is_a_url_mention_and_never_a_block_link() {
    let blocks = [paragraph(vec![run(
        "x.com",
        &["linkMention"],
        Some("https://x.com/p#^abcd"),
    )])];
    assert!(block_refs::derive(&blocks).links.is_empty());
}

/// A note's document and the updates its writes captured, not yet stored.
type Captured = (Arc<Document>, Arc<Mutex<Vec<Vec<u8>>>>);

pub(crate) struct Vault {
    pub(crate) data: Connection,
    pub(crate) index: Connection,
    docs: HashMap<String, Captured>,
    seq: i64,
}

fn files(dir: &Path, index_migrations: &[migrations::Migration]) -> (Connection, Connection) {
    let mut data = Connection::open(dir.join("data.db")).expect("data.db");
    migrations::run(&mut data, DATA_MIGRATIONS).expect("data migrations");
    let mut index = Connection::open(dir.join("index.db")).expect("index.db");
    migrations::run_atomic(&mut index, index_migrations).expect("index migrations");
    (data, index)
}

impl Vault {
    pub(crate) fn new(dir: &Path, index_migrations: &[migrations::Migration]) -> Self {
        let (data, index) = files(dir, index_migrations);
        Self {
            data,
            index,
            docs: HashMap::new(),
            seq: 0,
        }
    }

    /// A note titled `title` whose body is `markdown`, its update stored as the server's.
    pub(crate) fn note(&mut self, id: &str, title: &str, markdown: &str) {
        self.tagged_note(id, title, &[], markdown);
    }

    /// [`Vault::note`] whose record holds `tags`.
    pub(crate) fn tagged_note(&mut self, id: &str, title: &str, tags: &[String], markdown: &str) {
        let new = NewNote {
            id,
            title,
            folder_path: None,
            content: "",
            tags,
            properties: None,
            emoji: None,
        };
        notes::create(&self.data, &new, "device-a", NOW).expect("create the note");
        self.document(id, markdown);
    }

    /// The journal day `id` of `date` whose body is `markdown`, its update stored as the server's.
    pub(crate) fn day(&mut self, id: &str, date: &str, markdown: &str) {
        self.data
            .execute(
                "INSERT INTO journal_entries (id, date, created_at, modified_at) VALUES (?1, ?2, ?3, ?3)",
                rusqlite::params![id, date, NOW],
            )
            .expect("the day's record");
        self.document(id, markdown);
    }

    fn document(&mut self, id: &str, markdown: &str) {
        let captured: Arc<Mutex<Vec<Vec<u8>>>> = Arc::default();
        let sink: UpdateSink = {
            let captured = Arc::clone(&captured);
            Arc::new(move |_, bytes: &[u8]| captured.lock().unwrap().push(bytes.to_vec()))
        };
        let document = DocumentRegistry::new("device-peer", sink)
            .get_or_open(id)
            .expect("open");
        self.docs.insert(id.to_owned(), (document, captured));
        self.body(id, markdown);
    }

    /// A note whose body is one paragraph holding only `label`, a link mark to `href`: the
    /// shape the editor writes, which markdown never seeds for a `memry://` address.
    fn link_note(&mut self, id: &str, title: &str, label: &str, href: &str) {
        self.note(id, title, "");
        self.replace_body(id, |document| {
            document
                .write(|txn| {
                    let fragment = txn.get_xml_fragment("prosemirror").expect("body");
                    let container =
                        fragment.push_back(txn, XmlElementPrelim::empty("blockContainer"));
                    let paragraph = container.push_back(txn, XmlElementPrelim::empty("paragraph"));
                    let text = paragraph.push_back(txn, XmlTextPrelim::new(label));
                    let attrs = Any::from(HashMap::from([("href".to_owned(), Any::from(href))]));
                    text.format(txn, 0, label.len() as u32, [("link".into(), attrs)].into());
                })
                .expect("write the link");
        });
    }

    /// Replaces `id`'s body with `markdown`, as a pulled update.
    pub(crate) fn body(&mut self, id: &str, markdown: &str) {
        self.replace_body(id, |document| {
            seed_document(document, markdown).expect("seed");
        });
    }

    fn replace_body(&mut self, id: &str, fill: impl FnOnce(&Document)) {
        let (document, captured) = self.docs[id].clone();
        document
            .write(|txn| {
                let fragment = txn.get_xml_fragment("prosemirror").expect("body");
                let length = fragment.len(txn);
                fragment.remove_range(txn, 0, length);
            })
            .expect("clear the body");
        fill(&document);
        for update in captured.lock().unwrap().drain(..) {
            self.seq += 1;
            update_log::append_server_update(&self.data, id, self.seq, &update, NOW + self.seq)
                .expect("store the update");
        }
    }

    /// The ids of `id`'s top-level blocks.
    pub(crate) fn block_ids(&self, id: &str) -> Vec<String> {
        memry_core::crdt::body_edit::top_level_block_ids(&self.docs[id].0).expect("block ids")
    }

    pub(crate) fn reindex(&self) -> memry_core::domain::search::Reindexed {
        reindex(&self.data, &self.index, NOW + 1_000).expect("reindex")
    }

    fn edges(&self) -> Vec<BlockRefEdge> {
        block_refs::edges(&self.data, &self.index).expect("edges")
    }
}

fn edge(from: &str, to: &str, block: Option<&str>, kind: BlockRefKind) -> BlockRefEdge {
    BlockRefEdge {
        from_note: from.to_owned(),
        to_note: to.to_owned(),
        to_block: block.map(str::to_owned),
        kind,
    }
}

const HOST: &str = "Intro\n\n```memry-portal\n{\"v\":1,\"note\":\"n-src\",\"blocks\":[\"abc1\"]}\n```\n\n```memry-portal\n{\"note\":\"n-gone\"}\n```\n";

#[test]
fn a_reindex_writes_the_edges_replaces_them_with_the_body_and_drops_a_deleted_notes() {
    let dir = tempfile::tempdir().expect("scratch");
    let mut vault = Vault::new(dir.path(), INDEX_MIGRATIONS);
    vault.note("n-src", "Source", "Para ^abc1\n");
    vault.note("n-host", "Host", HOST);
    vault.note(
        "n-link",
        "Linker",
        "See [[source#^abc1]] and [x](memry://note/n-src#^abc1).\n",
    );
    vault.reindex();
    // A portal to a note this vault does not hold is a row, and no edge.
    assert_eq!(
        vault.edges(),
        [
            edge("n-host", "n-src", Some("abc1"), BlockRefKind::Portal),
            edge("n-link", "n-src", Some("abc1"), BlockRefKind::Link),
        ]
    );
    let portal_rows: i64 = vault
        .index
        .query_row("SELECT count(*) FROM portal_refs", [], |row| row.get(0))
        .unwrap();
    assert_eq!(portal_rows, 2);

    vault.body("n-host", "Intro\n");
    vault.reindex();
    assert_eq!(
        vault.edges(),
        [edge("n-link", "n-src", Some("abc1"), BlockRefKind::Link)]
    );

    notes::delete(&vault.data, "n-link", "device-a", NOW + 2_000).expect("delete");
    vault.reindex();
    assert_eq!(vault.edges(), []);
    let link_rows: i64 = vault
        .index
        .query_row("SELECT count(*) FROM block_link_refs", [], |row| row.get(0))
        .unwrap();
    assert_eq!(link_rows, 0, "a deleted note's rows go, not only its edges");
}

#[test]
fn a_note_address_alone_links_to_the_block_whatever_its_scheme_case_or_query() {
    let dir = tempfile::tempdir().expect("scratch");
    let mut vault = Vault::new(dir.path(), INDEX_MIGRATIONS);
    vault.note("n-src", "Source", "Para ^abc1\n");
    vault.link_note("n-id", "By id", "x", "memry://note/n-src#^abc1");
    vault.link_note(
        "n-upper",
        "By id, labelled",
        "x",
        "MEMRY://note/n-src?label=Hi#^abc1",
    );
    vault.reindex();
    assert_eq!(
        vault.edges(),
        [
            edge("n-id", "n-src", Some("abc1"), BlockRefKind::Link),
            edge("n-upper", "n-src", Some("abc1"), BlockRefKind::Link),
        ]
    );
}

#[test]
fn a_row_of_a_note_deleted_since_the_last_reindex_is_no_edge() {
    let dir = tempfile::tempdir().expect("scratch");
    let mut vault = Vault::new(dir.path(), INDEX_MIGRATIONS);
    vault.note("n-src", "Source", "Para ^abc1\n");
    vault.note("n-host", "Host", HOST);
    vault.reindex();
    assert_eq!(vault.edges().len(), 1);
    for sql in [
        "DELETE FROM sync_items WHERE item_id = 'n-host'",
        "DELETE FROM notes WHERE id = 'n-host'",
    ] {
        vault.data.execute(sql, []).expect("hard delete the host");
    }
    assert_eq!(vault.edges(), []);
}

#[test]
fn an_index_migrated_from_version_5_fills_the_rows_of_notes_that_never_change_again() {
    let dir = tempfile::tempdir().expect("scratch");
    let mut vault = Vault::new(dir.path(), &INDEX_MIGRATIONS[..5]);
    vault.note("n-src", "Source", "Para ^abc1\n");
    vault.note("n-host", "Host", HOST);
    // What the last build's reindex leaves: every note indexed, under a watermark past them.
    let data_version: i64 = vault
        .data
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    for (key, value) in [
        ("data.user_version", data_version),
        ("stamps.version", 1),
        ("watermark.fts_notes", NOW + 10_000),
        ("watermark.fts_tasks", NOW + 10_000),
    ] {
        vault
            .index
            .execute(
                "INSERT INTO index_meta (key, value) VALUES (?1, ?2)",
                rusqlite::params![key, value.to_string()],
            )
            .unwrap();
    }
    drop(vault.index);

    let (_, index) = files(dir.path(), INDEX_MIGRATIONS);
    vault.index = index;
    vault.reindex();
    assert_eq!(
        vault.edges(),
        [edge("n-host", "n-src", Some("abc1"), BlockRefKind::Portal)]
    );
}
