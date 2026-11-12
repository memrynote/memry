//! The portal reads and write of desktop's `portals:*` (#4415), over real `data.db` and
//! `index.db` files: usage per host, the reindex naming the sources whose usage moved, block
//! search, and an anchor stamped into a note's stored body.

#![cfg(feature = "markdown")]

use memry_core::domain::body_write;
use memry_core::domain::search::portal_reads::{self, HostKind, PortalHost};
use memry_core::portal::StampOutcome;
use memry_core::storage::migrations::INDEX_MIGRATIONS;
use rusqlite::params;

use crate::block_refs::Vault;

fn file(vault: &Vault, id: &str, path: &str) {
    vault
        .data
        .execute(
            "INSERT INTO note_files (note_id, path, indexed_at) VALUES (?1, ?2, 0)",
            params![id, path],
        )
        .expect("file row");
}

fn note(vault: &mut Vault, id: &str, title: &str, markdown: &str) {
    vault.note(id, title, markdown);
    file(vault, id, &format!("{title}.md"));
}

fn fence(json: &str) -> String {
    format!("```memry-portal\n{json}\n```\n\n")
}

fn host(id: &str, title: &str, count: u32, kind: HostKind) -> PortalHost {
    PortalHost {
        note_id: id.to_owned(),
        title: title.to_owned(),
        path: format!("{title}.md"),
        count,
        kind,
    }
}

fn usage(vault: &Vault, anchor: Option<&str>) -> Vec<PortalHost> {
    portal_reads::usage(&vault.data, &vault.index, "n-src", anchor).expect("usage")
}

fn sources(dir: &std::path::Path) -> Vault {
    let mut vault = Vault::new(dir, INDEX_MIGRATIONS);
    let to_block = fence(r#"{"v":1,"note":"n-src","blocks":["abc1"]}"#);
    let mut own = "Para ^abc1\n\n- Parent item\n    - child words\n\n".to_owned();
    own.push_str(&to_block);
    note(&mut vault, "n-src", "Source", &own);
    let mut a = fence(r#"{"note":"n-other"}"#);
    a.push_str(&to_block);
    a.push_str(&to_block);
    note(&mut vault, "n-a", "Beta host", &a);
    note(
        &mut vault,
        "n-b",
        "Alpha host",
        &fence(r#"{"note":"n-src"}"#),
    );
    note(&mut vault, "n-link", "Linker", "See [[Source#^abc1]].\n");
    vault.reindex();
    vault
}

#[test]
fn usage_lists_portal_hosts_by_title_then_linking_notes_and_leaves_the_source_out() {
    let dir = tempfile::tempdir().expect("scratch");
    let vault = sources(dir.path());
    let block = HostKind::Portal { ordinal: 1 };
    assert_eq!(
        usage(&vault, Some("abc1")),
        [
            host("n-a", "Beta host", 2, block),
            host("n-link", "Linker", 1, HostKind::Link),
        ],
        "two fences to the block in one host count 2; the source's own fence is not a reader"
    );
    assert_eq!(
        usage(&vault, None),
        [
            host("n-b", "Alpha host", 1, HostKind::Portal { ordinal: 0 }),
            host("n-a", "Beta host", 2, block),
            host("n-link", "Linker", 1, HostKind::Link),
        ]
    );
    assert_eq!(usage(&vault, Some("zzz9")), []);
}

#[test]
fn a_reindex_names_the_sources_whose_usage_moved() {
    let dir = tempfile::tempdir().expect("scratch");
    let mut vault = sources(dir.path());
    vault.body("n-b", "No portal now\n");
    vault.body("n-link", "See [[Source#^abc1]] still.\n");
    let done = vault.reindex();
    assert_eq!(
        done.links.usage.into_iter().collect::<Vec<_>>(),
        ["n-src"],
        "a dropped portal moves its source; a link that still points at the block moves nothing"
    );
    assert_eq!(usage(&vault, None).len(), 2);
}

#[test]
fn block_search_matches_every_word_and_names_the_parent() {
    let dir = tempfile::tempdir().expect("scratch");
    let vault = sources(dir.path());
    let found =
        portal_reads::search_blocks(&vault.data, &vault.index, Some("CHILD words"), None, 10)
            .expect("search");
    assert!(!found.truncated);
    assert_eq!(found.results.len(), 1, "{found:?}");
    let hit = &found.results[0];
    assert_eq!(
        (hit.note_id.as_str(), hit.text.as_str()),
        ("n-src", "child words")
    );
    assert_eq!(hit.parent_text.as_deref(), Some("Parent item"));
    assert_eq!(hit.anchor, None);

    let para = portal_reads::search_blocks(&vault.data, &vault.index, Some("para"), None, 10)
        .expect("search");
    let anchored: Vec<_> = para
        .results
        .iter()
        .map(|hit| (hit.text.as_str(), hit.anchor.as_deref()))
        .collect();
    assert_eq!(
        anchored,
        [("Para", Some("abc1"))],
        "the anchor is reported and stripped"
    );
}

#[test]
fn a_stamped_anchor_is_stored_and_found_again() {
    let dir = tempfile::tempdir().expect("scratch");
    let vault = sources(dir.path());
    let found = portal_reads::search_blocks(&vault.data, &vault.index, Some("parent"), None, 10)
        .expect("search");
    let block_id = found.results[0].block_id.clone();
    let stamp = |block: &str| {
        body_write::stamp_anchor(&vault.data, "n-src", block, "device-a", 1).expect("stamp")
    };
    let Some(StampOutcome::Stamped(anchor)) = stamp(&block_id) else {
        panic!("not stamped");
    };
    assert_eq!(
        stamp(&block_id),
        Some(StampOutcome::Existing(anchor.clone()))
    );
    assert_eq!(stamp("no-such-block"), Some(StampOutcome::MissingBlock));
    assert_eq!(
        body_write::stamp_anchor(&vault.data, "n-none", &block_id, "device-a", 1).expect("stamp"),
        None
    );
    let outbox: i64 = vault
        .data
        .query_row("SELECT count(*) FROM outbox", [], |row| row.get(0))
        .expect("outbox");
    assert!(outbox >= 1, "the stamp is queued for the other devices");

    let again = portal_reads::search_blocks(&vault.data, &vault.index, Some("parent"), None, 10)
        .expect("search");
    assert_eq!(again.results[0].anchor.as_deref(), Some(anchor.as_str()));
    assert_eq!(again.results[0].text, "Parent item");
}
