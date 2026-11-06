//! What a tag schema change would reach (`tags:preview-impact`, #3530 13j-3d-1), counted over a
//! vault the running tier adopted and the note index measured, with tasks written through the
//! core's task writer: the five kinds, as Electron's `tags/schema/impact.test.ts` counts them.

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::index_support;
#[allow(unused_imports)]
use crate::vault_env;

use std::sync::Arc;

use index_support::{all_indexed, until, with_task};
use memry_core::api::projects::ProjectDraft;
use memry_core::api::tasks_write::NewTaskInput;
use memry_core::seams::secure_store::SecureStore;
use memry_desktop::error::{CoreError, FailureKind};
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::service::NotesService;
use memry_desktop::session::OpenVault;
use memry_desktop::tags::schema::Schemas;
use memry_desktop::tags::schema::impact::{ImpactQuery, ImpactView};
use memry_desktop::tags::schema::view::{
    FieldType, NewFieldSpec, TagSchemaCommand, TemplateChoice,
};
use memry_desktop::templates::Templates;
use memry_desktop::vault::consumer::Applied;
use tokio::sync::broadcast;
use vault_env::{Env, env, indexed};

/// Electron's fixture as files: `mention` carries `#person` in its body only, and the day's
/// header tag makes no object.
const FILES: &[(&str, &str)] = &[
    ("ahmet.md", "---\ntags: [person]\nRole: PM\n---\nA\n"),
    ("elif.md", "---\ntags: [Person]\nPhone: '555'\n---\nE\n"),
    ("bare.md", "---\ntags: [person]\n---\nB\n"),
    ("eng.md", "---\ntags: [employee]\nRole: CTO\n---\nC\n"),
    ("vip.md", "---\ntags: [person/vip]\n---\nV\n"),
    ("mention.md", "---\nRole: x\n---\nSee #person\n"),
    ("journal/2026-01-01.md", "---\ntags: [person]\n---\nA day\n"),
    (
        "applicant.md",
        "---\ntags: [candidate]\nRole: Dev\n---\nD\n",
    ),
    ("draft-a.md", "---\ntags: [project]\n---\nP\n"),
    ("draft-b.md", "---\ntags: [Project]\n---\nQ\n"),
];

fn opened() -> (Env, OpenVault, Arc<dyn SecureStore>) {
    let mut kept = None;
    let mut e = env(|store| {
        kept = Some(store.clone());
        Some(NotesIdentity::new(store))
    });
    for (path, text) in FILES {
        e.write(path, text);
    }
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

fn text(name: &str) -> NewFieldSpec {
    NewFieldSpec {
        name: name.to_owned(),
        type_name: FieldType::Text,
        options: None,
        relation: None,
    }
}

/// `person` (Role, Phone, its own template), `employee` and `person/vip` extending it, and
/// `candidate` (Role).
fn define(schemas: &Schemas, template: &str) {
    let add = |tag: &str, name: &str| TagSchemaCommand::AddField {
        tag: tag.to_owned(),
        field: text(name),
        index: None,
    };
    let extend = |tag: &str| TagSchemaCommand::SetExtends {
        tag: tag.to_owned(),
        parent: Some("person".to_owned()),
    };
    for command in [
        add("person", "Role"),
        add("person", "Phone"),
        TagSchemaCommand::SetTemplate {
            tag: "person".to_owned(),
            template: Some(TemplateChoice {
                id: template.to_owned(),
                autofill: true,
            }),
        },
        extend("employee"),
        add("employee", "Team"),
        extend("person/vip"),
        add("candidate", "Role"),
    ] {
        schemas
            .run(command, &mut |_, _, _| {})
            .expect("a schema edit");
    }
}

/// Tasks as Electron's fixture has them: a filled `Role` (tagged `Person`, as a task keeps the
/// spelling it was given), none, one cleared since, and one on a tag outside `person`; and a
/// deleted one that counts nowhere.
fn tasks(open: &OpenVault, store: &Arc<dyn SecureStore>) {
    let tasks = open.vault.tasks(store.clone()).unwrap();
    let project = tasks
        .create_project(ProjectDraft {
            name: "Inbox".into(),
            description: None,
            color: None,
            icon: None,
            statuses: None,
        })
        .unwrap();
    let task = |title: &str, tag: &str, role: Option<&str>| {
        let id = tasks
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
                tags: vec![tag.to_owned()],
                linked_note_ids: Vec::new(),
                linked_canvas_ids: Vec::new(),
                source_note_id: None,
                position: None,
            })
            .unwrap()
            .created[0]
            .clone();
        if let Some(role) = role {
            let value = Some(serde_json::json!(role).to_string());
            tasks
                .set_field_value(id.clone(), "Role".into(), value)
                .unwrap();
        }
        id
    };
    task("filled", "Person", Some("Lead"));
    task("empty", "person", None);
    let cleared = task("cleared", "employee", Some("Ex"));
    tasks.set_field_value(cleared, "Role".into(), None).unwrap();
    task("other", "company", Some("Buyer"));
    let deleted = task("deleted", "person", Some("Gone"));
    tasks.delete(deleted, false).unwrap();
}

