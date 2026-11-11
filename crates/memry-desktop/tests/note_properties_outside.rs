//! An edit of a note's or a day's file made outside the app reaches its record (#3530 13k-4c),
//! over a real session, tier, watcher and index task: the keys the edit set or dropped since the
//! record last took the file (its baseline, in `data.db`), and no other.
//!
//! | Test                                                        | Rule                                  |
//! | ----------------------------------------------------------- | ------------------------------------- |
//! | an outside edit reaches the record and keeps a pulled value | only the keys the file changed        |
//! | a note made outside takes its file's properties             | `syncNoteCreate` sends them           |
//! | a value removed outside stays removed through a full apply  | the #3900 input                       |
//! | an outside edit of a day's property reaches the chart       | the #3914 input                       |
//! | an app edit is not mirrored again over a later pull         | the app's write mirrored it already   |
//! | a broken frontmatter drops nothing from the record          | it says nothing of the values         |
//! | an index rebuilt from nothing leaves the record             | the baseline is not the index's       |
//! | an index that dropped a note's rows takes only its changes  | the baseline is not the index's       |
//! | a note with no baseline is measured by the index's reading  | an older build's note                 |
//! | a read before the tier takes an edit keeps the index's reading | the index reads the tier's bytes   |
//! | a broken frontmatter then fixed reaches the record          | the baseline is the last good reading |
//! | an app write after an outside edit does not hide it         | the edit is taken at fact time        |
//! | a save over an outside edit not fed yet does not hide it    | the save takes the edit first         |
//! | a save the feed does not take is not an outside edit later  | the run's own bytes carry the record  |
//! | a link rewrite in a frontmatter value reaches the record    | the rewrite mirrors it in its turn    |
//! | a found folder's notes take their files' properties         | a found file fills its record         |
//! | a day made outside takes no reserved journal key            | `RESERVED_JOURNAL_KEYS`               |

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::index_support;
#[allow(unused_imports)]
use crate::vault_env;

use std::sync::Arc;

use index_support::until;
use memry_core::seams::secure_store::SecureStore;
use memry_desktop::journal::update::{DayUpdate, InlineTags};
use memry_desktop::notes::apply_template::{ApplyTemplateInput, TemplateMode};
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::index::NoteIndex;
use memry_desktop::notes::links::NoteLinks;
use memry_desktop::notes::service::NotesService;
use memry_desktop::notes::update::NoteUpdateInput;
use memry_desktop::templates::{TemplateCreateInput, Templates};
use memry_desktop::vault::hash::content_hash;
use serde_json::{Map, Value, json};
use vault_env::{Env, env, indexed};

const PLAN: &str = "---\nstage: Draft\nrating: 5\n---\n# Plan\n";

struct Fixture {
    e: Env,
    store: Arc<dyn SecureStore>,
    notes: Arc<NotesService>,
    index: Arc<NoteIndex>,
    id: String,
}

/// A vault holding `files`, opened with its index running, every file read once.
fn opened(files: &[(&str, &str)], path: &str) -> Fixture {
    let mut kept: Option<Arc<dyn SecureStore>> = None;
    let mut e = env(|store| {
        kept = Some(store.clone());
        Some(NotesIdentity::new(store))
    });
    for (rel, text) in files {
        e.write(rel, text);
    }
    let index = NoteIndex::new(e.tier.clone(), |_| {}, |_| {}, |_| {});
    index.register(&e.session);
    e.open();
    e.facts_until(indexed);
    let store = kept.expect("the store");
    let notes = NotesService::new(e.tier.clone(), store.clone());
    let id = e
        .rows()
        .into_iter()
        .find(|(_, p)| p == path)
        .unwrap_or_else(|| panic!("no row at {path}"))
        .0;
    let f = Fixture {
        e,
        store,
        notes,
        index,
        id,
    };
    until("every file read", || index_support::all_indexed(&f.e));
    f
}

impl Fixture {
    /// The record's property values.
    fn record(&self) -> Map<String, Value> {
        let files = self.e.core().note_files();
        files.listed_by_id(&self.id).unwrap().unwrap().properties
    }

