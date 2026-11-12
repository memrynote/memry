//! The note index gives every tag the vault's notes use a definition (#4418), as Electron's
//! indexer does (`ensureTagDefinitions`), over a real session, tier, watcher and index task.
//!
//! | Test                                                        | Rule                                 |
//! | ----------------------------------------------------------- | ------------------------------------ |
//! | the open's pass defines each tag in Electron's walk order   | `TAG_COLOR_PALETTE[count % 24]`      |
//! | a definition someone made keeps its colour                  | an existing definition is never edited |
//! | an outside edit's new tag is defined by its pass            | a later file's tag is defined too    |
//! | an open defines the tags an older build indexed without one | existing vaults catch up on open     |

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::index_support;
#[allow(unused_imports)]
use crate::vault_env;

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use index_support::until;
use memry_core::domain::tag_admin::definitions;
use memry_core::seams::secure_store::SecureStore;
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::index::NoteIndex;
use serde_json::Value;
use vault_env::{Env, env, indexed};

/// The seed of `pnpm seed:rich` in miniature: a folder that sorts before a note of the same
/// stem, frontmatter tags and a body `#tag`.
const FILES: [(&str, &str); 4] = [
    ("b.md", "---\ntags: [health]\n---\nBody.\n"),
    ("a.md", "---\ntags: [meeting, Idea]\n---\nSee #reading.\n"),
    ("b/c.md", "---\ntags: [meeting]\n---\nAbout #focus.\n"),
    ("journal/2026-11-05.md", "Day #idea #walk\n"),
];

fn opened(files: &[(&str, &str)]) -> (Env, Arc<dyn SecureStore>) {
    let store: Mutex<Option<Arc<dyn SecureStore>>> = Mutex::default();
    let mut e = env(|s| {
        *store.lock().unwrap() = Some(s.clone());
        Some(NotesIdentity::new(s))
    });
    for (rel, text) in files {
        e.write(rel, text);
    }
    NoteIndex::new(e.tier.clone(), |_| {}, |_| {}, |_| {}).register(&e.session);
    e.open();
    e.facts_until(indexed);
    until("every file read", || index_support::all_indexed(&e));
    (e, store.into_inner().unwrap().unwrap())
}

/// Each live definition's name and colour, by tag key.
fn colors(e: &Env) -> BTreeMap<String, (String, String)> {
    e.core()
        .db_handle()
        .read_blocking(definitions)
        .unwrap()
        .into_iter()
        .map(|(key, d)| (key, (d.id, d.color)))
        .collect()
}

fn color(e: &Env, tag: &str) -> Option<String> {
    colors(e).remove(tag).map(|(_, color)| color)
}

/// The `tag_definition` record of `id`, and whether the outbox holds it.
fn record(e: &Env, id: &str) -> (Value, bool) {
    let id = id.to_owned();
    e.core()
        .db_handle()
        .read_blocking(move |conn| {
            let payload: String = conn
                .query_row(
                    "SELECT payload FROM sync_items WHERE item_type = 'tag_definition'
                      AND item_id = ?1",
                    [&id],
                    |row| row.get(0),
                )
                .unwrap();
            let queued: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM outbox WHERE item_type = 'tag_definition'
                      AND item_id = ?1",
                    [&id],
                    |row| row.get(0),
                )
                .unwrap();
            Ok((serde_json::from_str(&payload).unwrap(), queued > 0))
        })
        .unwrap()
}

/// Electron reads `a.md`, then `b/c.md` (folder `b` sorts before `b.md`), then `b.md`, then the
/// day: each new tag takes the next palette colour, in the order its file lists it.
#[test]
fn the_opens_pass_defines_each_tag_in_electrons_walk_order() {
    let (e, _) = opened(&FILES);
    until("every tag defined", || colors(&e).len() == 6);
    let named: Vec<(String, String)> = colors(&e).into_values().collect();
    let expected = [
        ("meeting", "rose"),
        ("idea", "pink"),
        ("reading", "fuchsia"),
        ("focus", "purple"),
        ("health", "violet"),
        ("walk", "indigo"),
    ];
    for (name, wanted) in expected {
        assert!(
            named.iter().any(|(id, c)| id == name && c == wanted),
            "{name} not {wanted}: {named:?}"
        );
    }
    let (payload, queued) = record(&e, "meeting");
    assert_eq!(payload["colorAuthored"], Value::Bool(false));
    assert_eq!(payload["color"], "rose");
    assert!(queued, "the definition goes to sync");
}

/// A colour picked before the pass, or after it, stays; the pass mints the others around it.
#[test]
fn a_definition_someone_made_keeps_its_colour() {
    let (e, store) = opened(&[]);
    let hub = e.core().tag_hub(store).unwrap();
    hub.set_color("Meeting", "teal").unwrap();
    e.write("a.md", "---\ntags: [meeting, idea]\n---\n");
    until("idea defined", || color(&e, "idea").is_some());
    assert_eq!(color(&e, "meeting").as_deref(), Some("teal"));
    assert_eq!(color(&e, "idea").as_deref(), Some("pink"));
    let (payload, _) = record(&e, "Meeting");
    assert_eq!(payload["colorAuthored"], Value::Bool(true));
}

/// A tag an outside edit adds is defined by the pass that reads the edit, after the others.
#[test]
fn an_outside_edits_new_tag_is_defined_by_its_pass() {
    let (e, _) = opened(&FILES);
    until("every tag defined", || colors(&e).len() == 6);
    e.write("b.md", "---\ntags: [health, later]\n---\nBody.\n");
    until("later defined", || color(&e, "later").is_some());
    assert_eq!(color(&e, "later").as_deref(), Some("blue"));
    assert_eq!(color(&e, "health").as_deref(), Some("violet"));
}

/// A vault an older build indexed holds its notes' rows and no definitions: the next open's
/// pass reads no file, and still defines every tag.
#[test]
fn an_open_defines_the_tags_an_older_build_indexed_without_one() {
    let (mut e, _) = opened(&FILES);
    until("every tag defined", || colors(&e).len() == 6);
    e.close();
    let data = e.vault.join(".memry/core/data.db");
    let conn = rusqlite::Connection::open(&data).unwrap();
    conn.execute_batch(
        "DELETE FROM tag_definitions;
         DELETE FROM sync_items WHERE item_type = 'tag_definition';
         DELETE FROM outbox WHERE item_type = 'tag_definition';",
    )
    .unwrap();
    drop(conn);
    e.open();
    until("every tag defined again", || colors(&e).len() == 6);
    assert_eq!(color(&e, "meeting").as_deref(), Some("rose"));
    assert_eq!(color(&e, "walk").as_deref(), Some("indigo"));
}
