//! Tags with fields (#3530 13j-3b) over a vault the running tier adopted and the note index
//! measured: the snapshot's ready-made tags, adding one (fields, definitions, template, colour,
//! icon), a note whose header carries it becoming its object, the refusals in the UI language,
//! and that no edit writes a note file.

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::index_support;
#[allow(unused_imports)]
use crate::vault_env;

use std::sync::Arc;

use index_support::{all_indexed, until, with_task};
use memry_core::seams::secure_store::SecureStore;
use memry_desktop::error::{CoreError, FailureKind};
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::read;
use memry_desktop::session::OpenVault;
use memry_desktop::tags::schema::view::{
    FieldType, NewFieldSpec, PresetKey, PresetState, RelationView, TagSchemaCommand, TemplateChoice,
};
use memry_desktop::tags::schema::{SchemaError, Schemas};
use memry_desktop::templates::Templates;
use memry_desktop::vault::consumer::Applied;
use tokio::sync::broadcast;
use vault_env::{Env, env, indexed};

const ADA: &str = "---\ntags:\n  - idea\n  - Person\n---\nAda\n";
const PLAIN: &str = "No header\n";

fn opened() -> (Env, OpenVault, Arc<dyn SecureStore>) {
    let mut kept = None;
    let mut e = env(|store| {
        kept = Some(store.clone());
        Some(NotesIdentity::new(store))
    });
    e.write("Ada.md", ADA);
    e.write("Plain.md", PLAIN);
    e.open();
    e.facts_until(indexed);
    let open = e.session.current().expect("open");
    let (sender, receiver) = broadcast::channel(4);
    with_task(&open, receiver, |_| {
        sender.send(Applied::Indexed { complete: true }).unwrap();
        until("every file measured", || all_indexed(&e));
    });
    (e, open, kept.expect("the store"))
}

fn schemas(open: &OpenVault, store: &Arc<dyn SecureStore>) -> Schemas {
    Schemas::open(open, store.clone(), "en").expect("schemas")
}

fn field(name: &str, type_name: FieldType) -> NewFieldSpec {
    NewFieldSpec {
        name: name.to_owned(),
        type_name,
        options: None,
        relation: None,
    }
}

#[test]
fn a_vault_with_no_schemas_offers_every_ready_made_tag_in_the_ui_language() {
    let (mut e, open, store) = opened();
    let snapshot = schemas(&open, &store).snapshot().unwrap();
    assert!(snapshot.tags.is_empty() && snapshot.objects.is_empty());
    assert!(!snapshot.preset_strip_dismissed);
    let offers: Vec<(&str, &str, PresetState, Vec<&str>)> = snapshot
        .presets
        .iter()
        .map(|o| {
            let also = o.also_adds.iter().map(String::as_str).collect();
            (o.key.as_str(), o.name.as_str(), o.state, also)
        })
        .collect();
    assert_eq!(
        offers,
        [
            ("person", "person", PresetState::Add, vec!["company"]),
            ("company", "company", PresetState::Add, vec![]),
            (
                "meeting",
                "meeting",
                PresetState::Add,
                vec!["person", "company"]
            ),
            ("book", "book", PresetState::Add, vec![]),
        ]
    );
    let person = &snapshot.presets[0];
    let fields: Vec<(&str, &str, Option<&str>)> = person
        .fields
        .iter()
        .map(|f| {
            (
                f.name.as_str(),
                f.type_name.as_str(),
                f.relation_target.as_deref(),
            )
        })
        .collect();
    assert_eq!(
        fields,
        [
            ("Company", "relation", Some("company")),
            ("Role", "text", None),
            ("Email", "text", None),
            ("Phone", "text", None),
        ]
    );
    assert_eq!(person.template_sections, ["Context", "Notes"]);
    assert_eq!(person.icon.as_deref(), Some("icon:UserIcon"));

    let tr = Schemas::open(&open, store.clone(), "tr").unwrap();
    assert_eq!(tr.snapshot().unwrap().presets[0].name, "kişi");
    e.close();
}

