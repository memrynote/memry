//! A definition for every tag the notes use (#4418, Electron's `ensureTagDefinitions` and
//! `getOrCreateTag`), on real `data.db` and `index.db` files.
//!
//! | Test                                                         | Rule                                  |
//! | ------------------------------------------------------------ | ------------------------------------- |
//! | the used tags read in Electron's walk order, measured only   | `findVaultFiles` order; current bytes |
//! | each new definition takes the palette colour of the count    | `TAG_COLOR_PALETTE[count % 24]`       |
//! | an existing definition is never changed, a deleted one comes back | `getOrCreateTag` reads first     |

#![cfg(feature = "markdown")]

use memry_core::api::vault::Vault;
use memry_core::domain::tag_admin::{definitions, set_color};
use memry_core::domain::tag_mint::define_used;
use serde_json::Value;

use crate::tag_reads::{filed_as, measured, note, open};

/// A note filed at `path` whose file the index measured as `text`.
fn file(vault: &Vault, search: &memry_core::api::search::Search, id: &str, path: &str, text: &str) {
    note(vault, id, id, &[], "2026-01-01T00:00:00.000Z");
    filed_as(vault, id, path, Some(&format!("hash-{id}")));
    measured(search, id, text);
}

fn define(vault: &Vault, tags: &[&str], now: i64) -> usize {
    let tags: Vec<String> = tags.iter().map(|t| (*t).to_owned()).collect();
    vault
        .db_handle()
        .call_blocking(move |conn| define_used(conn, &tags, "desk", now))
        .expect("defined")
}

/// Each live definition's id and colour, by tag key.
fn colors(vault: &Vault) -> Vec<(String, String)> {
    vault
        .db_handle()
        .read_blocking(definitions)
        .expect("definitions")
        .into_values()
        .map(|d| (d.id, d.color))
        .collect()
}

fn queued(vault: &Vault) -> Vec<String> {
    vault
        .db_handle()
        .read_blocking(|conn| {
            let mut statement = conn
                .prepare(
                    "SELECT item_id FROM outbox WHERE item_type = 'tag_definition' ORDER BY id",
                )
                .unwrap();
            let ids = statement
                .query_map([], |row| row.get(0))
                .unwrap()
                .collect::<Result<Vec<String>, _>>()
                .unwrap();
            Ok(ids)
        })
        .expect("outbox")
}

/// Folder `b` sorts before `b.md`, as Electron's walk lists a folder's entries by name. A note
/// whose file changed since the index measured it (a rename took `gone` out) is left out until
/// the pass that measures it.
#[test]
fn the_used_tags_read_in_electrons_walk_order_measured_only() {
    let (_dir, vault, search) = open();
    file(&vault, &search, "n1", "b.md", "---\ntags: [health]\n---\n");
    file(
        &vault,
        &search,
        "n2",
        "a.md",
        "---\ntags: [meeting, Idea]\n---\n",
    );
    file(
        &vault,
        &search,
        "n3",
        "b/c.md",
        "---\ntags: [MEETING, focus]\n---\n",
    );
    note(&vault, "n4", "n4", &["gone"], "2026-01-01T00:00:00.000Z");
    filed_as(&vault, "n4", "0.md", Some("bytes-after-the-measure"));
    measured(&search, "n4", "---\ntags: [gone]\n---\n");
    assert_eq!(
        search.used_tags().expect("used"),
        ["meeting", "Idea", "focus", "health"]
    );
}

#[test]
fn each_new_definition_takes_the_palette_colour_of_the_count() {
    let (_dir, vault, _search) = open();
    assert_eq!(define(&vault, &["meeting", " Idea ", "idea", ""], 1), 2);
    assert_eq!(define(&vault, &["MEETING", "reading"], 2), 1);
    let mut got = colors(&vault);
    got.sort();
    assert_eq!(
        got,
        [
            ("idea".to_owned(), "pink".to_owned()),
            ("meeting".to_owned(), "rose".to_owned()),
            ("reading".to_owned(), "fuchsia".to_owned()),
        ]
    );
    assert_eq!(queued(&vault), ["meeting", "idea", "reading"]);
    let payload: Value = vault
        .db_handle()
        .read_blocking(|conn| {
            let raw: String = conn
                .query_row(
                    "SELECT payload FROM sync_items WHERE item_type = 'tag_definition'
                      AND item_id = 'idea'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            Ok(serde_json::from_str(&raw).unwrap())
        })
        .expect("payload");
    assert_eq!(payload["colorAuthored"], Value::Bool(false));
    assert_eq!(payload["name"], "idea");
}

#[test]
fn an_existing_definition_is_never_changed_and_a_deleted_one_comes_back() {
    let (_dir, vault, _search) = open();
    vault
        .db_handle()
        .call_blocking(|conn| set_color(conn, "Work", "teal", "desk", 1))
        .expect("colour");
    let before = queued(&vault).len();
    assert_eq!(define(&vault, &["work"], 2), 0);
    assert_eq!(queued(&vault).len(), before, "nothing re-sent");
    assert_eq!(colors(&vault), [("Work".to_owned(), "teal".to_owned())]);

    vault
        .db_handle()
        .call_blocking(|conn| {
            memry_core::domain::tag_admin::delete(conn, "work", "desk", 3)?;
            Ok(())
        })
        .expect("deleted");
    assert!(colors(&vault).is_empty());
    assert_eq!(define(&vault, &["work"], 4), 1);
    assert_eq!(colors(&vault), [("Work".to_owned(), "rose".to_owned())]);
}