    /// Sets the record's `name`, leaving the file: as a pull does, or as the record of a file
    /// the index read already holds it.
    fn set(&self, name: &str, json: &str) {
        let writer = self.e.core().notes_writer(self.store.clone()).unwrap();
        writer
            .set_property(self.id.clone(), name.into(), json.into())
            .unwrap();
    }

    /// Writes `path` outside the app and waits until the index read it.
    fn outside(&self, path: &str, text: &str) {
        self.e.write(path, text);
        let search = self.e.session.current().unwrap().search;
        until("the outside edit read", || {
            search
                .note_stats(&self.id)
                .unwrap()
                .and_then(|stored| stored.file_hash)
                == Some(content_hash(text))
        });
    }
}

fn object(value: Value) -> Map<String, Value> {
    value.as_object().expect("an object").clone()
}

#[test]
fn an_outside_edit_reaches_the_record_and_keeps_a_pulled_value() {
    let f = opened(&[("Plan.md", PLAN)], "Plan.md");
    // The record holds what the file holds, and a value a pull brought in.
    f.set("stage", "\"Draft\"");
    f.set("rating", "5");
    f.set("mood", "\"great\"");

    f.outside("Plan.md", "---\nrating: 6\nowner: Kaan\n---\n# Plan\n");
    let want = json!({ "rating": 6, "mood": "great", "owner": "Kaan" });
    assert_eq!(f.record(), object(want));
}

#[test]
fn a_note_made_outside_takes_its_files_properties() {
    let f = opened(&[("Plan.md", PLAN)], "Plan.md");
    f.e.write("Other.md", "---\nowner: Kaan\n---\n# Other\n");
    let core = f.e.core();
    until("the new note's record holds its properties", || {
        let id = f.e.rows().into_iter().find(|(_, p)| p == "Other.md");
        id.and_then(|(id, _)| core.note_files().listed_by_id(&id).unwrap())
            .is_some_and(|listed| listed.properties == object(json!({ "owner": "Kaan" })))
    });
}

#[test]
fn a_value_removed_outside_stays_removed_through_a_full_apply() {
    let mut f = opened(&[("Plan.md", PLAN)], "Plan.md");
    let open = f.e.session.current().unwrap();
    f.set("stage", "\"Draft\"");
    f.outside("Plan.md", "---\nrating: 5\n---\n# Plan\n");
    let template = Templates::open(&open, f.store.clone())
        .unwrap()
        .create(
            &TemplateCreateInput {
                name: "Brief".into(),
                content: "Brief body".into(),
                ..TemplateCreateInput::default()
            },
            1_760_000_000_000,
        )
        .unwrap()
        .id;
    let input = ApplyTemplateInput {
        note_id: f.id.clone(),
        template_id: template,
        mode: TemplateMode::Full,
    };
    f.notes.apply_template(&open, input).unwrap();
    let text = f.e.read("Plan.md");
    assert!(!text.contains("stage"), "{text}");
    drop(open);
    f.e.close();
}

#[test]
fn an_outside_edit_of_a_days_property_reaches_the_chart() {
    let day = "journal/2025-03-01.md";
    let f = opened(&[(day, "---\nmood: 3\n---\nA day\n")], day);
    let open = f.e.session.current().unwrap();
    let journal = open.vault.journal(f.store.clone()).unwrap();
    journal
        .set_property("2025-03-01".into(), "mood".into(), "3".into())
        .unwrap();
    f.outside(day, "---\nmood: 4\n---\nA day\n");
    let read = f
        .notes
        .journal_property_rows(&open, "2025-03-01", "2025-03-31")
        .unwrap();
    let mood = read.rows.first().and_then(|row| row.properties.get("mood"));
    assert_eq!(mood, Some(&json!(4)));
    drop(open);
}

#[test]
fn an_app_edit_is_not_mirrored_again_over_a_later_pull() {
    let f = opened(&[("Plan.md", PLAN)], "Plan.md");
    let open = f.e.session.current().unwrap();
    let edit = object(json!({ "rating": 6 }));
    f.notes.merge_properties(&open, &f.id, edit).unwrap();
    // A pull lands before the index reads the app's write.
    f.set("rating", "9");
    let text = "---\nstage: Draft\nrating: 6\n---\n# Plan\n";
    assert_eq!(f.e.read("Plan.md"), text);
    let search = open.search.clone();
    until("the app's write read", || {
        let stored = search.note_stats(&f.id).unwrap();
        stored.and_then(|stored| stored.file_hash) == Some(content_hash(text))
    });
    assert_eq!(f.record().get("rating"), Some(&json!(9)));
    drop((search, open));
}

