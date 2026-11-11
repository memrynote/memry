//! References into other notes' blocks (#3531 14j-1) over a real session: files in a temp
//! vault, read by the vault tier, indexed by the note index's search reindex into `index.db`.
//!
//! A portal fence and a block link in the vault's files give `Search::block_ref_edges` rows; a
//! rebuilt `index.db` gives them back; removing the portal's block removes its edge. The
//! editor's open state is part of the same acceptance box: open while held, closed after the
//! last release.

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::index_support;
#[allow(unused_imports)]
use crate::vault_env;

use std::sync::{Arc, Mutex};

use index_support::until;
use memry_core::domain::search::block_refs::{BlockRefEdge, BlockRefKind};
use memry_core::seams::secure_store::SecureStore;
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::index::NoteIndex;
use memry_desktop::vault::consumer::Applied;
use vault_env::{Env, env, indexed};

fn id_at(e: &Env, path: &str) -> String {
    e.rows()
        .into_iter()
        .find(|(_, p)| p == path)
        .unwrap_or_else(|| panic!("no row at {path}"))
        .0
}

/// The vault's edges, portals first: note ids are random, so the core's order is not fixed.
fn edges(e: &Env) -> Vec<BlockRefEdge> {
    let search = e.session.current().expect("open").search;
    let mut edges = search.block_ref_edges().expect("edges");
    edges.sort_by_key(|edge| edge.kind);
    edges
}

fn edge(from: &str, to: &str, kind: BlockRefKind) -> BlockRefEdge {
    BlockRefEdge {
        from_note: from.to_owned(),
        to_note: to.to_owned(),
        to_block: Some("abc1".to_owned()),
        kind,
    }
}

#[test]
fn portal_and_block_link_edges_follow_the_files_and_a_rebuilt_index() {
    let store: Mutex<Option<Arc<dyn SecureStore>>> = Mutex::default();
    let mut e = env(|s| {
        *store.lock().unwrap() = Some(s.clone());
        Some(NotesIdentity::new(s))
    });
    let store = store.into_inner().unwrap().unwrap();
    e.write("Source.md", "First\n\nThe block ^abc1\n");
    e.write(
        "Linker.md",
        "See [[Source#^abc1]] and [[Source#Heading]].\n",
    );
    let index = NoteIndex::new(e.tier.clone(), |_| {}, |_| {}, |_| {});
    index.register(&e.session);
    e.open();
    e.facts_until(indexed);
    let (source, linker) = (id_at(&e, "Source.md"), id_at(&e, "Linker.md"));

    // Written after the open, so the portal can name the source by the id it was given.
    e.write(
        "Host.md",
        &format!(
            "Intro\n\n```memry-portal\n{{\"v\":1,\"note\":\"{source}\",\"blocks\":[\"abc1\"]}}\n```\n"
        ),
    );
    // The row first: a new file's note is created and seeded before its row is recorded, and
    // a search reindex running meanwhile already indexes the seeded body, so the edge can show
    // before the row. `Added` is published once the row is.
    e.facts_until(|fact| matches!(fact, Applied::Added { path, .. } if path == "Host.md"));
    until("the portal's edge", || edges(&e).len() == 2);
    let host = id_at(&e, "Host.md");
    let both = vec![
        edge(&host, &source, BlockRefKind::Portal),
        edge(&linker, &source, BlockRefKind::Link),
    ];
    assert_eq!(edges(&e), both);
    let search = e.session.current().unwrap().search;
    assert_eq!(search.block_refs(&source).unwrap().len(), 2);
    assert!(search.block_refs(&host).unwrap().is_empty());
    drop(search);

    // The index is derived: a vault whose `index.db` is gone gets every edge back.
    e.close();
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(e.vault.join(format!(".memry/core/index.db{suffix}")));
    }
    e.open();
    e.facts_until(indexed);
    until("the rebuilt edges", || edges(&e).len() == 2);
    assert_eq!(edges(&e), both);

    e.write("Host.md", "Intro\n");
    until("the portal's block removed", || edges(&e).len() == 1);
    assert_eq!(edges(&e), [edge(&linker, &source, BlockRefKind::Link)]);

    let editor = e.core().editor(store).unwrap();
    assert!(!editor.is_open(&source));
    editor.open(&source, "main").unwrap();
    assert!(editor.is_open(&source));
    editor.release(&source, "main");
    assert!(!editor.is_open(&source), "the last release closes it");
    drop(editor);
    e.close();
}
