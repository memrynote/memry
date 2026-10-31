//! A note's links and wiki-link resolution (#3530 13i) through `notes::links`, the service the
//! `notes_get_links` and `notes_resolve_*` commands call, over a real session: records, rows
//! and files in a temp vault.
//!
//! - The `wiki-target-resolution` vectors resolve to the vector's note, at the vector's path,
//!   by title, by batch and as a wiki-link target with a heading.
//! - Backlinks carry the text around each link, read from the linking note's file with its
//!   comments stripped; a broken link has no target.

mod device_key;
mod index_support;
mod vault_env;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use index_support::until;
use memry_core::seams::secure_store::SecureStore;
use memry_core::storage::repositories::sync_items::{self, ApplyOutcome, InboundRecord};
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::index::NoteIndex;
use memry_desktop::notes::links::{NoteLinks, TitleMatchView};
use memry_desktop::vault::consumer::rows::RowStat;
use memry_desktop::vault::file_types::FileType;
use serde_json::{Value, json};
use vault_env::{env, indexed};

fn vectors() -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/contracts/test-vectors/wiki-target-resolution.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn apply(core: &memry_core::api::vault::Vault, item_type: &str, id: &str, payload: Value) {
    let record = InboundRecord {
        item_type: item_type.to_owned(),
        item_id: id.to_owned(),
        payload_json: payload.to_string(),
        server_cursor: Some(1),
        signer_device_id: Some("device-b".to_owned()),
        updated_at: 1_760_000_000_000,
        deleted_at: None,
    };
    let outcome = core
        .db_handle()
        .call_blocking(move |data| sync_items::apply_remote(data, &record, 1_760_000_000_000))
        .unwrap();
    assert!(!matches!(outcome, ApplyOutcome::Corrupt { .. }), "{id}");
}

#[test]
fn the_wiki_target_vectors_resolve_through_the_service_with_their_paths() {
    let file = vectors();
    let mut e = env(|_| None);
    e.open();
    let core = e.core();
    let rows = e.tier.rows();
    let session = rows.session_for(&core).unwrap();
    let mut paths = HashMap::new();
    for note in file["notes"].as_array().unwrap() {
        let id = note["noteId"].as_str().unwrap();
        let path = note["path"].as_str().unwrap();
        let title = note["title"].as_str().unwrap();
        paths.insert(id.to_owned(), path.to_owned());
        if note["journal"].as_bool().unwrap() {
            // A day's file is where the vault's journal settings put it, which the vectors'
            // `journal/<date>.md` paths are at the defaults; a day has no file row.
            apply(
                &core,
                "journal",
                id,
                json!({ "date": title, "aliases": note["aliases"] }),
            );
            continue;
        }
        let folder = path.rsplit_once('/').map(|(folder, _)| folder);
        apply(
            &core,
            "note",
            id,
            json!({ "title": title, "folderPath": folder, "fileType": "markdown", "aliases": note["aliases"] }),
        );
        let text = format!("# {title}\n");
        e.write(path, &text);
        let stat = RowStat {
            file_type: FileType::Markdown,
            size: text.len() as u64,
            content_hash: None,
            file_hash: None,
        };
        rows.reserve(session, id, path, stat).unwrap();
    }
    let links = NoteLinks::new(&e.session.current().unwrap());

    let cases = file["resolution"].as_array().unwrap();
    let queries: Vec<String> = cases
        .iter()
        .map(|case| case["query"].as_str().unwrap().to_owned())
        .collect();
    let batch = links.resolve_titles(queries.clone()).unwrap();
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let query = case["query"].as_str().unwrap();
        let expected = case["expected"]["noteId"].as_str();
        let found = links.resolve_by_title(query).unwrap();
        assert_eq!(found.as_ref().map(|f| f.id.as_str()), expected, "{name}");
        if let (Some(found), Some(id)) = (&found, expected) {
            assert_eq!(found.path, paths[id], "{name}: path");
            assert_eq!(found.file_type, "markdown", "{name}");
        }
        assert_eq!(
            batch[query],
            found.as_ref().map(|f| TitleMatchView {
                id: f.id.clone(),
                path: f.path.clone()
            }),
            "{name}: batch"
        );
        // A target with no `#` names what the whole title names.
        if !query.contains('#') {
            let target = links.resolve_wiki_target(query).unwrap();
            assert_eq!(target.map(|t| t.id), found.map(|f| f.id), "{name}: target");
        }
    }
    assert_eq!(batch.len(), queries.len(), "one entry per distinct title");

    let heading = links
        .resolve_wiki_target("Home/Plan#Goals")
        .unwrap()
        .unwrap();
    assert_eq!(
        (heading.id.as_str(), heading.heading.as_deref()),
        ("n-02", Some("Goals"))
    );
    let block = links.resolve_wiki_target("Kaan#^abc").unwrap().unwrap();
    assert_eq!((block.id.as_str(), block.heading), ("n-03", None));
    assert!(links.resolve_wiki_target("#Goals").unwrap().is_none());
    e.close();
}

