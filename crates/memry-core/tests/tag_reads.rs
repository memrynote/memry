//! The tag list and a tag's notes on desktop (#3530 13j), on real `data.db` and `index.db`
//! files: records applied as a pull applies them, file rows as the vault tier writes them, and
//! header tags measured from file text by the note index.
//!
//! | Test                                                      | Rule                                     |
//! | --------------------------------------------------------- | ---------------------------------------- |
//! | a note counts once across its record, body and file        | the union, one item per tag              |
//! | only filed notes and days count; tasks with their own tags | Electron's index holds files only        |
//! | the tag-fold vectors group spellings                       | §13.7.7 tag identity, `tagIs`/`tagKey`   |
//! | used by count, then authored unused by name                | `getAllTagsWithCounts`, `isAuthored`     |
//! | a tag's notes: pinned first, then sorted, descendants      | `findNotesWithTagInfo`                   |

#![cfg(feature = "markdown")]

mod support;

use std::sync::Arc;

use memry_core::api::search::Search;
use memry_core::api::vault::Vault;
use memry_core::domain::body_tags;
use memry_core::domain::note_files::NoteFileStat;
use memry_core::domain::note_list::NoteSort;
use memry_core::domain::note_stats::MeasuredFile;
use memry_core::domain::tag_admin::default_color;
use memry_core::domain::tag_reads::{TagCount, TaggedNote};
use memry_core::domain::tags::tag_key;
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use serde_json::{Value, json};
use support::vector_file;

fn open() -> (tempfile::TempDir, Vault, Arc<Search>) {
    let dir = tempfile::Builder::new()
        .prefix("memry-tag-reads-")
        .tempdir()
        .expect("the scratch directory");
    let vault = Vault::open("vault-1".to_owned(), dir.path().display().to_string()).expect("open");
    let search = vault.search().expect("index.db");
    (dir, vault, search)
}

/// Applies a record as a pull would.
fn record(vault: &Vault, item_type: &str, id: &str, payload: Value, deleted: bool) {
    let (item_type, id, payload) = (item_type.to_owned(), id.to_owned(), payload.to_string());
    vault
        .db_handle()
        .call_blocking(move |conn| {
            sync_items::apply_remote(
                conn,
                &InboundRecord {
                    item_type,
                    item_id: id,
                    payload_json: payload,
                    server_cursor: None,
                    signer_device_id: None,
                    updated_at: 1,
                    deleted_at: deleted.then_some(2),
                },
                1,
            )?;
            Ok(())
        })
        .expect("apply");
}

fn note(vault: &Vault, id: &str, title: &str, tags: &[&str], modified: &str) {
    let payload = json!({
        "title": title, "tags": tags, "clock": {"peer": 1},
        "createdAt": "2026-01-01T00:00:00.000Z", "modifiedAt": modified,
    });
    record(vault, "note", id, payload, false);
}

/// The file row the vault tier writes for a note's file.
fn filed(vault: &Vault, id: &str, path: &str) {
    vault
        .note_files()
        .upsert_stat(NoteFileStat {
            note_id: id.to_owned(),
            path: path.to_owned(),
            file_type: "markdown".to_owned(),
            mime_type: None,
            file_size: Some(1),
            content_hash: None,
            file_hash: None,
            indexed_at: 1,
        })
        .expect("row");
}

/// The note index's measure of the file `text`.
fn measured(search: &Search, id: &str, text: &str) {
    search
        .index_note_files(vec![MeasuredFile {
            note_id: id.to_owned(),
            file_hash: format!("hash-{id}"),
            text: text.to_owned(),
        }])
        .expect("measured");
}

fn body(vault: &Vault, id: &str, tags: &[&str]) {
    let (id, tags): (String, Vec<String>) = (
        id.to_owned(),
        tags.iter().map(|t| (*t).to_owned()).collect(),
    );
    vault
        .db_handle()
        .call_blocking(move |conn| body_tags::write(conn, &id, &tags))
        .expect("body tags");
}

fn counted(search: &Search) -> Vec<(String, u32)> {
    search
        .tag_counts()
        .expect("counts")
        .into_iter()
        .map(|tag| (tag.name, tag.count))
        .collect()
}

fn ids(notes: &[TaggedNote]) -> Vec<&str> {
    notes.iter().map(|note| note.id.as_str()).collect()
}

fn pair(name: &str, count: u32) -> (String, u32) {
    (name.to_owned(), count)
}

#[test]
fn a_note_counts_once_per_tag_across_its_record_body_and_file() {
    let (_dir, vault, search) = open();
    note(&vault, "n1", "One", &["Work"], "2026-01-02T00:00:00.000Z");
    filed(&vault, "n1", "One.md");
    body(&vault, "n1", &["work", "idea"]);
    measured(&search, "n1", "---\ntags: [WORK, plan]\n---\nwords #work\n");
    // Adopted from disk: the record carries no tags, the file does.
    note(&vault, "n2", "Two", &[], "2026-01-03T00:00:00.000Z");
    filed(&vault, "n2", "Two.md");
    measured(&search, "n2", "---\ntags:\n  - work\n---\n");

    assert_eq!(
        counted(&search),
        vec![pair("Work", 2), pair("idea", 1), pair("plan", 1)]
    );
    let n1 = search
        .tagged_notes("PLAN", false, NoteSort::Modified, false)
        .expect("tagged")
        .notes;
    assert_eq!(ids(&n1), ["n1"]);
    assert_eq!(
        n1[0].tags,
        ["Work", "idea", "plan"],
        "record, body, then file"
    );
}

