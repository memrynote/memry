//! A property the note index reads with no definition types every later read by the type the
//! pass read it with (#3530 13k-4c-2, Electron's `learnCanonicalPropertyType`), over a real
//! session, tier, watcher and index task. The learned type is written into `properties.md`, as
//! Electron's reload folds its unsynced rows in (2b3a512960), and has no synced record until a
//! sync pass seeds it.
//!
//! | Test                                                      | Rule                                   |
//! | --------------------------------------------------------- | -------------------------------------- |
//! | a read learns a type once, and later values follow it     | the first type read types the rest     |
//! | values a learned type cannot show settle it on text       | `settleLearnedTypes`                   |
//! | a type the user chose never settles                       | only a learned type settles            |
//! | learned definitions are in the file after a reopen        | the fold into `properties.md`          |
//! | types an older build learned reach the file on a list     | the fold of what `meta` still holds    |
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

    /// `name`'s definition in the file and the list, of `type_name`, with no synced record.
    fn learned_into_the_file(&self, name: &str, type_name: &str) {
        let listed = self
            .definition(name)
            .unwrap_or_else(|| panic!("{name} not listed"));
        assert_eq!(serde_json::to_value(listed.type_name).unwrap(), type_name);
        let file = self.properties_file().unwrap_or_default();
        assert!(
            file.contains(&format!("  {name}:\n    type: {type_name}\n")),
            "{name} not in the file:\n{file}"
        );
        let open = self.e.session.current().unwrap();
        let records = open.vault.property_definition_records(self.store.clone());
        let records = records.unwrap();
        assert!(
            records
                .list()
                .unwrap()
                .iter()
                .all(|stored| stored.record.name != name)
        );
        assert!(
            !records.learned().unwrap().contains_key(name),
            "{name} still learned"
        );
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
/// definitions as the pass found them, is retyped by the next. A note a later pass reads keeps
/// the type: only what one pass read settles it.
#[test]
fn a_read_learns_a_type_once_and_later_values_follow_it() {
    let f = opened(&[
        ("First.md", "---\nrating: 5\n---\n"),
        ("Second.md", "---\nrating: '7'\n---\n"),
    ]);
    until("the note read in the same pass retyped", || {
        f.row_type("Second.md", "rating").as_deref() == Some("number")
    });
    f.e.write("Later.md", "---\nrating: soon\n---\n");
    until("the later note read", || {
        f.row_type("Later.md", "rating").as_deref() == Some("number")
    });
    f.learned_into_the_file("rating", "number");
}

/// 2b3a512960: with `rating: 5` in one note and `rating: good` in another, the type was the
/// first file's, and `good` could not show under it. A learned type some value does not fit
/// settles on text.
#[test]
fn values_a_learned_type_cannot_show_settle_it_on_text() {
    let f = opened(&[
        ("First.md", "---\nrating: 5\n---\n"),
        ("Second.md", "---\nrating: good\n---\n"),
    ]);
    until("the rows typed by the settled type", || {
        f.row_type("First.md", "rating").as_deref() == Some("text")
            && f.row_type("Second.md", "rating").as_deref() == Some("text")
    });
    f.learned_into_the_file("rating", "text");
}

/// A number the user chose stays a number over a value it cannot show.
#[test]
fn a_type_the_user_chose_never_settles() {
    let chosen = "---\nproperties:\n  rating:\n    type: number\n---\n";
    let f = opened(&[
        (".memry/properties.md", chosen),
        ("First.md", "---\nrating: 5\n---\n"),
        ("Second.md", "---\nrating: good\n---\n"),
    ]);
    assert_eq!(f.row_type("Second.md", "rating").as_deref(), Some("number"));
    assert_eq!(f.properties_file().as_deref(), Some(chosen));
    let listed = f.definition("rating").unwrap();
    assert_eq!(listed.type_name, DefinitionType::Number);
}

/// 2b3a512960: Electron's reload deleted the learned rows, so a vault opened from Obsidian lost
/// its text and number definitions on the next launch. Here they are in `properties.md`.
#[test]
fn learned_definitions_are_in_the_file_after_a_reopen() {
    let mut f = opened(&[(
        "Plan.md",
        "---\nrating: 5\nsite: https://example.com\nmood: calm\n---\n",
    )]);
    until("the names learned", || {
        f.typed_with().is_some_and(|typed| {
            ["rating", "site", "mood"]
                .iter()
                .all(|n| typed.contains_key(*n))
        })
    });
    f.e.close();
    f.e.open();
    f.e.facts_until(vault_env::indexed);
    f.learned_into_the_file("rating", "number");
    f.learned_into_the_file("site", "url");
    f.learned_into_the_file("mood", "text");
}

/// A type an older build learned is in `meta` only. The next list writes it into the file, and
/// it leaves `meta`; a name the file holds keeps the file's entry.
#[test]
fn types_an_older_build_learned_reach_the_file_on_a_list() {
    let f = crate::property_definitions::fixture();
    f.set_file(DEFINITIONS);
    let data = rusqlite::Connection::open(f.vault.join(".memry/core/data.db")).unwrap();
    data.execute(
        "INSERT INTO meta (key, value) VALUES ('property_definitions.learned', ?1)",
        [r#"{"rating":"number","stage":"text"}"#],
    )
    .unwrap();
    let names: Vec<String> = f
        .definitions
        .list()
        .unwrap()
        .into_iter()
        .map(|d| d.name)
        .collect();
    assert_eq!(names, ["project", "rating", "stage"]);
    let file = f.file().unwrap();
    assert!(file.contains(DEFINED_KEPT), "{file}");
    assert!(file.contains("  rating:\n    type: number\n"), "{file}");
    assert!(f.records.learned().unwrap().is_empty());
    assert!(f.record("rating").is_none());
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
    f.learned_into_the_file("title", "text");
}

const DEFINITIONS: &str = "---\nproperties:\n  stage:\n    type: select\n    options:\n      - value: Draft\n        color: sky\n  project:\n    type: text\n    color: red\n---\n";
/// The entries of [`DEFINITIONS`] as the file keeps them after another entry is written.
const DEFINED_KEPT: &str = "  stage:\n    type: select\n    options:\n      - value: Draft\n        color: sky\n  project:\n    type: text\n    options: []\n    color: red\n";

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
    let file = f.properties_file().unwrap();
    assert!(file.contains(DEFINED_KEPT), "{file}");
    let names: Vec<String> = f.definitions().into_iter().map(|d| d.name).collect();
    assert_eq!(names, ["project", "site", "stage"]);
    f.learned_into_the_file("site", "url");
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
    std::fs::remove_file(f.e.vault.join(".memry/properties.md")).unwrap();
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
    let held = f.file().unwrap();
    assert!(held.contains(DEFINED_KEPT), "{held}");
    assert!(held.contains("  site:\n    type: url\n"), "{held}");
    assert!(f.record("site").is_none());
    assert!(f.records.learned().unwrap().is_empty());
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
