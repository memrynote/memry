//! An edit of a note's or a day's file made outside the app reaches its record (#3530 13k-4c),
//! over a real session, tier, watcher and index task: the keys the edit set or dropped, measured
//! against the index's last reading of the file, and no other.
//!
//! | Test                                                        | Rule                                  |
//! | ----------------------------------------------------------- | ------------------------------------- |
//! | an outside edit reaches the record and keeps a pulled value | only the keys the file changed        |
//! | a note made outside takes its file's properties             | `syncNoteCreate` sends them           |
//! | a value removed outside stays removed through a full apply  | the #3900 input                       |
//! | an outside edit of a day's property reaches the chart       | the #3914 input                       |
//! | an app edit is not mirrored again over a later pull         | the app's write mirrored it already   |
//! | a broken frontmatter drops nothing from the record          | it says nothing of the values         |
//! | an index from before the rows were filled mirrors nothing   | no last reading to measure against    |

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::index_support;
#[allow(unused_imports)]
use crate::vault_env;

use std::sync::Arc;

use index_support::until;
use memry_core::seams::secure_store::SecureStore;
use memry_desktop::notes::apply_template::{ApplyTemplateInput, TemplateMode};
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::index::NoteIndex;
use memry_desktop::notes::service::NotesService;
use memry_desktop::templates::{TemplateCreateInput, Templates};
use memry_desktop::vault::hash::content_hash;
use serde_json::{Map, Value, json};
use vault_env::{Env, env, indexed};

const PLAN: &str = "---\nstage: Draft\nrating: 5\n---\n# Plan\n";

struct Fixture {
    e: Env,
    store: Arc<dyn SecureStore>,
    notes: Arc<NotesService>,
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
fn an_index_from_before_the_rows_were_filled_mirrors_nothing() {
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