#[test]
fn adding_a_preset_writes_its_fields_definitions_template_and_appearance_and_makes_objects() {
    let (mut e, open, store) = opened();
    let schemas = schemas(&open, &store);
    let ran = schemas
        .run(TagSchemaCommand::AddPreset {
            preset: PresetKey::Person,
            tag: None,
        })
        .unwrap();
    assert_eq!(ran.result.tag.as_deref(), Some("person"));
    assert!(ran.tags_changed);
    let snapshot = &ran.result.snapshot;

    let person = &snapshot.tags["person"];
    let fields: Vec<(&str, &str)> = person
        .effective_fields
        .iter()
        .map(|f| (f.name.as_str(), f.type_name.as_str()))
        .collect();
    assert_eq!(
        fields,
        [
            ("Company", "relation"),
            ("Role", "text"),
            ("Email", "text"),
            ("Phone", "text")
        ]
    );
    let company = person.effective_fields[0].relation.as_ref().unwrap();
    assert_eq!(
        (
            company.target.as_deref(),
            company.many,
            company.inverse.as_deref()
        ),
        (Some("company"), false, Some("People"))
    );
    assert_eq!(
        (person.color.as_str(), person.icon.as_deref()),
        ("sky", Some("icon:UserIcon"))
    );
    assert_eq!(person.own_preset, Some(PresetKey::Person));
    let template = person.template.as_ref().expect("a template");
    assert!(template.autofill && template.inherited_from.is_none());
    assert_eq!(
        snapshot.tags["company"].own_preset,
        Some(PresetKey::Company),
        "the relation's target preset is added too"
    );
    let states: Vec<PresetState> = snapshot.presets.iter().map(|o| o.state).collect();
    assert_eq!(
        states,
        [
            PresetState::Added,
            PresetState::Added,
            PresetState::Add,
            PresetState::Add
        ]
    );
    assert!(snapshot.presets[2].also_adds.is_empty());

    let mut created = ran.effects.definitions.clone();
    created.sort();
    assert_eq!(
        created,
        ["Email", "Industry", "Location", "Phone", "Role", "Website"]
    );
    assert_eq!(ran.effects.templates.len(), 2);
    let templates = Templates::open(&open, store.clone()).unwrap();
    let body = templates
        .get(&template.id)
        .unwrap()
        .expect("the template")
        .content;
    assert_eq!(
        body,
        "## Context\nHow we met, what they care about\n\n## Notes\n"
    );

    let ada = read::get_by_path(&open, "Ada.md", None)
        .unwrap()
        .expect("Ada")
        .id;
    assert_eq!(
        snapshot.objects.get(&ada).map(String::as_str),
        Some("person"),
        "the header's first tag with fields"
    );
    assert_eq!(snapshot.objects.len(), 1);
    assert_eq!(snapshot.presets[0].existing_tag.as_ref().unwrap().usage, 1);

    let again = schemas
        .run(TagSchemaCommand::AddPreset {
            preset: PresetKey::Person,
            tag: None,
        })
        .unwrap();
    assert!(
        again.effects.templates.is_empty(),
        "its own template is kept"
    );
    assert_eq!(e.read("Ada.md"), ADA, "a schema edit writes no note file");
    assert_eq!(e.read("Plain.md"), PLAIN);
    e.close();
}

fn refused(result: Result<memry_desktop::tags::schema::Ran, SchemaError>) -> (String, String) {
    let error = result.expect_err("refused");
    let (kind, code) = error.kind_and_code();
    assert_eq!(kind, FailureKind::Invalid, "{error}");
    (code.to_owned(), error.to_string())
}

#[test]
fn an_edit_is_refused_in_the_ui_language_and_writes_nothing() {
    let (mut e, open, store) = opened();
    let schemas = schemas(&open, &store);
    let add = |name: &str, type_name| TagSchemaCommand::AddField {
        tag: "person".to_owned(),
        field: field(name, type_name),
        index: None,
    };
    schemas.run(add("Role", FieldType::Text)).unwrap();

    assert_eq!(
        refused(schemas.run(add("tags", FieldType::Text))),
        (
            "tag_field_reserved_name".to_owned(),
            "\"tags\" is reserved and cannot be a field name".to_owned()
        )
    );
    assert_eq!(
        refused(schemas.run(add("ROLE", FieldType::Text))).0,
        "tag_field_duplicate"
    );
    assert_eq!(
        refused(schemas.run(add("Boss", FieldType::Relation))),
        (
            "tag_field_relation_target_required".to_owned(),
            "Choose which tag this relation points to".to_owned()
        )
    );
    assert_eq!(
        refused(schemas.run(TagSchemaCommand::SetExtends {
            tag: "person".to_owned(),
            parent: Some(" Person ".to_owned()),
        }))
        .0,
        "tag_schema_cycle"
    );
    let snapshot = schemas.snapshot().unwrap();
    let names: Vec<&str> = snapshot.tags["person"]
        .own_fields
        .iter()
        .map(|f| f.name.as_str())
        .collect();
    assert_eq!(names, ["Role"], "a refused edit leaves the schema");
    e.close();
}

