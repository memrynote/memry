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
//! | a current file's header stands for the record's tags       | an outside edit reaches the file only    |

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
    record_at(vault, item_type, id, payload, deleted, 1);
}

/// [`record`] applied at `now` (a pin's `pinned_at` is its apply time).
fn record_at(vault: &Vault, item_type: &str, id: &str, payload: Value, deleted: bool, now: i64) {
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
                now,
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

/// The file row the vault tier writes for a note's file, whose bytes it does not know.
fn filed(vault: &Vault, id: &str, path: &str) {
    filed_as(vault, id, path, None);
}

/// [`filed`] with the hash of the bytes on disk now: [`measured`]'s `hash-<id>` makes the
/// index current.
fn filed_as(vault: &Vault, id: &str, path: &str, file_hash: Option<&str>) {
    vault
        .note_files()
        .upsert_stat(NoteFileStat {
            note_id: id.to_owned(),
            path: path.to_owned(),
            file_type: "markdown".to_owned(),
            mime_type: None,
            file_size: Some(1),
            content_hash: None,
            file_hash: file_hash.map(str::to_owned),
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
    note(
        &vault,
        "n1",
        "One",
        &["Work", "Alpha"],
        "2026-01-02T00:00:00.000Z",
    );
    filed(&vault, "n1", "One.md");
    body(&vault, "n1", &["work", "mid", "idea"]);
    measured(&search, "n1", "---\ntags: [WORK, plan]\n---\nwords #work\n");
    // Adopted from disk: the record carries no tags, the file does.
    note(&vault, "n2", "Two", &[], "2026-01-03T00:00:00.000Z");
    filed(&vault, "n2", "Two.md");
    measured(&search, "n2", "---\ntags:\n  - work\n---\n");

    assert_eq!(
        counted(&search),
        vec![
            pair("Work", 2),
            pair("Alpha", 1),
            pair("idea", 1),
            pair("mid", 1),
            pair("plan", 1)
        ]
    );
    let n1 = search
        .tagged_notes("PLAN", false, NoteSort::Modified, false)
        .expect("tagged")
        .notes;
    assert_eq!(ids(&n1), ["n1"]);
    assert_eq!(
        n1[0].tags,
        ["Work", "Alpha", "mid", "idea", "plan"],
        "record, body, then file, each in its own order"
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
        json!({
            "date": "2026-01-05", "tags": ["A"], "clock": {"peer": 1},
            "createdAt": "2026-01-05T08:00:00.000Z", "modifiedAt": "2026-01-05T09:00:00.000Z",
        }),
        false,
    );
    filed(&vault, "j2026-01-05", "journal/2026-01-05.md");
    // A day deleted the same way.
    let day = json!({"date": "2026-01-06", "tags": ["a"], "clock": {"peer": 1}});
    record(&vault, "journal", "j2026-01-06", day.clone(), false);
    filed(&vault, "j2026-01-06", "journal/2026-01-06.md");
    measured(&search, "j2026-01-06", "---\ntags: [a]\n---\n");
    record(&vault, "journal", "j2026-01-06", day, true);
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
    // Only an array's strings are tags.
    let odd = [json!("solo"), json!([7, "c", null])];
    for (i, tags) in odd.into_iter().enumerate() {
        let payload = json!({"title": "t", "tags": tags, "clock": {"peer": 1}});
        record(&vault, "task", &format!("odd{i}"), payload, false);
    }

    assert_eq!(counted(&search), vec![pair("A", 3), pair("c", 2)]);
    let day = search
        .tagged_notes("a", false, NoteSort::Title, true)
        .expect("tagged")
        .notes;
    assert_eq!(ids(&day), ["j2026-01-05", "kept"]);
    assert_eq!(day[0].title, "2026-01-05", "a day is titled by its date");
    assert_eq!(day[0].path, "journal/2026-01-05.md");
    assert!(
        day[0]
            .created_at
            .is_some_and(|c| c < day[0].modified_at.expect("modified"))
    );
    assert_eq!(day[0].emoji, None);
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
    // `  rare ` and `rare` are one tag, listed trimmed.
    let used = [
        ("n1", vec!["rare", "common"]),
        ("n2", vec!["common"]),
        ("n3", vec!["  rare "]),
    ];
    for (id, tags) in used {
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
    // Capitalised, so the fold order differs from the byte order.
    definition("Zeta", json!({"icon": "icon:Star", "colorAuthored": false}));
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
    definition("unschemed", json!({"schema": null, "colorAuthored": false}));

    let counts = search.tag_counts().expect("counts");
    let names: Vec<(&str, u32)> = counts.iter().map(|t| (t.name.as_str(), t.count)).collect();
    assert_eq!(
        names,
        [
            ("common", 2),
            ("rare", 2),
            ("Alpha", 0),
            ("beta", 0),
            ("schema", 0),
            ("Zeta", 0)
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
    assert_eq!(
        (counts[1].category_id.as_deref(), counts[1].sort_order),
        (None, 0)
    );
    let zeta = &counts[5];
    assert_eq!(
        (zeta.color.as_str(), zeta.icon.as_deref()),
        ("teal", Some("icon:Star")),
        "an unused tag shows its definition"
    );
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
    // Created in an order that is neither the titles' nor the modified instants'.
    let notes: [(&str, &str, &[&str], &str, &str); 6] = [
        ("a", "Banana", &["Project"], "01", "05"),
        ("b", "apple", &["project/Sub"], "03", "04"),
        ("c", "Cherry", &["projects"], "04", "03"),
        ("d", "date", &["project"], "02", "02"),
        ("e", "Elder", &["project"], "05", "01"),
        ("f", "Fig", &["project"], "06", "06"),
    ];
    let day = |dd: &str| format!("2026-01-{dd}T00:00:00.000Z");
    for (id, title, tags, created, modified) in notes {
        let payload = json!({
            "title": title, "tags": tags, "emoji": (id == "a").then_some("📚"),
            "clock": {"peer": 1}, "createdAt": day(created), "modifiedAt": day(modified),
        });
        record(&vault, "note", id, payload, false);
        filed(&vault, id, &format!("{id}.md"));
    }
    // Pinned by their records, `e` later than `f`; the pin reads from `pinnedTags`.
    for (id, title, now) in [("e", "Elder", 7), ("f", "Fig", 3)] {
        let pinned = json!({
            "title": title, "tags": ["project"], "pinnedTags": ["project"], "clock": {"peer": 2},
        });
        record_at(&vault, "note", id, pinned, false, now);
    }

    let by = |descendants, sort, ascending| {
        ids(&search
            .tagged_notes("PROJECT", descendants, sort, ascending)
            .expect("tagged")
            .notes)
        .into_iter()
        .map(str::to_owned)
        .collect::<Vec<_>>()
    };
    assert_eq!(by(false, NoteSort::Modified, false), ["f", "e", "a", "d"]);
    assert_eq!(by(false, NoteSort::Modified, true), ["f", "e", "d", "a"]);
    assert_eq!(by(true, NoteSort::Title, true), ["f", "e", "b", "a", "d"]);
    assert_eq!(by(true, NoteSort::Title, false), ["f", "e", "d", "a", "b"]);
    assert_eq!(by(true, NoteSort::Created, true), ["f", "e", "a", "d", "b"]);
    assert_eq!(
        by(true, NoteSort::Created, false),
        ["f", "e", "b", "d", "a"]
    );
    let listed = search
        .tagged_notes("project", false, NoteSort::Title, true)
        .expect("tagged")
        .notes;
    let pins: Vec<Option<i64>> = listed.iter().map(|note| note.pinned_at).collect();
    assert_eq!(pins, [Some(3), Some(7), None, None]);
    assert_eq!(listed[2].emoji.as_deref(), Some("📚"));
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

/// An edit outside the app reaches the file and the index, never the record: once the index
/// measured the bytes on disk now, the file's header stands for the record's tags, so a tag
/// removed there stops counting. A note or day the index has not caught up with keeps the
/// record's.
#[test]
fn a_current_files_header_stands_for_the_records_tags() {
    let (_dir, vault, search) = open();
    // The record still pins `Keep` and carries `gone`; the file now has `keep` alone.
    let payload = json!({
        "title": "Plan", "tags": ["gone", "Keep"], "pinnedTags": ["Keep"], "clock": {"peer": 1},
    });
    record_at(&vault, "note", "plan", payload, false, 5);
    filed_as(&vault, "plan", "Plan.md", Some("hash-plan"));
    measured(&search, "plan", "---\ntags: [keep]\n---\nBody\n");
    let day = json!({"date": "2026-01-05", "tags": ["gone"], "clock": {"peer": 1}});
    record(&vault, "journal", "day", day, false);
    filed_as(&vault, "day", "journal/2026-01-05.md", Some("hash-day"));
    measured(&search, "day", "Nothing\n");

    assert_eq!(counted(&search), vec![pair("keep", 1)]);
    let gone = search.tagged_notes("gone", false, NoteSort::Title, true);
    assert!(gone.expect("tagged").notes.is_empty());
    let keep = search
        .tagged_notes("KEEP", false, NoteSort::Title, true)
        .expect("tagged")
        .notes;
    assert_eq!(keep[0].tags, ["keep"]);
    assert_eq!(
        keep[0].pinned_at,
        Some(5),
        "the record's pin, matched by fold"
    );

    // The bytes changed again and the index has not measured them yet.
    filed_as(&vault, "plan", "Plan.md", Some("hash-newer"));
    filed_as(&vault, "day", "journal/2026-01-05.md", None);
    assert_eq!(counted(&search), vec![pair("gone", 2), pair("Keep", 1)]);
}
