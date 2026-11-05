//! A property the note index reads with no definition types every later read by the type it was
//! first read with (#3530 13k-4c-2, Electron's `learnCanonicalPropertyType`), over a real
//! session, tier, watcher and index task. The learned type is this device's alone, as
//! Electron's unsynced row is: not a definition, so neither `properties.md`, nor a synced
//! record, nor the definitions list holds it.
//!
//! | Test                                                      | Rule                                   |
//! | --------------------------------------------------------- | -------------------------------------- |
//! | a read learns a type once, and later values follow it     | the first type read types the rest     |
//! | a day's title follows the type a note's title learned     | a note before a day (13q-9 diff)       |
//! | a defined name keeps its definition                       | only a name with none is learned       |
//! | a deleted definition stays deleted through a retype       | a retype learns nothing                |
//! | a note read only to retype it teaches nothing             | a retype learns nothing                |
//! | learning over a definition that landed meanwhile keeps it | the file and the records win           |
//! | a name this build cannot read the definition of stays     | a newer build's definition is kept     |

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::index_support;
#[allow(unused_imports)]
use crate::vault_env;

use std::collections::BTreeMap;
use std::sync::Arc;

use index_support::until;
use memry_core::seams::secure_store::SecureStore;
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::index::NoteIndex;
use memry_desktop::notes::property_definitions::{
    DefinitionInput, DefinitionType, PropertyDefinitionView, PropertyDefinitions,
};
use vault_env::{Env, env, indexed};

struct Fixture {
    e: Env,
    store: Arc<dyn SecureStore>,
    index: Arc<NoteIndex>,
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
    let f = Fixture { e, store, index };
    until("every file read", || index_support::all_indexed(&f.e));
    f
}

impl Fixture {
    fn service(&self) -> PropertyDefinitions {
        let open = self.e.session.current().unwrap();
        PropertyDefinitions::open(&open, self.store.clone()).unwrap()
    }

