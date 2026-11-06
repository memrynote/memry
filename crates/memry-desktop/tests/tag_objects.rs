//! The object search of tags with fields (#3530 13j-3c) over a real session, tier, watcher and
//! index task, the oracle being Electron's `tags/objects.test.ts`: locale folding, root-tag
//! groups and subtitles.

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::index_support;
#[allow(unused_imports)]
use crate::vault_env;

use std::sync::Arc;

use index_support::until;
use memry_core::seams::secure_store::SecureStore;
use memry_desktop::error::{CoreError, FailureKind};
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::index::NoteIndex;
use memry_desktop::notes::service::NotesService;
use memry_desktop::tags::schema::Schemas;
use memry_desktop::tags::schema::objects::SearchObjectsInput;
use memry_desktop::tags::schema::view::{FieldType, NewFieldSpec, RelationView, TagSchemaCommand};
use memry_desktop::vault::hash::content_hash;
use serde_json::{Value, json};
use vault_env::{Env, env, indexed};

struct Fixture {
    e: Env,
    store: Arc<dyn SecureStore>,
    _index: Arc<NoteIndex>,
}

/// A vault holding `files`, opened with its index running, every file read once.
fn opened(files: &[(&str, &str)]) -> Fixture {
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
    let f = Fixture {
        e,
        store: kept.expect("the store"),
        _index: index,
    };
    until("every file read", || index_support::all_indexed(&f.e));
    f
}

impl Fixture {
    fn id_at(&self, path: &str) -> String {
        self.e
            .rows()
            .into_iter()
            .find(|(_, p)| p == path)
            .unwrap_or_else(|| panic!("no row at {path}"))
            .0
    }

    /// Writes `path` outside the app and waits until the index read it.
    fn outside(&self, path: &str, text: &str) {
        let id = self.id_at(path);
        self.e.write(path, text);
        let search = self.e.session.current().unwrap().search;
        until("the outside edit read", || {
            search.note_stats(&id).unwrap().and_then(|s| s.file_hash) == Some(content_hash(text))
        });
    }

    fn schemas(&self) -> Schemas {
        let open = self.e.session.current().expect("open");
        let notes = NotesService::new(self.e.tier.clone(), self.store.clone());
        Schemas::open(&open, &notes, "en").expect("schemas")
    }

    fn run(&self, command: TagSchemaCommand) {
        self.schemas()
            .run(command, &mut |_, _, _| {})
            .expect("the schema edit");
    }

    fn field(&self, tag: &str, name: &str, relation: Option<&str>) {
        self.run(TagSchemaCommand::AddField {
            tag: tag.to_owned(),
            field: NewFieldSpec {
                name: name.to_owned(),
                type_name: if relation.is_some() {
                    FieldType::Relation
                } else {
                    FieldType::Text
                },
                options: None,
                relation: relation.map(|target| RelationView {
                    target: Some(target.to_owned()),
                    many: false,
                    inverse: None,
                }),
            },
            index: None,
        });
    }

    /// `person` (Role, Company → company), `employee` extending it (Team), `company` (Website).
    fn people(&self) {
        self.field("person", "Role", None);
        self.field("person", "Company", Some("company"));
        self.field("employee", "Team", None);
        self.run(TagSchemaCommand::SetExtends {
            tag: "employee".to_owned(),
            parent: Some("person".to_owned()),
        });
        self.field("company", "Website", None);
    }

    fn search(&self, query: &str, tag: Option<&str>) -> Value {
        let input = SearchObjectsInput {
            query: query.to_owned(),
            tag: tag.map(str::to_owned),
            limit: None,
        };
        serde_json::to_value(self.schemas().search_objects(&input).unwrap()).unwrap()
    }
}

fn uri(id: &str) -> String {
    format!("memry://note/{id}")
}

#[test]
fn objects_are_searched_with_locale_folding_and_grouped_under_the_root_tag() {
    let mut f = opened(&[
        ("Acme.md", "---\ntags: [company]\n---\nAcme\n"),
        ("İlker Şahin.md", "---\ntags: [employee]\n---\n"),
        ("Işık.md", "---\ntags: [Person]\n---\n"),
        ("Ilker notes.md", "About #person\n"),
    ]);
    f.people();
    let acme = f.id_at("Acme.md");
    let company = json!([uri(&acme)]).to_string();
    f.outside(
        "İlker Şahin.md",
        &format!("---\ntags: [employee]\nRole: Engineer\nCompany: {company}\n---\n"),
    );

    let by_name = f.search("ilker sa", None);
    let matches = by_name["matches"].as_array().unwrap();
    assert_eq!(matches.len(), 1, "a body #tag is no object: {by_name}");
    let found = &matches[0];
    assert_eq!(found["noteId"], json!(f.id_at("İlker Şahin.md")));
    assert_eq!(found["title"], json!("İlker Şahin"));
    assert_eq!(
        (&found["tag"], &found["groupTag"], &found["viaTag"]),
        (&json!("employee"), &json!("person"), &json!("employee"))
    );
    assert_eq!(found["subtitle"], json!(["Engineer", "Acme"]));
    assert!(found["modified"].as_str().unwrap().ends_with('Z'));
    assert_eq!(by_name["complete"], json!(true));

    let dotless = f.search("ISIK", Some("person"));
    let ids: Vec<&Value> = dotless["matches"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| &m["noteId"])
        .collect();
    assert_eq!(ids, [&json!(f.id_at("Işık.md"))]);
    assert_eq!(found_tags(&f.search("", Some("company"))), ["company"]);
    assert_eq!(
        found_tags(&f.search("", Some("plain"))),
        Vec::<String>::new()
    );
    f.e.close();
}

fn found_tags(answer: &Value) -> Vec<String> {
    answer["matches"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["tag"].as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn input_electrons_schemas_refuse_is_refused_as_invalid() {
    let mut f = opened(&[("Plain.md", "Plain\n")]);
    let schemas = f.schemas();
    let search = |query: &str, tag: Option<&str>, limit: Option<u32>| {
        schemas.search_objects(&SearchObjectsInput {
            query: query.into(),
            tag: tag.map(str::to_owned),
            limit,
        })
    };
    let refusals = [
        search(&"a".repeat(201), None, None).err(),
        search("", Some("  "), None).err(),
        search("", None, Some(0)).err(),
        search("", None, Some(51)).err(),
    ];
    for refusal in refusals {
        let kind = refusal.expect("refused").kind_and_code().0;
        assert_eq!(kind, FailureKind::Invalid);
    }
    assert!(search(&"a".repeat(200), Some(" person "), Some(50)).is_ok());
    f.e.close();
}