#[test]
fn an_input_the_schema_cannot_hold_is_refused_and_the_tag_stays_editable() {
    let (mut e, open, store) = opened();
    let schemas = schemas(&open, &store);
    let boss = |target: Option<String>, inverse: Option<String>| NewFieldSpec {
        relation: Some(RelationView {
            target,
            many: false,
            inverse,
        }),
        ..field("Boss", FieldType::Relation)
    };
    schemas
        .run(TagSchemaCommand::AddField {
            tag: "person".to_owned(),
            field: boss(Some("person".to_owned()), None),
            index: None,
        })
        .unwrap();
    let relation =
        |target: Option<String>, inverse: Option<String>| TagSchemaCommand::SetRelation {
            tag: "person".to_owned(),
            name: "Boss".to_owned(),
            relation: RelationView {
                target,
                many: false,
                inverse,
            },
        };
    // A label over 100 characters once saved a schema no build reads: the tag locked.
    let long_label = Some(format!("  {}  ", "x".repeat(101)));
    refused(schemas.run(relation(None, long_label.clone())));
    refused(schemas.run(TagSchemaCommand::AddField {
        tag: "person".to_owned(),
        field: NewFieldSpec {
            name: "Mentor".to_owned(),
            ..boss(None, long_label)
        },
        index: None,
    }));
    refused(schemas.run(relation(Some("  ".to_owned()), None)));
    refused(schemas.run(relation(Some("t".repeat(51)), None)));
    refused(schemas.run(TagSchemaCommand::SetTemplate {
        tag: "person".to_owned(),
        template: Some(TemplateChoice {
            id: String::new(),
            autofill: true,
        }),
    }));

    // A label at the limit, padded, is trimmed and kept.
    let ran = schemas
        .run(relation(None, Some(format!(" {} ", "x".repeat(100)))))
        .unwrap();
    let person = &ran.result.snapshot.tags["person"];
    assert!(person.editable);
    let inverse = person.own_fields[0]
        .relation
        .as_ref()
        .unwrap()
        .inverse
        .as_deref();
    assert_eq!(inverse.map(str::len), Some(100));
    schemas
        .run(TagSchemaCommand::RemoveField {
            tag: "person".to_owned(),
            name: "Boss".to_owned(),
        })
        .unwrap();
    e.close();
}

#[test]
fn a_field_takes_the_spelling_and_type_of_a_property_already_defined() {
    let (mut e, open, store) = opened();
    let schemas = schemas(&open, &store);
    schemas
        .run(TagSchemaCommand::AddField {
            tag: "book".to_owned(),
            field: NewFieldSpec {
                options: Some(Vec::new()),
                ..field("Shelf", FieldType::Select)
            },
            index: None,
        })
        .unwrap();
    let ran = schemas
        .run(TagSchemaCommand::AddField {
            tag: "album".to_owned(),
            field: field(" shelf ", FieldType::Number),
            index: None,
        })
        .unwrap();
    assert!(ran.effects.definitions.is_empty(), "the definition exists");
    let shelf = &ran.result.snapshot.tags["album"].own_fields[0];
    assert_eq!(
        (shelf.name.as_str(), shelf.type_name.as_str()),
        ("Shelf", "select")
    );

    let relation = schemas
        .run(TagSchemaCommand::AddField {
            tag: "album".to_owned(),
            field: NewFieldSpec {
                relation: Some(RelationView {
                    target: Some(" Book ".to_owned()),
                    many: true,
                    inverse: None,
                }),
                ..field("Pairs", FieldType::Relation)
            },
            index: Some(0),
        })
        .unwrap();
    let first = &relation.result.snapshot.tags["album"].own_fields[0];
    assert_eq!(
        first.relation.as_ref().unwrap().target.as_deref(),
        Some("book")
    );
    e.close();
}

#[test]
fn dismissing_the_ready_made_tags_is_kept() {
    let (mut e, open, store) = opened();
    let ran = schemas(&open, &store)
        .run(TagSchemaCommand::DismissPresetOffer)
        .unwrap();
    assert!(ran.result.snapshot.preset_strip_dismissed);
    assert!(
        schemas(&open, &store)
            .snapshot()
            .unwrap()
            .preset_strip_dismissed
    );
    e.close();
}
