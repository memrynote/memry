//! The portal reads and write of desktop's `portals:*` (#4415), over real `data.db` and
//! `index.db` files: usage per host, the reindex naming the sources whose usage moved, block
//! search, and an anchor stamped into a note's stored body.

#![cfg(feature = "markdown")]

use memry_core::domain::body_write;
use memry_core::domain::search::portal_reads::{self, HostKind, PortalHost};
use memry_core::portal::StampOutcome;
use memry_core::storage::migrations::INDEX_MIGRATIONS;
use rusqlite::params;
use std::collections::BTreeSet;

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

#[test]
fn a_journal_days_block_is_stamped_and_queued_as_the_days() {
    let dir = tempfile::tempdir().expect("scratch");
    let mut vault = sources(dir.path());
    vault.day("j2026-01-02", "2026-01-02", "Morning pages\n");
    file(&vault, "j2026-01-02", "journal/2026-01-02.md");
    let block = vault.block_ids("j2026-01-02").remove(0);
    let Some(StampOutcome::Stamped(_)) =
        body_write::stamp_anchor(&vault.data, "j2026-01-02", &block, "device-a", 1).expect("stamp")
    else {
        panic!("a journal day's block is stamped");
    };
    let queued: Vec<String> = vault
        .data
        .prepare("SELECT item_type FROM outbox WHERE item_id = 'j2026-01-02'")
        .and_then(|mut statement| {
            statement
                .query_map([], |row| row.get(0))?
                .collect::<Result<_, _>>()
        })
        .expect("outbox");
    assert_eq!(queued, ["journal"], "a day's body travels as the day's");
}

/// `count` notes `{prefix}{i}` whose body is `markdown`, each carrying `tags`.
fn many(vault: &mut Vault, prefix: &str, count: usize, tags: &[String], markdown: &str) {
    for i in 0..count {
        let id = format!("{prefix}{i}");
        vault.tagged_note(&id, &id, tags, markdown);
        file(vault, &id, &format!("{id}.md"));
    }
}

fn notes_found(found: &portal_reads::PortalBlockSearch) -> BTreeSet<&str> {
    found
        .results
        .iter()
        .map(|hit| hit.note_id.as_str())
        .collect()
}

/// Electron's `searchAll` reads `limit` (40) notes for a text alone, so a text more notes match
/// is not truncated by the note count.
#[test]
fn a_text_search_reads_at_most_forty_notes_and_is_not_truncated_by_them() {
    let dir = tempfile::tempdir().expect("scratch");
    let mut vault = Vault::new(dir.path(), INDEX_MIGRATIONS);
    many(&mut vault, "n", 45, &[], "zeta\n");
    vault.reindex();
    let found = portal_reads::search_blocks(&vault.data, &vault.index, Some("zeta"), None, 200)
        .expect("search");
    assert_eq!(notes_found(&found).len(), portal_reads::CANDIDATE_CAP);
    assert!(!found.truncated, "Electron fetches only the cap");
}

/// With a tag, Electron's `searchAll` fetches five times the limit, keeps the tagged notes and
/// then the limit: tagged notes ranked below 80 untagged ones are still read.
#[test]
fn a_text_and_tag_search_reads_tagged_notes_ranked_past_twice_the_cap() {
    let dir = tempfile::tempdir().expect("scratch");
    let mut vault = Vault::new(dir.path(), INDEX_MIGRATIONS);
    many(&mut vault, "u", 100, &[], "zeta zeta zeta\n");
    let filler = "lorem ipsum dolor ".repeat(40);
    many(
        &mut vault,
        "t",
        45,
        &["bio".to_owned()],
        &format!("zeta {filler}\n"),
    );
    vault.reindex();
    let found =
        portal_reads::search_blocks(&vault.data, &vault.index, Some("zeta"), Some("bio"), 200)
            .expect("search");
    let notes = notes_found(&found);
    assert_eq!(notes.len(), portal_reads::CANDIDATE_CAP, "{notes:?}");
    assert!(notes.iter().all(|id| id.starts_with('t')));
    assert!(!found.truncated);
}