#[test]
fn a_broken_frontmatter_drops_nothing_from_the_record() {
    let f = opened(&[("Plan.md", PLAN)], "Plan.md");
    f.set("stage", "\"Draft\"");
    f.set("rating", "5");
    f.outside("Plan.md", "---\nrating: [\n---\n# Plan\n");
    assert_eq!(f.record(), object(json!({ "stage": "Draft", "rating": 5 })));
}

#[test]
fn an_index_rebuilt_from_nothing_leaves_the_record() {
    let mut f = opened(&[("Plan.md", PLAN)], "Plan.md");
    // Pulled, not in the file yet: the file's `Draft` is older.
    f.set("stage", "\"Review\"");
    f.e.close();
    rusqlite::Connection::open(f.e.vault.join(".memry/core/index.db"))
        .unwrap()
        .execute_batch(
            "DELETE FROM note_properties;
             DELETE FROM index_meta WHERE key = 'note_properties.typed_with';",
        )
        .unwrap();
    f.e.open();
    until("every file read again", || {
        let search = f.e.session.current().unwrap().search;
        index_support::all_indexed(&f.e) && search.properties_typed_with().unwrap().is_some()
    });
    assert_eq!(f.record().get("stage"), Some(&json!("Review")));
    f.e.close();
}

#[test]
fn an_index_that_dropped_a_notes_rows_still_takes_only_what_the_file_changed() {
    let f = opened(&[("Plan.md", PLAN)], "Plan.md");
    // Pulled, not in the file yet: the file's `Draft` is older.
    f.set("stage", "\"Review\"");
    f.set("rating", "5");
    // Linked: the index refuses to read it and drops its rows.
    let link = f.e._dir.path().join("linked.md");
    std::fs::hard_link(f.e.vault.join("Plan.md"), &link).unwrap();
    assert_eq!(f.index.reindex(|_| {}).unwrap().unread, 1);
    let search = f.e.session.current().unwrap().search;
    assert!(search.note_properties(&f.id).unwrap().is_empty());
    std::fs::remove_file(&link).unwrap();

    f.outside(
        "Plan.md",
        "---\nstage: Draft\nrating: 6\nowner: Kaan\n---\n# Plan\n",
    );
    let want = json!({ "stage": "Review", "rating": 6, "owner": "Kaan" });
    assert_eq!(f.record(), object(want));
}

#[test]
fn a_broken_frontmatter_then_fixed_reaches_the_record() {
    let f = opened(&[("Plan.md", PLAN)], "Plan.md");
    f.set("stage", "\"Draft\"");
    f.set("rating", "5");
    // Half typed, as an editor autosaves it: an unclosed quote.
    f.outside("Plan.md", "---\nstage: \"Do\nrating: 5\n---\n# Plan\n");
    f.outside("Plan.md", "---\nstage: Done\nrating: 5\n---\n# Plan\n");
    assert_eq!(f.record(), object(json!({ "stage": "Done", "rating": 5 })));
}

#[test]
fn an_app_write_after_an_outside_edit_does_not_hide_it() {
    let f = opened(&[("Plan.md", PLAN)], "Plan.md");
    f.set("stage", "\"Draft\"");
    f.set("rating", "5");
    let open = f.e.session.current().unwrap();
    f.e.write("Plan.md", "---\nstage: Done\nrating: 5\n---\n# Plan\n");
    std::thread::sleep(std::time::Duration::from_millis(250));
    // Refused while the outside edit is not fed yet; the user tries again.
    until("the app's edit landed", || {
        let edit = object(json!({ "rating": 6 }));
        f.notes.merge_properties(&open, &f.id, edit).is_ok()
    });
    let text = "---\nstage: Done\nrating: 6\n---\n# Plan\n";
    assert_eq!(f.e.read("Plan.md"), text);
    let search = open.search.clone();
    until("the app's write read", || {
        let stored = search.note_stats(&f.id).unwrap();
        stored.and_then(|stored| stored.file_hash) == Some(content_hash(text))
    });
    assert_eq!(f.record(), object(json!({ "stage": "Done", "rating": 6 })));
    drop((search, open));
}

