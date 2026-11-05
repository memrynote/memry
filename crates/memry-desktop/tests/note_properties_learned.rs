//! A property the note index reads with no definition gets one of the type it was first read
//! with (#3530 13k-4c-2, Electron's `learnCanonicalPropertyType`), over a real session, tier,
//! watcher and index task.
//!
//! | Test                                                      | Rule                                  |
//! | --------------------------------------------------------- | ------------------------------------- |
//! | a read learns a type once, and later values follow it     | the first type seen is a definition   |
//! | a day's title follows the type a note's title learned     | the 13q-9 journal `title` diff        |
//! | a defined name keeps its definition, `project` its type   | only a missing definition is learned  |
//! | learning over a definition that landed meanwhile keeps it | `!existing` in the service's turn     |
//! | a `project` learned over another type keeps its options   | `options: existing?.options`          |
//! | a name this build cannot read the definition of stays     | a newer build's definition is kept    |

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::index_support;
#[allow(unused_imports)]
use crate::vault_env;

use std::sync::Arc;

use index_support::until;
use memry_core::seams::secure_store::SecureStore;
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::index::NoteIndex;
use memry_desktop::notes::property_definitions::{
    DefinitionType, PropertyDefinitionView, PropertyDefinitions,
};
use vault_env::{Env, env, indexed};

struct Fixture {
    e: Env,
    store: Arc<dyn SecureStore>,
}

/// A vault holding `files`, opened with its index running, every file read once.
fn opened(files: &[(&str, &str)]) -> Fixture {
    let mut kept: Option<Arc<dyn SecureStore>> = None;
    let mut e = env(|store| {
        kept = Some(store.clone());
        Some(NotesIdentity::new(store))
    });
    let store = kept.expect("the store");
    for (rel, text) in files {
        e.write(rel, text);
    }
    let index = NoteIndex::new(e.tier.clone(), |_| {}, |_| {}, |_| {});
    index.register(&e.session);
    e.open();
    e.facts_until(indexed);
    let f = Fixture { e, store };
    until("every file read", || index_support::all_indexed(&f.e));
    f
}

impl Fixture {
    fn definitions(&self) -> Vec<PropertyDefinitionView> {
        let open = self.e.session.current().unwrap();
        PropertyDefinitions::open(&open, self.store.clone())
            .unwrap()
            .list()
            .unwrap()
    }

    fn definition(&self, name: &str) -> Option<PropertyDefinitionView> {
        self.definitions().into_iter().find(|d| d.name == name)
    }

    /// The index's type of the note at `path`'s property `name`.
    fn row_type(&self, path: &str, name: &str) -> Option<String> {
        let (id, _) = self.e.rows().into_iter().find(|(_, p)| p == path)?;
        let search = self.e.session.current().unwrap().search;
        let rows = search.note_properties(&id).unwrap();
        rows.into_iter()
            .find(|row| row.name == name)
            .map(|row| row.type_name)
    }

    fn properties_file(&self) -> Option<String> {
        std::fs::read_to_string(self.e.vault.join(".memry/properties.md")).ok()
    }
}

/// The first file by path learns `rating`, and `Second.md`, read in the same pass by the
/// definitions as the pass found them, is retyped by the next.
#[test]
fn a_read_learns_a_type_once_and_later_values_follow_it() {
    let f = opened(&[
        ("First.md", "---\nrating: 5\n---\n"),
        (
            "Second.md",
            "---\nrating: high\n---\n# Second, the longer file\n",
        ),
    ]);
    until("the first type seen is a definition", || {
        f.definition("rating")
            .is_some_and(|d| d.type_name == DefinitionType::Number && !d.created_at.is_empty())
    });
    until("the note read in the same pass retyped", || {
        f.row_type("Second.md", "rating").as_deref() == Some("number")
    });

    let file = f.properties_file();
    assert!(file.as_deref().is_some_and(|file| file.contains("rating")));
    f.e.write("Later.md", "---\nrating: soon\n---\n");
    until("the later note read", || {
        f.row_type("Later.md", "rating").as_deref() == Some("number")
    });
    assert_eq!(f.properties_file(), file);
    assert_eq!(f.definitions().len(), 1);
}

