//! "Link" on an unlinked mention (#3530 13i-5) through `NotesService::link_mention`, the
//! service the `notes_link_mention` command calls, over a real session: records, rows, files,
//! the watcher and the note index in a temp vault. The rewrite is the one the `markdown` cases
//! of the `unlinked-mentions` vectors pin, the frontmatter keeps its bytes, the note's document
//! and row take the new text, and the watcher reports none of it back as an outside edit.

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::index_support;
#[allow(unused_imports)]
use crate::vault_env;

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use index_support::until;
use memry_core::seams::secure_store::SecureStore;
use memry_desktop::notes::error::NotesError;
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::index::NoteIndex;
use memry_desktop::notes::mentions::Mentions;
use memry_desktop::notes::service::NotesService;
use memry_desktop::vault::consumer::{Applied, ChangeSource};
use memry_desktop::vault::hash::content_hash;
use serde_json::Value;
use vault_env::{Env, env, indexed};

/// The block every source file starts with, which a link must leave byte for byte.
const BLOCK: &str = "---\nsummary:   kept  as  written\ntags: [daily]\n---\n";

/// A vault holding `files` when it opens, its walk done and indexed, with the notes service
/// over its tier.
fn opened(files: &[(&str, String)]) -> (Env, Arc<NotesService>, Arc<dyn SecureStore>) {
    let mut kept: Option<Arc<dyn SecureStore>> = None;
    let mut e = env(|store| {
        kept = Some(store.clone());
        Some(NotesIdentity::new(store))
    });
    for (path, text) in files {
        e.write(path, text);
    }
    let index = NoteIndex::new(e.tier.clone(), |_| {}, |_| {});
    index.register(&e.session);
    e.open();
    e.facts_until(indexed);
    let store = kept.expect("the store");
    let notes = NotesService::new(e.tier.clone(), store.clone());
    (e, notes, store)
}

fn id_at(e: &Env, path: &str) -> String {
    e.rows()
        .into_iter()
        .find(|(_, p)| p == path)
        .unwrap_or_else(|| panic!("no row at {path}"))
        .0
}

fn vectors() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/contracts/test-vectors/unlinked-mentions.json");
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|name| name.as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn a_mention_is_linked_as_the_unlinked_mentions_vectors_say() {
    let vectors = vectors();
    let cases = vectors["markdown"].as_array().unwrap();
    // Each target's names, its title first, as the cases give them.
    let mut targets: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut files = Vec::new();
    for (i, case) in cases.iter().enumerate() {
        let names = strings(&case["names"]);
        assert_eq!(names[0], case["title"].as_str().unwrap());
        targets.insert(names[0].clone(), names);
        let markdown = case["markdown"].as_str().unwrap();
        files.push((format!("sources/case {i}.md"), format!("{BLOCK}{markdown}")));
    }
    for title in targets.keys() {
        files.push((format!("targets/{title}.md"), "A target.\n".to_owned()));
    }
    let files: Vec<(&str, String)> = files.iter().map(|(p, t)| (p.as_str(), t.clone())).collect();
    let (e, notes, store) = opened(&files);
    let open = e.session.current().unwrap();
    let writer = e.core().notes_writer(store).unwrap();
    for (title, names) in &targets {
        let id = id_at(&e, &format!("targets/{title}.md"));
        writer.set_aliases(id, names[1..].to_vec()).unwrap();
    }

    for (i, case) in cases.iter().enumerate() {
        let name = case["name"].as_str().unwrap();
        let path = format!("sources/case {i}.md");
        let source = id_at(&e, &path);
        let target = id_at(
            &e,
            &format!("targets/{}.md", case["title"].as_str().unwrap()),
        );
        let ordinal = case["ordinal"].as_u64().unwrap() as usize;
        let before = e.read(&path);
        let linked = notes
            .link_mention(&open, &source, &target, ordinal)
            .unwrap();
        match case["linked"].as_str() {
            Some(body) => {
                assert!(linked, "{name}");
                assert_eq!(e.read(&path), format!("{BLOCK}{body}"), "{name}");
            }
            None => {
                assert!(!linked, "{name}: no such mention");
                assert_eq!(e.read(&path), before, "{name}: the file is left alone");
            }
        }
    }
    drop(open);
}