#[test]
fn only_filed_notes_and_days_count_and_tasks_count_with_their_own_tags() {
    let (_dir, vault, search) = open();
    note(&vault, "kept", "Kept", &["a"], "2026-01-02T00:00:00.000Z");
    filed(&vault, "kept", "Kept.md");
    // A synced note with no file yet is not listed anywhere, so it is not counted.
    note(
        &vault,
        "unfiled",
        "Unfiled",
        &["a", "b"],
        "2026-01-02T00:00:00.000Z",
    );
    // Deleted after it was filed and measured: its file row and index row outlive the record.
    note(&vault, "gone", "Gone", &["a"], "2026-01-02T00:00:00.000Z");
    filed(&vault, "gone", "Gone.md");
    measured(&search, "gone", "---\ntags: [a]\n---\n");
    record(
        &vault,
        "note",
        "gone",
        json!({"title": "Gone", "tags": ["a"]}),
        true,
    );
    record(
        &vault,
        "journal",
        "j2026-01-05",
        json!({"date": "2026-01-05", "tags": ["A"], "clock": {"peer": 1}}),
        false,
    );
    filed(&vault, "j2026-01-05", "journal/2026-01-05.md");
    record(
        &vault,
        "task",
        "t1",
        json!({"title": "t", "tags": ["A", "a", "c"], "clock": {"peer": 1}}),
        false,
    );
    record(
        &vault,
        "task",
        "t2",
        json!({"title": "t", "tags": ["c"]}),
        true,
    );

    assert_eq!(counted(&search), vec![pair("A", 3), pair("c", 1)]);
    let day = search
        .tagged_notes("a", false, NoteSort::Title, true)
        .expect("tagged")
        .notes;
    assert_eq!(ids(&day), ["j2026-01-05", "kept"]);
    assert_eq!(day[0].title, "2026-01-05", "a day is titled by its date");
    assert_eq!(day[0].path, "journal/2026-01-05.md");
}

#[test]
fn the_tag_fold_vectors_group_the_spellings_of_one_tag() {
    let file = vector_file("tag-fold");
    for case in file["cases"].as_array().expect("cases") {
        let name = case["name"].as_str().expect("named");
        let input = &case["input"];
        let list = |key: &str| -> Vec<String> {
            input[key]
                .as_array()
                .map(|items| {
                    items
                        .iter()
                        .map(|s| s.as_str().expect("string").to_owned())
                        .collect()
                })
                .unwrap_or_default()
        };
        let tag = input["tag"].as_str().expect("tag").to_owned();
        let (equal, distinct) = (list("equal"), list("distinct"));
        let (_dir, vault, search) = open();
        let mut spellings = vec![("tag".to_owned(), tag.clone())];
        spellings.extend(
            equal
                .iter()
                .enumerate()
                .map(|(i, s)| (format!("eq{i}"), s.clone())),
        );
        spellings.extend(
            distinct
                .iter()
                .enumerate()
                .map(|(i, s)| (format!("di{i}"), s.clone())),
        );
        for (id, spelling) in &spellings {
            note(&vault, id, id, &[spelling], "2026-01-02T00:00:00.000Z");
            filed(&vault, id, &format!("{id}.md"));
        }

        // `tagIs`: every equal spelling, and no distinct one.
        let tagged = search
            .tagged_notes(&tag, false, NoteSort::Title, true)
            .expect("tagged")
            .notes;
        let mut want: Vec<String> = vec!["tag".to_owned()];
        want.extend((0..equal.len()).map(|i| format!("eq{i}")));
        want.sort();
        assert_eq!(ids(&tagged), want, "{name}: the notes of {tag:?}");

        // The list merges by key (`tagKey`): a distinct spelling with the tag's key, which
        // only trimming makes, joins it.
        let key = case["expected"]["key"].as_str().expect("key");
        let joined = distinct.iter().filter(|d| tag_key(d) == key).count();
        let counts: Vec<TagCount> = search.tag_counts().expect("counts");
        let mine = counts
            .iter()
            .find(|t| tag_key(&t.name) == key)
            .unwrap_or_else(|| panic!("{name}: no entry for {key:?}"));
        assert_eq!(mine.count as usize, 1 + equal.len() + joined, "{name}");
        let total: u32 = counts.iter().map(|t| t.count).sum();
        assert_eq!(
            total as usize,
            spellings.len(),
            "{name}: one count per note"
        );
    }
}

