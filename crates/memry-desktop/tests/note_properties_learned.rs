//! A property the note index reads with no definition gets one of the type it was first read
//! with (#3530 13k-4c, Electron's `learnCanonicalPropertyType`), over a real session, tier,
//! watcher and index task.
//!
//! | Test                                                     | Rule                                  |
//! | -------------------------------------------------------- | ------------------------------------- |
//! | a signed-in read learns a type once, later values follow | first seen becomes a synced definition |
//! | a signed-out device learns no type                       | no sync seeds an unclocked row        |
//! | a defined name keeps its definition, `project` its type  | only a missing definition is learned  |
//! | learning over a definition that landed meanwhile keeps it | `!existing` in the service's turn     |

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
fn opened(files: &[(&str, &str)], signed_in: bool) -> Fixture {
    let mut kept: Option<Arc<dyn SecureStore>> = None;
    let mut e = env(|store| {
        kept = Some(store.clone());
        Some(NotesIdentity::new(store))
    });
    let store = kept.expect("the store");
    if signed_in {
        device_key::sign_in(store.as_ref());
    }
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

#[test]
fn a_signed_in_read_learns_a_type_once_and_later_values_follow_it() {
    let f = opened(&[("Old.md", "---\nrating: high\n---\n")], false);
    assert_eq!(f.row_type("Old.md", "rating").as_deref(), Some("text"));
    device_key::sign_in(f.store.as_ref());

    f.e.write("Plan.md", "---\nrating: 5\n---\n# Plan\n");
    until("the first type seen is a definition", || {
        f.definition("rating")
            .is_some_and(|d| d.type_name == DefinitionType::Number && !d.created_at.is_empty())
    });
    // A note read before the definition takes its type.
    until("the older note's row retyped", || {
        f.row_type("Old.md", "rating").as_deref() == Some("number")
    });

    let file = f.properties_file();
    f.e.write("Later.md", "---\nrating: soon\n---\n");
    until("the later note read", || {
        f.row_type("Later.md", "rating").as_deref() == Some("number")
    });
    assert_eq!(f.properties_file(), file);
    assert_eq!(f.definitions().len(), 1);
}

#[test]
fn a_signed_out_device_learns_no_type() {
    let f = opened(&[("Plan.md", "---\nrating: 5\n---\n")], false);
    assert_eq!(f.row_type("Plan.md", "rating").as_deref(), Some("number"));
    assert!(f.definitions().is_empty());
    assert_eq!(f.properties_file(), None);
}

const DEFINITIONS: &str = "---\nproperties:\n  stage:\n    type: select\n    options:\n      - value: Draft\n        color: sky\n  project:\n    type: text\n    color: red\n---\n";

#[test]
fn a_defined_name_keeps_its_definition_and_project_takes_its_own_type() {
    let note = "---\nstage: Done\nproject: [Memry]\nlinks: [\"memry://note/abc\"]\nsite: https://example.com\n---\n";
    let f = opened(
        &[(".memry/properties.md", DEFINITIONS), ("Plan.md", note)],
        true,
    );
    until("the new property learned", || {
        f.definition("site").is_some()
    });
    let stage = f.definition("stage").unwrap();
    assert_eq!(stage.type_name, DefinitionType::Select);
    assert!(stage.options.unwrap().contains("Draft"));
    let project = f.definition("project").unwrap();
    assert_eq!(project.type_name, DefinitionType::Project);
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