#[test]
fn a_linked_mention_reaches_the_file_the_note_and_the_row_and_comes_back_as_no_outside_edit() {
    let standup = format!("{BLOCK}We met about target today.\n\nTarget again.\n");
    let (mut e, notes, _) = opened(&[
        ("Target.md", "# Target\n".to_owned()),
        ("Standup.md", standup),
    ]);
    let open = e.session.current().unwrap();
    let (target, source) = (id_at(&e, "Target.md"), id_at(&e, "Standup.md"));
    let mentions = Mentions::new(&open);
    until("the source listed", || {
        mentions.get(&target).unwrap().len() == 1
    });
    e.drain();

    // The second mention, as the panel counts them.
    assert!(notes.link_mention(&open, &source, &target, 1).unwrap());

    let written = format!("{BLOCK}We met about target today.\n\n[[Target]] again.\n");
    assert_eq!(e.read("Standup.md"), written);
    let hash = content_hash(&written);
    let row = e.core().note_files().by_id(&source).unwrap().unwrap();
    assert_eq!(
        (row.content_hash.as_deref(), row.file_hash.as_deref()),
        (Some(hash.as_str()), Some(hash.as_str())),
        "the row names the new file, which the document holds"
    );
    assert!(
        e.versions(&source).is_empty(),
        "the body the user saw is not kept as a version"
    );
    assert_eq!(
        e.tier.echo().expected_hash("Standup.md"),
        Some(hash.clone()),
        "the write is recorded as the app's own"
    );
    std::thread::sleep(vault_env::QUIET);
    let facts = e.drain();
    let changed: Vec<&Applied> = facts
        .iter()
        .filter(|fact| matches!(fact, Applied::Changed { note_id, .. } if *note_id == source))
        .collect();
    assert_eq!(
        changed,
        [&Applied::Changed {
            note_id: source.clone(),
            path: "Standup.md".to_owned(),
            content_hash: Some(hash),
            source: ChangeSource::Rewrite,
        }],
        "the app's write, and no outside edit"
    );
    // The index relinks the source: it now links to the target, so it is a backlink.
    until("the source linked", || {
        mentions.get(&target).unwrap().is_empty()
    });
    drop(mentions);
    drop(open);
    e.close();
}

#[test]
fn a_gone_mention_a_changed_file_and_an_unknown_note_write_nothing() {
    let (mut e, notes, _) = opened(&[
        ("Target.md", "# Target\n".to_owned()),
        ("Standup.md", "Target once.\n".to_owned()),
    ]);
    let open = e.session.current().unwrap();
    let (target, source) = (id_at(&e, "Target.md"), id_at(&e, "Standup.md"));

    assert!(!notes.link_mention(&open, &source, &target, 1).unwrap());
    assert_eq!(e.read("Standup.md"), "Target once.\n");
    assert!(matches!(
        notes.link_mention(&open, &source, "no-such-note", 0),
        Err(NotesError::NotFound(id)) if id == "no-such-note"
    ));
    assert!(matches!(
        notes.link_mention(&open, "no-such-note", &target, 0),
        Err(NotesError::NotFound(id)) if id == "no-such-note"
    ));

    // An edit that lands while the link is written is kept, and nothing is linked.
    let linked = notes
        .link_mention_checked(&open, &source, &target, 0, &mut || {
            e.write("Standup.md", "Rewritten elsewhere: Target.\n");
        })
        .unwrap();
    assert!(!linked);
    assert_eq!(e.read("Standup.md"), "Rewritten elsewhere: Target.\n");
    assert_eq!(
        e.tier.echo().expected_hash("Standup.md"),
        None,
        "a write that did not happen is not the app's"
    );
    e.facts_until(|fact| {
        matches!(fact, Applied::Changed { note_id, source: ChangeSource::Watcher, .. }
            if *note_id == source)
    });
    drop(open);
    e.close();
}