#[test]
fn a_schema_change_counts_the_objects_values_and_tasks_it_reaches() {
    let (mut e, open, store) = opened();
    let schemas = Schemas::open(
        &open,
        &NotesService::new(e.tier.clone(), store.clone()),
        "en",
    )
    .unwrap();
    let template = Templates::open(&open, store.clone())
        .unwrap()
        .list()
        .unwrap()[0]
        .clone();
    define(&schemas, &template.id);
    tasks(&open, &store);
    let impact = |query| schemas.preview_impact(query).unwrap();
    let tag = |name: &str| name.to_owned();

    // Objects of person and its children: ahmet, elif, bare, eng, vip; tasks filled, empty,
    // cleared. Filled: ahmet, eng and the filled task; a cleared value and a body mention are
    // not, and neither is the day.
    assert_eq!(
        impact(ImpactQuery::RemoveField {
            tag: tag("Person"),
            name: tag("Role"),
        }),
        ImpactView::RemoveField {
            filled: 3,
            empty: 5
        }
    );

    // Vault-wide: ahmet, eng, mention, applicant; the filled and the other task.
    assert_eq!(
        impact(ImpactQuery::RenameField { name: tag("Role") }),
        ImpactView::RenameField {
            notes: 4,
            tasks: 2,
            tags: vec![tag("candidate"), tag("person")],
        }
    );

    // Header carriers of exactly person: ahmet, elif, bare. Values: ahmet's Role, elif's Phone.
    assert_eq!(
        impact(ImpactQuery::DeleteTag { tag: tag("person") }),
        ImpactView::DeleteTag {
            notes: 3,
            tasks: 2,
            values: 2,
            fields: 2,
            template_name: Some(template.name.clone()),
        }
    );
    // employee's template is person's, so deleting it takes none.
    assert_eq!(
        impact(ImpactQuery::DeleteTag {
            tag: tag("employee")
        }),
        ImpactView::DeleteTag {
            notes: 1,
            tasks: 1,
            values: 1,
            fields: 1,
            template_name: None,
        }
    );
    assert_eq!(
        impact(ImpactQuery::DeleteTag { tag: tag("ghost") }),
        ImpactView::DeleteTag {
            notes: 0,
            tasks: 0,
            values: 0,
            fields: 0,
            template_name: None,
        }
    );

    assert_eq!(
        impact(ImpactQuery::SetExtends {
            tag: tag("employee"),
            parent: None,
        }),
        ImpactView::SetExtends {
            notes: 1,
            gained: vec![],
            lost: vec![tag("Role"), tag("Phone")],
        }
    );
    // candidate owns Role, so only Phone is new.
    assert_eq!(
        impact(ImpactQuery::SetExtends {
            tag: tag("candidate"),
            parent: Some(tag("person")),
        }),
        ImpactView::SetExtends {
            notes: 1,
            gained: vec![tag("Phone")],
            lost: vec![],
        }
    );

    assert_eq!(
        impact(ImpactQuery::BecomeObjects {
            tag: tag("project")
        }),
        ImpactView::BecomeObjects { notes: 2 }
    );
    assert_eq!(
        impact(ImpactQuery::BecomeObjects { tag: tag("person") }),
        ImpactView::BecomeObjects { notes: 5 }
    );
    e.close();
}

#[test]
fn a_query_without_a_tag_or_a_field_name_or_with_one_too_long_is_refused() {
    let (mut e, open, store) = opened();
    let schemas = Schemas::open(
        &open,
        &NotesService::new(e.tier.clone(), store.clone()),
        "en",
    )
    .unwrap();
    let (tag, field) = ("t".repeat(51), "f".repeat(201));
    for query in [
        ImpactQuery::RemoveField {
            tag: "person".into(),
            name: "  ".into(),
        },
        ImpactQuery::BecomeObjects { tag: String::new() },
        ImpactQuery::DeleteTag { tag },
        ImpactQuery::RenameField { name: field },
        ImpactQuery::SetExtends {
            tag: "person".into(),
            parent: Some(" ".into()),
        },
    ] {
        let refused = schemas.preview_impact(query.clone());
        let kind = refused.as_ref().map_err(|error| error.kind_and_code().0);
        assert_eq!(
            kind.err(),
            Some(FailureKind::Invalid),
            "{query:?}: {refused:?}"
        );
    }
    e.close();
}
