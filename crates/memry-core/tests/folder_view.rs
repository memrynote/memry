//! A folder view's rows and a tag's table (#3547 30b) on real `data.db` and `index.db` files,
//! records applied as a pull applies them, the oracle being Electron's
//! `folder-view-handlers.ts` (`list-with-properties`, `get-available-properties`) and
//! `tags/objects.ts` (`listFieldTagRows`).

#![cfg(feature = "markdown")]

use std::collections::BTreeMap;

use memry_core::api::search::Search;
use memry_core::api::vault::Vault;
use memry_core::domain::folder_view::{ItemKind, RowSet};
use memry_core::domain::note_stats::MeasuredFile;
use memry_core::domain::property_values::IndexedProperty;
use memry_core::domain::tag_schema::{DefinitionInput, PropertyInfo, StoredSchema, resolve};
use memry_core::domain::tag_views::{self, TagViews};
use serde_json::json;

use crate::tag_reads::{filed, measured, note, open, record};

fn with_status(search: &Search, id: &str, status: &str) {
    search
        .index_note_files(vec![MeasuredFile {
            note_id: id.to_owned(),
            file_hash: format!("hash-{id}"),
            text: format!("---\nstatus: {status}\n---\nsome words here\n"),
            properties: vec![IndexedProperty {
                name: "status".to_owned(),
                type_name: "text".to_owned(),
                text: Some(status.to_owned()),
                value: json!(status),
            }],
        }])
        .expect("measured");
}

fn seed_folder(vault: &Vault, search: &Search) {
    for (id, path, modified) in [
        ("deep", "Projects/2024/Deep.md", "2026-01-01T00:00:00.000Z"),
        ("top", "Projects/Top.md", "2026-01-02T00:00:00.000Z"),
        ("outside", "Projects-old/Out.md", "2026-01-03T00:00:00.000Z"),
        ("own", "Projects.md", "2026-01-04T00:00:00.000Z"),
    ] {
        note(vault, id, id, &[], modified);
        filed(vault, id, path);
    }
    with_status(search, "top", "done");
    with_status(search, "own", "draft");
    // A journal day under the folder is no row of it.
    let day = json!({"date": "2026-01-05", "clock": {"peer": 1}});
    record(vault, "journal", "j2026-01-05", day, false);
    filed(vault, "j2026-01-05", "Projects/2026-01-05.md");
}

/// A folder lists its notes at any depth, oldest change first, then the note beside it that
/// is its own page (`32cd745cb5`); never a folder that only shares its prefix, never a day.
#[test]
fn a_folder_lists_its_notes_then_its_own_note() {
    let (_dir, vault, search) = open();
    seed_folder(&vault, &search);

    let page = search.folder_rows("Projects", 500, 0).expect("rows");
    let shown: Vec<(&str, &str)> = page
        .rows
        .iter()
        .map(|row| (row.id.as_str(), row.folder.as_str()))
        .collect();
    assert_eq!(shown, [("deep", "/2024"), ("top", "/"), ("own", "/")]);
    assert_eq!((page.total, page.has_more), (3, false));
    let top = &page.rows[1];
    assert_eq!(top.properties.get("status"), Some(&json!("done")));
    assert_eq!(top.word_count, 3);
    assert_eq!(top.kind, None);

    // The own note rides on the last page only, so offsets keep lining up.
    let first = search.folder_rows("Projects", 1, 0).expect("first page");
    assert_eq!(first.rows.len(), 1);
    assert!(first.has_more);
    let last = search.folder_rows("Projects", 2, 1).expect("last page");
    let ids: Vec<&str> = last.rows.iter().map(|row| row.id.as_str()).collect();
    assert_eq!(ids, ["top", "own"]);

    // The vault root lists every note, each folder relative to the root.
    let root = search.folder_rows("", 500, 0).expect("root");
    assert_eq!(root.rows.len(), 4);
    assert_eq!(root.rows[0].folder, "/Projects/2024");

    let mut ids = search.folder_note_ids("Projects").expect("ids");
    ids.sort();
    assert_eq!(ids, ["deep", "own", "top"]);
    let counts = search.property_counts(&ids, &[]).expect("counts");
    assert_eq!(counts.len(), 1);
    assert_eq!(
        (counts[0].name.as_str(), counts[0].usage_count),
        ("status", 2)
    );
}