/// A note's `title` is a property (Electron's `RESERVED_FRONTMATTER_KEYS` holds no `title`). The
/// day is the smaller file and is read first, but the note is first by path, as Electron's open
/// walk reaches it: the day's `title: '2026-11-05'` reads as text, not a date.
#[test]
fn a_days_title_follows_the_type_a_notes_title_learned() {
    let f = opened(&[
        (
            "Plan.md",
            "---\ntitle: Q3 Roadmap\n---\n# Q3 Roadmap, the longer file\n",
        ),
        ("journal/2026-11-05.md", "---\ntitle: '2026-11-05'\n---\n"),
    ]);
    until("the title learned", || {
        f.definition("title")
            .is_some_and(|d| d.type_name == DefinitionType::Text)
    });
    until("the day's title typed by it", || {
        f.row_type("journal/2026-11-05.md", "title").as_deref() == Some("text")
    });
}

const DEFINITIONS: &str = "---\nproperties:\n  stage:\n    type: select\n    options:\n      - value: Draft\n        color: sky\n  project:\n    type: text\n    color: red\n    options:\n      - value: Alpha\n        color: teal\n---\n";

#[test]
fn a_defined_name_keeps_its_definition_and_project_takes_its_own_type() {
    let note = "---\nstage: Done\nproject: [Memry]\nlinks: [\"memry://note/abc\"]\nsite: https://example.com\n---\n";
    let f = opened(&[(".memry/properties.md", DEFINITIONS), ("Plan.md", note)]);
    until("the new property learned", || {
        f.definition("site").is_some()
    });
    let stage = f.definition("stage").unwrap();
    assert_eq!(stage.type_name, DefinitionType::Select);
    assert!(stage.options.unwrap().contains("Draft"));
    until("project retyped", || {
        f.definition("project")
            .is_some_and(|d| d.type_name == DefinitionType::Project)
    });
    let project = f.definition("project").unwrap();
    assert_eq!(project.color.as_deref(), Some("red"));
    assert_eq!(f.definition("site").unwrap().type_name, DefinitionType::Url);
    assert!(f.definition("links").is_none());
}

/// A definition that landed after the pass read the definitions (the user's, or a pull's) is
/// not replaced by the type a note gives the name.
#[test]
fn learning_over_a_definition_that_landed_meanwhile_keeps_it() {
    let f = crate::property_definitions::fixture();
    f.set_file(DEFINITIONS);
    let file = f.file();
    assert!(!f.definitions.learn("stage", DefinitionType::Text).unwrap());
    assert_eq!(f.file(), file);
    assert!(f.definitions.learn("site", DefinitionType::Url).unwrap());
    assert!(!f.definitions.learn("site", DefinitionType::Text).unwrap());
    assert!(f.record("site").is_some());
}

/// The options a `project` held as another type stay on its record, as Electron's learner
/// passes `existing?.options`: the file's `project` holds none to keep them in.
#[test]
fn a_project_learned_over_another_type_keeps_its_options() {
    let f = crate::property_definitions::fixture();
    f.set_file(DEFINITIONS);
    assert!(
        f.definitions
            .learn("project", DefinitionType::Project)
            .unwrap()
    );
    let record = f.record("project").unwrap();
    assert_eq!(record.type_name, "project");
    assert_eq!(record.color.as_deref(), Some("red"));
    let options = record.options.unwrap_or_default();
    assert!(options.contains("Alpha"), "{options}");
}

/// A definition of a type a newer build added is a definition: no type is learned over it.
#[test]
fn a_name_this_build_cannot_read_the_definition_of_stays() {
    let f = crate::property_definitions::fixture();
    f.set_file("---\nproperties:\n  score:\n    type: formula\n    expression: rating * 2\n---\n");
    let file = f.file();
    assert!(
        !f.definitions
            .learn("score", DefinitionType::Number)
            .unwrap()
    );
    assert_eq!(f.file(), file);
    assert!(f.record("score").is_none());
}