#[test]
fn a_found_folders_notes_take_their_files_properties() {
    // Alone, and together: the open walk creates the notes of many new files at once.
    let alone = opened(&[("Plan.md", PLAN)], "Plan.md");
    assert_eq!(
        alone.record(),
        object(json!({ "stage": "Draft", "rating": 5 }))
    );
    let other = "---\nowner: Kaan\n---\n# Other\n";
    let together = opened(&[("Plan.md", PLAN), ("Other.md", other)], "Plan.md");
    assert_eq!(
        together.record(),
        object(json!({ "stage": "Draft", "rating": 5 }))
    );
}

#[test]
fn a_day_made_outside_takes_no_reserved_journal_key() {
    let f = opened(&[("Plan.md", PLAN)], "Plan.md");
    let day = "journal/2025-03-02.md";
    f.e.write(
        day,
        "---\nid: j2025-03-02\ncreated: 2025-03-02T08:00:00Z\nmodified: 2025-03-02T09:00:00Z\nemoji: x\nmood: 2\n---\nA day\n",
    );
    let open = f.e.session.current().unwrap();
    let day_properties = || {
        let read = f
            .notes
            .journal_property_rows(&open, "2025-03-01", "2025-03-31");
        let rows = read.unwrap().rows;
        rows.into_iter()
            .find(|row| row.date == "2025-03-02")
            .map(|row| row.properties)
            .unwrap_or_default()
    };
    until("the day's record holds its mood", || {
        !day_properties().is_empty()
    });
    assert_eq!(day_properties(), object(json!({ "mood": 2 })));
}

/// A note of an older build, which kept no baseline, with a pulled `stage` not in its file yet.
fn with_no_baseline() -> Fixture {
    let f = opened(&[("Plan.md", PLAN)], "Plan.md");
    // Pulled, not in the file yet: the file's `Draft` is older.
    f.set("stage", "\"Review\"");
    rusqlite::Connection::open(f.e.vault.join(".memry/core/data.db"))
        .unwrap()
        .execute(
            "DELETE FROM meta WHERE key LIKE 'note.file_properties:%'",
            [],
        )
        .unwrap();
    f
}

#[test]
fn a_note_with_no_baseline_is_measured_against_the_index_reading() {
    let f = with_no_baseline();
    f.outside("Plan.md", "---\nstage: Draft\nrating: 6\n---\n# Plan\n");
    assert_eq!(
        f.record(),
        object(json!({ "stage": "Review", "rating": 6 }))
    );
}

/// The index reads the file again before the tier took the outside edit (a pass retyping a
/// learned type, or an app write's measure): its reading stays the one of the file the record
/// took, which the edit is measured against.
#[test]
fn a_read_before_the_tier_takes_an_outside_edit_keeps_the_index_reading() {
    let f = with_no_baseline();
    let text = "---\nstage: Draft\nrating: 6\n---\n# Plan\n";
    f.e.write("Plan.md", text);
    f.index.measure(&f.id).unwrap();
    let files = f.e.core().note_files();
    until("the tier took the outside edit", || {
        let row = files.by_id(&f.id).unwrap().unwrap();
        row.content_hash == Some(content_hash(text))
    });
    assert_eq!(
        f.record(),
        object(json!({ "stage": "Review", "rating": 6 }))
    );
}