/// A tag lists the notes, days and tasks carrying it or a `/` tag under it; an AND tag narrows
/// them by the same rule.
#[test]
fn a_tag_lists_notes_and_tasks_under_it_narrowed_by_and_tags() {
    let (_dir, vault, search) = open();
    note(
        &vault,
        "both",
        "Both",
        &["alpha", "beta"],
        "2026-01-01T00:00:00.000Z",
    );
    filed(&vault, "both", "a/Both.md");
    note(
        &vault,
        "only",
        "Only",
        &["Alpha/sub"],
        "2026-01-02T00:00:00.000Z",
    );
    filed(&vault, "only", "Only.md");
    note(
        &vault,
        "longer",
        "Longer",
        &["alphabet"],
        "2026-01-03T00:00:00.000Z",
    );
    filed(&vault, "longer", "Longer.md");
    let task = json!({"title": "Ship", "projectId": "p1", "tags": ["ALPHA", "beta"], "clock": {"peer": 1}});
    record(&vault, "task", "t1", task, false);

    let rows = search.tag_rows("alpha", &[]).expect("rows");
    let mut shown: Vec<(&str, Option<ItemKind>, &str)> = rows
        .iter()
        .map(|row| (row.id.as_str(), row.kind, row.folder.as_str()))
        .collect();
    shown.sort_by_key(|row| row.0);
    assert_eq!(
        shown,
        [
            ("both", Some(ItemKind::Note), "a"),
            ("only", Some(ItemKind::Note), ""),
            ("t1", Some(ItemKind::Task), ""),
        ]
    );
    let task_row = rows.iter().find(|row| row.id == "t1").expect("task");
    assert_eq!(task_row.path, "/tasks/t1");

    let mut narrowed: Vec<String> = search
        .tag_rows("alpha", &["beta".to_owned()])
        .expect("narrowed")
        .into_iter()
        .map(|row| row.id)
        .collect();
    narrowed.sort();
    assert_eq!(narrowed, ["both", "t1"]);
    let mut ids = search
        .tag_note_ids("alpha", &["beta".to_owned()])
        .expect("ids");
    ids.sort();
    assert_eq!(ids, ["both"]);
}

/// A tag with fields lists its objects (a header carries it or a tag extending it, the latter
/// named `viaTag`), or asked for mentions the items that only carry it in a body.
#[test]
fn a_tag_with_fields_lists_its_objects_or_its_mentions() {
    let (_dir, vault, search) = open();
    for (id, header) in [("ada", "person"), ("bob", "employee")] {
        note(&vault, id, id, &[], "2026-01-01T00:00:00.000Z");
        filed(&vault, id, &format!("{id}.md"));
        measured(&search, id, &format!("---\ntags: [{header}]\n---\n"));
    }
    note(
        &vault,
        "memo",
        "memo",
        &["person"],
        "2026-01-02T00:00:00.000Z",
    );
    filed(&vault, "memo", "memo.md");
    measured(&search, "memo", "---\ntitle: memo\n---\nabout a #person\n");

    let field = |name: &str| json!({"t": 1, "fields": [{"name": name}]});
    let definitions = BTreeMap::from([
        (
            "person".to_owned(),
            DefinitionInput {
                name: "person".to_owned(),
                color: "blue".to_owned(),
                icon: None,
                schema: StoredSchema::parse(Some(&field("Role"))),
            },
        ),
        (
            "employee".to_owned(),
            DefinitionInput {
                name: "employee".to_owned(),
                color: "red".to_owned(),
                icon: None,
                schema: StoredSchema::parse(Some(
                    &json!({"t": 1, "extends": "person", "fields": [{"name": "Team"}]}),
                )),
            },
        ),
    ]);
    let resolved = resolve(&definitions, &|_| None::<PropertyInfo>);

    let objects = search
        .field_tag_rows(&resolved, "person", &[], RowSet::Objects)
        .expect("objects")
        .expect("person has fields");
    let mut shown: Vec<(&str, Option<&str>)> = objects
        .rows
        .iter()
        .map(|row| (row.id.as_str(), row.via_tag.as_deref()))
        .collect();
    shown.sort();
    assert_eq!(shown, [("ada", None), ("bob", Some("employee"))]);

    let mentions = search
        .field_tag_rows(&resolved, "person", &[], RowSet::Mentions)
        .expect("mentions")
        .expect("person has fields");
    let ids: Vec<&str> = mentions.rows.iter().map(|row| row.id.as_str()).collect();
    assert_eq!(ids, ["memo"]);

    assert!(
        search
            .field_tag_rows(&resolved, "plain", &[], RowSet::Objects)
            .expect("plain")
            .is_none()
    );
}

/// A tag's saved views read from its definition by key. The projection keeps only a list, so a
/// synced value of another type reads as absent; a stored value that does not parse reads as
/// unparsed (`readTagViews` reads both as none).
#[test]
fn a_tags_saved_views_read_by_key_and_bad_ones_as_none() {
    let (_dir, vault, _search) = open();
    let views = json!([{"name": "Board", "type": "kanban"}]);
    let def = json!({"name": "work", "color": "blue", "views": views, "clock": {"peer": 1}});
    record(&vault, "tag_definition", "work", def, false);
    let bad = json!({"name": "home", "color": "blue", "views": "nope", "clock": {"peer": 1}});
    record(&vault, "tag_definition", "home", bad, false);

    let read = |tag: &str| {
        let tag = tag.to_owned();
        vault
            .db_handle()
            .read_blocking(move |conn| tag_views::read(conn, &tag))
            .expect("read")
    };
    assert_eq!(
        read(" WORK "),
        TagViews::Saved(vec![json!({"name": "Board", "type": "kanban"})])
    );
    assert_eq!(read("home"), TagViews::Absent);
    assert_eq!(read("missing"), TagViews::Absent);
    vault
        .db_handle()
        .call_blocking(|conn| {
            conn.execute(
                "UPDATE tag_definitions SET views = '[' WHERE name = 'work'",
                [],
            )
            .map_err(|e| memry_core::api::errors::StorageError::Failed {
                what: e.to_string(),
            })
        })
        .expect("a damaged column");
    assert_eq!(read("work"), TagViews::Unparsed);
}
