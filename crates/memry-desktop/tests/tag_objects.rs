//! Object reads for tags with fields (#3530 13j-3c) over a real session, tier, watcher and
//! index task, the oracle being Electron's `tags/objects.test.ts`: the object search with its
//! locale folding and root-tag groups, and what Linked here lists for a note (relation fields,
//! task fields, wiki links), each group by the tag that defines its field. Neither read settles
//! a pulled property definition into `properties.md`: a keystroke writes no file.

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::index_support;
#[allow(unused_imports)]
use crate::vault_env;

use std::sync::Arc;

use index_support::until;
use memry_core::api::projects::ProjectDraft;
use memry_core::api::tasks_write::NewTaskInput;
use memry_core::seams::secure_store::SecureStore;
use memry_core::storage::repositories::sync_items::InboundRecord;
use memry_core::sync::apply::apply_inbound;
use memry_desktop::error::{CoreError, FailureKind};
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::index::NoteIndex;
use memry_desktop::notes::property_definitions::PropertyDefinitions;
use memry_desktop::notes::service::NotesService;
use memry_desktop::tags::schema::Schemas;
use memry_desktop::tags::schema::objects::{
    GetLinkedHereInput, LinkedHereGroupView, SearchObjectsInput,
};
use memry_desktop::tags::schema::view::{FieldType, NewFieldSpec, RelationView, TagSchemaCommand};
use memry_desktop::vault::hash::content_hash;
use memry_desktop::vault::properties_file::properties_path;
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

    fn linked_here(&self, note_id: &str) -> Vec<LinkedHereGroupView> {
        let input = GetLinkedHereInput {
            note_id: note_id.to_owned(),
            limit_per_group: None,
        };
        self.schemas().linked_here(&input).unwrap().groups
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
fn linked_here_lists_relation_fields_task_fields_and_wiki_links() {
    let mut f = opened(&[
        ("Acme.md", "---\ntags: [company]\n---\nAcme\n"),
        ("Ahmet.md", "---\ntags: [person]\n---\n"),
        ("journal/2026-01-02.md", "Met [[Acme]] today\n"),
        ("journal/2026-01-03.md", "Quiet day\n"),
    ]);
    f.people();
    f.field("followup", "Waiting on", Some("company"));
    let acme = f.id_at("Acme.md");
    let ahmet = f.id_at("Ahmet.md");
    let company = json!([uri(&acme)]).to_string();
    f.outside(
        "Ahmet.md",
        &format!("---\ntags: [person]\nCompany: {company}\n---\n"),
    );
    f.outside(
        "Acme.md",
        &format!("---\ntags: [company]\nSelf: {company}\n---\nAcme [[Acme]]\n"),
    );
    // A journal day is no relation source, whatever its header holds.
    f.outside(
        "journal/2026-01-03.md",
        &format!("---\ntags: [person]\nCompany: {company}\n---\nQuiet day\n"),
    );

    let open = f.e.session.current().unwrap();
    let tasks = open.vault.tasks(f.store.clone()).unwrap();
    let project = tasks
        .create_project(ProjectDraft {
            name: "Home".into(),
            description: None,
            color: None,
            icon: None,
            statuses: None,
        })
        .unwrap();
    let task = |title: &str| {
        tasks
            .create(NewTaskInput {
                title: title.into(),
                project_id: project.clone(),
                status_id: None,
                parent_id: None,
                priority: 0,
                description: None,
                due_date: None,
                due_time: None,
                start_date: None,
                repeat: None,
                repeat_from: None,
                tags: vec!["followup".into()],
                linked_note_ids: Vec::new(),
                linked_canvas_ids: Vec::new(),
                source_note_id: None,
                position: None,
            })
            .unwrap()
            .created[0]
            .clone()
    };
    let ping = task("Ping Acme");
    let stale = task("Stale");
    let archived = task("Archived");
    tasks
        .set_field_value(archived.clone(), "Waiting on".into(), Some(company.clone()))
        .unwrap();
    tasks.bulk_archive(vec![archived]).unwrap();
    tasks
        .set_field_value(ping.clone(), "Waiting on".into(), Some(company.clone()))
        .unwrap();
    tasks
        .set_field_value(stale.clone(), "Waiting on".into(), Some(company.clone()))
        .unwrap();
    tasks
        .set_field_value(stale, "Waiting on".into(), None)
        .unwrap();

    let day = "j2026-01-02";
    until("the day's link indexed", || {
        f.linked_here(&acme)
            .iter()
            .any(|g| matches!(g, LinkedHereGroupView::Mentions { .. }))
    });
    let groups = serde_json::to_value(f.linked_here(&acme)).unwrap();
    let filter = format!("contains \"{}\"", uri(&acme));
    assert_eq!(
        groups,
        json!([
            {
                "kind": "relation",
                "sourceTag": "person",
                "field": "Company",
                "label": "person",
                "total": 1,
                "items": [{"noteId": ahmet, "title": "Ahmet", "date": null, "snippet": ""}],
                "filter": format!("Company {filter}"),
            },
            {
                "kind": "task-field",
                "tag": "followup",
                "field": "Waiting on",
                "total": 1,
                "items": [{"taskId": ping, "title": "Ping Acme", "dueDate": null, "completed": false}],
                "filter": format!("Waiting on {filter}"),
            },
            {
                "kind": "mentions",
                "total": 1,
                "items": [{"noteId": day, "title": "2026-01-02", "date": "2026-01-02", "snippet": "Met Acme today"}],
            },
        ]),
        "the self link, the self property, the day's property, the cleared task field and the \
         archived task are left out"
    );

    f.run(TagSchemaCommand::SetRelation {
        tag: "person".into(),
        name: "Company".into(),
        relation: RelationView {
            target: Some("company".into()),
            many: false,
            inverse: Some("People".into()),
        },
    });
    let relation = serde_json::to_value(&f.linked_here(&acme)[0]).unwrap();
    assert_eq!(
        relation["label"],
        json!("People"),
        "the inverse labels the group"
    );
    assert!(f.linked_here(&ahmet).is_empty());
    f.e.close();
}

#[test]
fn object_reads_leave_a_pulled_definition_out_of_the_file() {
    let mut f = opened(&[("Acme.md", "---\ntags: [company]\n---\nAcme\n")]);
    f.people();
    let file = || std::fs::read_to_string(properties_path(&f.e.vault)).ok();
    let before = file();
    let record = InboundRecord {
        item_type: "property_definition".into(),
        item_id: "Area".into(),
        payload_json: json!({"name": "Area", "type": "text", "clock": {"peer": 1}}).to_string(),
        server_cursor: Some(1),
        signer_device_id: Some("peer".into()),
        updated_at: 1,
        deleted_at: None,
    };
    let open = f.e.session.current().unwrap();
    open.vault
        .db_handle()
        .call_blocking(move |c| apply_inbound(c, &record, 1))
        .unwrap();

    f.search("acme", None);
    f.linked_here(&f.id_at("Acme.md"));
    assert_eq!(file(), before, "an object read writes no file");
    let definitions = PropertyDefinitions::open(&open, f.store.clone()).unwrap();
    definitions.list().unwrap();
    assert_ne!(file(), before, "the pull was staged for the next list");
    f.e.close();
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
    let linked = |note_id: &str, limit_per_group: Option<u32>| {
        schemas.linked_here(&GetLinkedHereInput {
            note_id: note_id.into(),
            limit_per_group,
        })
    };
    let refusals = [
        search(&"a".repeat(201), None, None).err(),
        search("", Some("  "), None).err(),
        search("", None, Some(0)).err(),
        search("", None, Some(51)).err(),
        linked("", None).err(),
        linked("x", Some(501)).err(),
    ];
    for refusal in refusals {
        let kind = refusal.expect("refused").kind_and_code().0;
        assert_eq!(kind, FailureKind::Invalid);
    }
    assert!(search(&"a".repeat(200), Some(" person "), Some(50)).is_ok());
    assert!(linked("x", Some(500)).unwrap().groups.is_empty());
    f.e.close();
}