#[test]
fn used_tags_come_by_count_then_the_authored_unused_ones_by_name() {
    let (_dir, vault, search) = open();
    for (id, tags) in [("n1", vec!["rare", "common"]), ("n2", vec!["common"])] {
        note(&vault, id, id, &tags, "2026-01-02T00:00:00.000Z");
        filed(&vault, id, &format!("{id}.md"));
    }
    let definition = |name: &str, extra: Value| {
        let mut payload = json!({"name": name, "color": "teal", "clock": {"peer": 1}});
        for (key, value) in extra.as_object().expect("object") {
            payload[key] = value.clone();
        }
        record(&vault, "tag_definition", name, payload, false);
    };
    definition(
        "common",
        json!({"icon": "📚", "categoryId": "cat-1", "sortOrder": 4}),
    );
    definition("zeta", json!({"icon": "icon:Star", "colorAuthored": false}));
    definition("Alpha", json!({"colorAuthored": true}));
    definition(
        "beta",
        json!({"categoryId": "cat-2", "colorAuthored": false}),
    );
    definition(
        "schema",
        json!({"schema": {"t": 1, "fields": []}, "colorAuthored": false}),
    );
    // Minted on the way past and never used: Electron collects it, here it is left out.
    definition("minted", json!({"colorAuthored": false}));

    let counts = search.tag_counts().expect("counts");
    let names: Vec<(&str, u32)> = counts.iter().map(|t| (t.name.as_str(), t.count)).collect();
    assert_eq!(
        names,
        [
            ("common", 2),
            ("rare", 1),
            ("Alpha", 0),
            ("beta", 0),
            ("schema", 0),
            ("zeta", 0)
        ]
    );
    let common = &counts[0];
    assert_eq!(
        (common.color.as_str(), common.icon.as_deref()),
        ("teal", Some("📚"))
    );
    assert_eq!(
        (common.category_id.as_deref(), common.sort_order),
        (Some("cat-1"), 4)
    );
    assert_eq!(counts[1].color, default_color("rare"), "no definition");
    let color = |tag: &str| {
        search
            .tagged_notes(tag, false, NoteSort::Title, true)
            .expect("tagged")
            .color
    };
    assert_eq!(color("COMMON"), "teal", "a tag's notes carry its colour");
    assert_eq!(color("rare"), default_color("rare"));
    assert_eq!(counts[1].icon, None);
    assert_eq!(counts[3].category_id.as_deref(), Some("cat-2"));
}

#[test]
fn a_tags_notes_list_the_pinned_first_then_sorted_with_descendants_on_request() {
    let (_dir, vault, search) = open();
    let notes: [(&str, &str, &[&str], &str); 5] = [
        ("a", "Banana", &["Project"], "2026-01-05T00:00:00.000Z"),
        ("b", "apple", &["project/Sub"], "2026-01-04T00:00:00.000Z"),
        ("c", "Cherry", &["projects"], "2026-01-03T00:00:00.000Z"),
        ("d", "date", &["project"], "2026-01-02T00:00:00.000Z"),
        ("e", "Elder", &["project"], "2026-01-01T00:00:00.000Z"),
    ];
    for (id, title, tags, modified) in notes {
        note(&vault, id, title, tags, modified);
        filed(&vault, id, &format!("{id}.md"));
    }
    // Pinned by its record; the pin reads from `pinnedTags`.
    let pinned = json!({
        "title": "Elder", "tags": ["project"], "pinnedTags": ["project"], "clock": {"peer": 2},
        "createdAt": "2026-01-01T00:00:00.000Z", "modifiedAt": "2026-01-01T00:00:00.000Z",
    });
    record(&vault, "note", "e", pinned, false);

    let by = |descendants, sort, ascending| {
        ids(&search
            .tagged_notes("PROJECT", descendants, sort, ascending)
            .expect("tagged")
            .notes)
        .into_iter()
        .map(str::to_owned)
        .collect::<Vec<_>>()
    };
    assert_eq!(by(false, NoteSort::Modified, false), ["e", "a", "d"]);
    assert_eq!(by(false, NoteSort::Modified, true), ["e", "d", "a"]);
    assert_eq!(by(true, NoteSort::Title, true), ["e", "b", "a", "d"]);
    assert_eq!(by(true, NoteSort::Title, false), ["e", "d", "a", "b"]);
    let elder = search
        .tagged_notes("project", false, NoteSort::Title, true)
        .expect("tagged")
        .notes;
    assert!(elder[0].pinned_at.is_some());
    assert!(elder[1..].iter().all(|note| note.pinned_at.is_none()));
}

#[test]
fn a_missing_index_row_still_lists_the_records_tags() {
    let (_dir, vault, search) = open();
    note(&vault, "n", "N", &["kept"], "2026-01-02T00:00:00.000Z");
    filed(&vault, "n", "N.md");
    assert_eq!(counted(&search), vec![pair("kept", 1)]);
    assert_eq!(
        search
            .tagged_notes("kept", false, NoteSort::Title, true)
            .expect("tagged")
            .notes[0]
            .word_count,
        0
    );
    measured(&search, "n", "three words here\n");
    assert_eq!(
        search
            .tagged_notes("kept", false, NoteSort::Title, true)
            .expect("tagged")
            .notes[0]
            .word_count,
        3
    );
}