#[test]
fn backlinks_carry_the_text_around_each_link_from_the_linking_file() {
    let store: Mutex<Option<Arc<dyn SecureStore>>> = Mutex::default();
    let mut e = env(|s| {
        *store.lock().unwrap() = Some(s.clone());
        Some(NotesIdentity::new(s))
    });
    e.write("Target.md", "# Target\n");
    e.write(
        "notes/Source.md",
        "Intro [[Target]] middle\n<!-- [[Target]] in a comment -->\n\n[[target|the target]] end\n",
    );
    e.write("Broken.md", "Points at [[Nothing Here]].\n");
    let index = NoteIndex::new(e.tier.clone());
    index.register(&e.session);
    e.open();
    e.facts_until(indexed);
    let id_at = |path: &str| -> String {
        e.rows()
            .into_iter()
            .find(|(_, p)| p == path)
            .unwrap_or_else(|| panic!("no row at {path}"))
            .0
    };
    let (target, source, broken) = (
        id_at("Target.md"),
        id_at("notes/Source.md"),
        id_at("Broken.md"),
    );
    let links = NoteLinks::new(&e.session.current().unwrap());
    until("the source's links indexed", || {
        links.get(&target).unwrap().incoming.len() == 1
            && !links.get(&broken).unwrap().outgoing.is_empty()
    });

    let got = links.get(&target).unwrap();
    assert!(got.outgoing.is_empty());
    let backlink = &got.incoming[0];
    assert_eq!(
        (
            backlink.source_id.as_str(),
            backlink.source_path.as_str(),
            backlink.source_title.as_str()
        ),
        (source.as_str(), "notes/Source.md", "Source")
    );
    let shown: Vec<String> = backlink
        .contexts
        .iter()
        .map(|c| {
            let units: Vec<u16> = c.snippet.encode_utf16().collect();
            String::from_utf16(&units[c.link_start as usize..c.link_end as usize]).unwrap()
        })
        .collect();
    // The commented link is not text the note shows.
    assert_eq!(shown, ["[[Target]]", "[[target|the target]]"]);
    assert_eq!(
        backlink.contexts[0].snippet,
        "Intro [[Target]] middle [[target|the target]] end"
    );

    let from_source = links.get(&source).unwrap();
    assert_eq!(from_source.outgoing.len(), 2, "{:?}", from_source.outgoing);
    assert!(
        from_source
            .outgoing
            .iter()
            .all(|link| link.target_id.as_deref() == Some(target.as_str())
                && link.source_id == source)
    );
    let from_broken = links.get(&broken).unwrap();
    assert_eq!(from_broken.outgoing[0].target_title, "Nothing Here");
    assert_eq!(from_broken.outgoing[0].target_id, None);
    assert!(links.get("no-such-note").unwrap().incoming.is_empty());
    drop(links);
    e.close();
}
