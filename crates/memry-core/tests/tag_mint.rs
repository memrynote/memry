//! A definition for every tag the notes use (#4418, Electron's `ensureTagDefinitions` and
//! `getOrCreateTag`), on real `data.db` and `index.db` files.
//!
//! | Test                                                         | Rule                                  |
//! | ------------------------------------------------------------ | ------------------------------------- |
//! | the used tags read in Electron's walk order, measured only   | `findVaultFiles` order; current bytes |
//! | each new definition takes the palette colour of the count    | `TAG_COLOR_PALETTE[count % 24]`, unclocked |
//! | an existing definition is never changed, a deleted one stays deleted | `getOrCreateTag` reads first; a tombstone wins |
//! | a dropped mint leaves the tag live when a live spelling survives | the seed rebuilds deleted first, live last |
//!
//! The seed that pushes a mint after the pull is `memry-desktop`'s `tag_definitions_sync`.

#![cfg(feature = "markdown")]

use memry_core::api::vault::Vault;
use memry_core::domain::tag_admin::{definitions, set_color};
use memry_core::domain::tag_mint::{define_used, seed};
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use serde_json::{Value, json};

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
        .call_blocking(move |conn| define_used(conn, &tags, now))
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
        search.used_tags(None).expect("used"),
        ["meeting", "Idea", "focus", "health"]
    );
    assert_eq!(
        search
            .used_tags(Some(vec!["n1".into(), "n3".into(), "n4".into()]))
            .expect("used"),
        ["MEETING", "focus", "health"],
        "only the files named, measured ones only"
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
    assert!(queued(&vault).is_empty(), "minted, not queued");
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
    assert!(
        payload.get("clock").is_none(),
        "unclocked until the sync pass seeds it"
    );
}

/// A deleted tag stays deleted while a note still carries it, whatever the spelling.
#[test]
fn an_existing_definition_is_never_changed_and_a_deleted_one_stays_deleted() {
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
    let before = queued(&vault);
    assert_eq!(define(&vault, &["work", "WORK"], 4), 0);
    assert!(colors(&vault).is_empty(), "the deletion stands");
    assert_eq!(queued(&vault), before, "nothing queued");
}

/// A definition another device pushed, as a pull applies it.
fn pulled(vault: &Vault, name: &str, color: &str, deleted: bool) {
    let record = InboundRecord {
        item_type: "tag_definition".to_owned(),
        item_id: name.to_owned(),
        payload_json: json!({
            "name": name,
            "color": color,
            "colorAuthored": true,
            "createdAt": "2026-01-01T00:00:00.000Z",
        })
        .to_string(),
        server_cursor: Some(1),
        signer_device_id: Some("device-b".to_owned()),
        updated_at: 5,
        deleted_at: deleted.then_some(5),
    };
    vault
        .db_handle()
        .call_blocking(move |conn| sync_items::apply_remote(conn, &record, 5).map(drop))
        .expect("apply");
}

/// The seed drops a mint whose key other records hold and makes the shared row again from
/// them, deleted ones first and live ones last: a live spelling leaves the tag live whatever
/// order the pull wrote them in (#4278).
#[test]
fn a_dropped_mint_leaves_the_tag_live_when_a_live_spelling_survives() {
    for deleted_first in [true, false] {
        let (_dir, vault, _search) = open();
        assert_eq!(define(&vault, &["idea"], 1), 1);
        if deleted_first {
            pulled(&vault, "Idea", "rose", true);
            pulled(&vault, "IDEA", "teal", false);
        } else {
            pulled(&vault, "IDEA", "teal", false);
            pulled(&vault, "Idea", "rose", true);
        }
        let seeded = vault
            .db_handle()
            .call_blocking(|conn| seed(conn, "desk", 6))
            .expect("seeded");
        assert!(seeded.is_empty(), "the mint is dropped");
        assert_eq!(
            colors(&vault),
            [("IDEA".to_owned(), "teal".to_owned())],
            "deleted pulled first: {deleted_first}"
        );
        // The row is the live record's, so a recolour reaches it.
        vault
            .db_handle()
            .call_blocking(|conn| set_color(conn, "idea", "red", "desk", 7))
            .expect("recoloured");
        assert_eq!(colors(&vault), [("IDEA".to_owned(), "red".to_owned())]);
    }
}