    fn definitions(&self) -> Vec<PropertyDefinitionView> {
        self.service().list().unwrap()
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

    /// The definitions the index last typed its rows with.
    fn typed_with(&self) -> Option<BTreeMap<String, String>> {
        let search = self.e.session.current().unwrap().search;
        search.properties_typed_with().unwrap()
    }

    fn properties_file(&self) -> Option<String> {
        std::fs::read_to_string(self.e.vault.join(".memry/properties.md")).ok()
    }

    /// No definition of `name` anywhere a user or another device sees one.
    fn undefined(&self, name: &str) {
        assert!(self.definition(name).is_none(), "{name} listed");
        let file = self.properties_file().unwrap_or_default();
        assert!(
            !file.contains(&format!("{name}:")),
            "{name} in the file:\n{file}"
        );
        let open = self.e.session.current().unwrap();
        let records = open.vault.property_definition_records(self.store.clone());
        let listed = records.unwrap().list().unwrap();
        assert!(
            listed.iter().all(|stored| stored.record.name != name),
            "{name} recorded"
        );
    }
}

/// The first file read learns `rating`, and `Second.md`, read in the same pass by the
/// definitions as the pass found them, is retyped by the next.
#[test]
fn a_read_learns_a_type_once_and_later_values_follow_it() {
    let f = opened(&[
        ("First.md", "---\nrating: 5\n---\n"),
        ("Second.md", "---\nrating: high\n---\n"),
    ]);
    until("the note read in the same pass retyped", || {
        f.row_type("Second.md", "rating").as_deref() == Some("number")
    });
    f.e.write("Later.md", "---\nrating: soon\n---\n");
    until("the later note read", || {
        f.row_type("Later.md", "rating").as_deref() == Some("number")
    });
    f.undefined("rating");
    assert_eq!(f.properties_file(), None);
}

/// A note's `title` is a property (Electron's `RESERVED_FRONTMATTER_KEYS` holds no `title`). A
/// day's file is the smaller and its folder sorts first, but a day is read after every note: the
/// day's `title: '2026-11-05'` reads as text, not a date.
#[test]
fn a_days_title_follows_the_type_a_notes_title_learned() {
    let f = opened(&[
        (
            "notes/plan.md",
            "---\ntitle: Q3 Roadmap\n---\n# Q3 Roadmap, the longer file\n",
        ),
        ("journal/2026-11-05.md", "---\ntitle: '2026-11-05'\n---\n"),
    ]);
    until("the day's title typed as the note's", || {
        f.row_type("journal/2026-11-05.md", "title").as_deref() == Some("text")
    });
    assert_eq!(
        f.row_type("notes/plan.md", "title").as_deref(),
        Some("text")
    );
    f.undefined("title");
}

const DEFINITIONS: &str = "---\nproperties:\n  stage:\n    type: select\n    options:\n      - value: Draft\n        color: sky\n  project:\n    type: text\n    color: red\n---\n";

#[test]
fn a_defined_name_keeps_its_definition() {
    let note = "---\nstage: Done\nproject: [Memry]\nlinks: [\"memry://note/abc\"]\nsite: https://example.com\n---\n";
    let f = opened(&[(".memry/properties.md", DEFINITIONS), ("Plan.md", note)]);
    until("the new property learned", || {
        f.typed_with()
            .is_some_and(|typed| typed.contains_key("site"))
    });
    assert_eq!(f.row_type("Plan.md", "site").as_deref(), Some("url"));
    assert_eq!(f.row_type("Plan.md", "project").as_deref(), Some("project"));
    assert_eq!(f.row_type("Plan.md", "links").as_deref(), Some("relation"));
    assert_eq!(f.properties_file().as_deref(), Some(DEFINITIONS));
    let names: Vec<String> = f.definitions().into_iter().map(|d| d.name).collect();
    assert_eq!(names, ["project", "stage"]);
}

/// A definition the user deleted while notes hold the name stays deleted: the retype its delete
/// asks for reads those notes again and learns nothing from them (Electron's
/// `retypeIndexedProperties` learns nothing).
#[test]
fn a_deleted_definition_stays_deleted_through_a_retype() {
    let f = opened(&[("Plan.md", "---\nrating: 5\n---\n")]);
    let input = DefinitionInput {
        name: "rating".into(),
        type_name: Some(DefinitionType::Text),
        options: None,
        default_value: None,
        color: None,
    };
    f.service().create(input).unwrap();
    f.index.retype();
    until("the rows typed by the definition", || {
        f.row_type("Plan.md", "rating").as_deref() == Some("text")
    });
    f.service().delete("rating").unwrap();
    f.index.retype();
    until("the retype after the delete", || {
        f.typed_with()
            .is_some_and(|typed| !typed.contains_key("rating"))
    });
    f.undefined("rating");
    assert_eq!(f.row_type("Plan.md", "rating").as_deref(), Some("number"));
}

/// An index an older build typed, which learned nothing (or a learned map lost): a definition
/// of `mood`, which only the day holds, retypes only the day, and its `title: '2026-11-05'` is
/// not learned as a date, though no type is learned for `title` yet.
#[test]
fn a_note_read_only_to_retype_it_teaches_nothing() {
    let f = opened(&[
        (
            "notes/plan.md",
            "---\ntitle: Q3 Roadmap\n---\n# Q3 Roadmap, the longer file\n",
        ),
        (
            "journal/2026-11-05.md",
            "---\ntitle: '2026-11-05'\nmood: 3\n---\n",
        ),
    ]);
    until("the names learned", || {
        f.typed_with()
            .is_some_and(|typed| typed.contains_key("title") && typed.contains_key("mood"))
    });
    let data = rusqlite::Connection::open(f.e.vault.join(".memry/core/data.db")).unwrap();
    data.execute(
        "DELETE FROM meta WHERE key = 'property_definitions.learned'",
        [],
    )
    .unwrap();
    let search = f.e.session.current().unwrap().search;
    let mut older = f.typed_with().unwrap();
    older.remove("title");
    older.remove("mood");
    search.set_properties_typed_with(older).unwrap();
    let input = DefinitionInput {
        name: "mood".into(),
        type_name: Some(DefinitionType::Text),
        options: None,
        default_value: None,
        color: None,
    };
    f.service().create(input).unwrap();
    f.index.retype();
    until("the day retyped", || {
        f.row_type("journal/2026-11-05.md", "mood").as_deref() == Some("text")
            && f.typed_with()
                .is_some_and(|typed| typed.contains_key("mood"))
    });
    let open = f.e.session.current().unwrap();
    let records = open.vault.property_definition_records(f.store.clone());
    let learned = records.unwrap().learned().unwrap();
    assert!(!learned.contains_key("title"), "learned {learned:?}");
    f.undefined("title");
}

/// A definition that landed after the pass read the definitions (the user's, or a pull's) is
/// not replaced by the type a note gives the name.
#[test]
fn learning_over_a_definition_that_landed_meanwhile_keeps_it() {
    let f = crate::property_definitions::fixture();
    f.set_file(DEFINITIONS);
    let file = f.file();
    let wanted = |pairs: &[(&str, DefinitionType)]| {
        pairs
            .iter()
            .map(|(name, wanted)| ((*name).to_owned(), *wanted))
            .collect::<BTreeMap<_, _>>()
    };
    let learned = f.definitions.learn(wanted(&[
        ("stage", DefinitionType::Text),
        ("site", DefinitionType::Url),
    ]));
    assert!(learned.unwrap());
    assert!(
        !f.definitions
            .learn(wanted(&[("site", DefinitionType::Text)]))
            .unwrap()
    );
    assert_eq!(f.file(), file);
    assert!(f.record("site").is_none());
    let learned = f.records.learned().unwrap();
    assert_eq!(learned, BTreeMap::from([("site".into(), "url".into())]));
    let types = f.definitions.types().unwrap();
    assert_eq!(types.get("stage").map(String::as_str), Some("select"));
    assert_eq!(types.get("site").map(String::as_str), Some("url"));
}

/// A definition of a type a newer build added is a definition: no type is learned over it.
#[test]
fn a_name_this_build_cannot_read_the_definition_of_stays() {
    let f = crate::property_definitions::fixture();
    f.set_file("---\nproperties:\n  score:\n    type: formula\n    expression: rating * 2\n---\n");
    let file = f.file();
    let wanted = BTreeMap::from([("score".to_owned(), DefinitionType::Number)]);
    assert!(!f.definitions.learn(wanted).unwrap());
    assert_eq!(f.file(), file);
    assert!(f.records.learned().unwrap().is_empty());
    assert!(!f.definitions.types().unwrap().contains_key("score"));
}