/// The editor's save replaces whatever is there, the outside edit's frontmatter kept.
#[test]
fn a_save_over_an_outside_edit_not_fed_yet_does_not_hide_it() {
    let f = opened(&[("Plan.md", PLAN)], "Plan.md");
    let open = f.e.session.current().unwrap();
    f.e.write("Plan.md", "---\nstage: Done\nrating: 5\n---\n# Plan\n");
    let save = NoteUpdateInput {
        id: f.id.clone(),
        content: Some("# Plan\n\nTyped.".into()),
        ..NoteUpdateInput::default()
    };
    f.notes.update(&open, save).unwrap();
    assert!(f.e.read("Plan.md").contains("stage: Done"));
    assert_eq!(f.record(), object(json!({ "stage": "Done", "rating": 5 })));

    let day = "journal/2025-03-01.md";
    f.e.write(day, "---\ntags: [a]\nmood: 3\n---\nA day\n");
    let read = || {
        f.notes
            .journal_property_rows(&open, "2025-03-01", "2025-03-31")
            .unwrap()
    };
    until("the day's record and row", || {
        !read().rows.is_empty() && f.e.rows().iter().any(|(_, path)| path == day)
    });
    f.e.write(day, "---\ntags: [a, b]\nmood: 4\n---\nA day\n");
    // An inline tag typed in the same save goes over the outside edit's tags, not the record's
    // from before it.
    let update = DayUpdate {
        date: "2025-03-01".into(),
        content: Some("Typed.".into()),
        tags: None,
        inline_tags: Some(InlineTags {
            add: vec!["c".into()],
            remove: Vec::new(),
        }),
        properties: None,
    };
    f.notes.update_day(&open, update).unwrap();
    let mood = read()
        .rows
        .first()
        .and_then(|row| row.properties.get("mood").cloned());
    assert_eq!(mood, Some(json!(4)));
    let journal = open.vault.journal(f.store.clone()).unwrap();
    let tags = journal.stamp("2025-03-01").unwrap().unwrap().tags;
    assert_eq!(tags, ["a", "b", "c"]);
    drop(open);
}

/// A save of a block over the feed's size leaves the document and the row on the file before
/// it; the next save finds the run's own bytes there, which carry the record already, and must
/// not give it the file's tags back over a pulled change.
#[test]
fn a_save_the_feed_does_not_take_is_not_an_outside_edit_later() {
    let f = opened(&[("Plan.md", "---\ntags: [a]\n---\n# Plan\n")], "Plan.md");
    let open = f.e.session.current().unwrap();
    let save = |body: String| {
        let input = NoteUpdateInput {
            id: f.id.clone(),
            content: Some(body),
            ..NoteUpdateInput::default()
        };
        f.notes.update(&open, input).unwrap();
    };
    let block = "x".repeat(140 * 1024);
    save(format!("# Plan\n\n{block}\n"));
    let writer = f.e.core().notes_writer(f.store.clone()).unwrap();
    writer
        .set_tags(f.id.clone(), vec!["a".into(), "pulled".into()])
        .unwrap();
    save(format!("# Plan\n\n{block}\nTyped.\n"));
    let files = f.e.core().note_files();
    let tags = files.listed_by_id(&f.id).unwrap().unwrap().tags;
    assert_eq!(tags, ["a", "pulled"]);
    drop(open);
}

/// A rename rewrites `[[Plan]]` in another note's frontmatter value: the record takes it, and
/// the baseline moves with it, so an outside edit of another key leaves a pulled value.
#[test]
fn a_link_rewrite_in_a_frontmatter_value_reaches_the_record() {
    let ideas = "---\nrelated: \"[[Plan]]\"\nrating: 5\n---\nSee [[Plan]].\n";
    let f = opened(&[("Plan.md", PLAN), ("Ideas.md", ideas)], "Ideas.md");
    let open = f.e.session.current().unwrap();
    let rows = f.e.rows();
    let (plan, _) = rows.iter().find(|(_, p)| p == "Plan.md").unwrap();
    let links = NoteLinks::new(&open);
    until("the links indexed", || {
        !links.get(plan).unwrap().incoming.is_empty()
    });
    f.notes.rename(&open, plan, "Roadmap").unwrap();
    assert!(f.e.read("Ideas.md").contains("related: \"[[Roadmap]]\""));
    assert_eq!(f.record()["related"], json!("[[Roadmap]]"));

    f.set("related", "\"[[Pulled]]\"");
    let edited = "---\nrelated: \"[[Roadmap]]\"\nrating: 6\n---\nSee [[Roadmap]].\n";
    f.outside("Ideas.md", edited);
    until("the outside rating taken", || {
        f.record()["rating"] == json!(6)
    });
    assert_eq!(f.record()["related"], json!("[[Pulled]]"));
    drop(open);
}
