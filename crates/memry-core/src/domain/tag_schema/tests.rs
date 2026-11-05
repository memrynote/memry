//! Ports `apps/desktop/src/main/tags/tag-schema.test.ts` (resolve, primary object tag, every
//! edit and its refusals, canonical field name), plus the write through the definition writer.

use std::collections::BTreeMap;

use serde_json::{Map, Value, json};

use super::edit::{self, canonical_field_name};
use super::*;

fn obj(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        other => panic!("not an object: {other}"),
    }
}

/// Definitions named as given; a `Some(schema)` is stored with `t: 1` first, a string verbatim.
fn defs(entries: &[(&str, Option<Value>)]) -> BTreeMap<String, DefinitionInput> {
    entries
        .iter()
        .map(|(name, schema)| {
            let stored = schema.as_ref().map(|schema| match schema {
                Value::String(raw) => serde_json::from_str(raw).unwrap_or(Value::Bool(false)),
                Value::Object(body) => {
                    let mut full = obj(json!({"t": 1}));
                    full.extend(body.clone());
                    Value::Object(full)
                }
                other => other.clone(),
            });
            (
                (*name).to_owned(),
                DefinitionInput {
                    name: (*name).to_owned(),
                    color: "blue".into(),
                    icon: None,
                    schema: StoredSchema::parse(stored.as_ref()),
                },
            )
        })
        .collect()
}

fn no_types(_: &str) -> Option<PropertyInfo> {
    None
}

fn names(fields: &[ResolvedField]) -> Vec<&str> {
    fields.iter().map(|f| f.name.as_str()).collect()
}

#[test]
fn inherits_nearest_first_orders_effective_fields_root_first_and_a_closer_name_wins() {
    let resolved = resolve(
        &defs(&[
            (
                "person",
                Some(json!({"fields": [{"name": "Role"}, {"name": "Email"}], "preset": "person"})),
            ),
            (
                "employee",
                Some(json!({
                    "extends": "person",
                    "fields": [{"name": "Team"}, {"name": "Email"}],
                    "template": {"id": "tpl_e", "autofill": true}
                })),
            ),
            (
                "engineer",
                Some(json!({"extends": "Employee", "fields": [{"name": "Stack"}]})),
            ),
        ]),
        &|name| {
            (name == "Role").then(|| PropertyInfo {
                type_name: "select".into(),
                options: Some(json!([])),
                show_on_calendar: None,
            })
        },
    );
    let engineer = &resolved["engineer"];
    assert_eq!(engineer.ancestors, ["employee", "person"]);
    let inherited: Vec<(&str, Vec<&str>)> = engineer
        .inherited
        .iter()
        .map(|g| (g.from.as_str(), names(&g.fields)))
        .collect();
    assert_eq!(
        inherited,
        [
            ("employee", vec!["Team", "Email"]),
            ("person", vec!["Role"])
        ]
    );
    assert_eq!(
        names(&engineer.effective_fields),
        ["Role", "Team", "Email", "Stack"]
    );
    assert_eq!(engineer.effective_fields[0].type_name, "select");
    assert_eq!(engineer.effective_fields[0].defined_by, "person");
    assert_eq!(
        engineer.template,
        Some(ResolvedTemplate {
            id: "tpl_e".into(),
            autofill: true,
            inherited_from: Some("employee".into())
        })
    );
    assert_eq!(engineer.preset.as_deref(), Some("person"));
    assert_eq!(engineer.own_preset, None);
    let mut below = descendants_of("person", &resolved);
    below.sort();
    assert_eq!(below, ["employee", "engineer"]);
}

#[test]
fn an_extends_cycle_is_cut_so_each_sees_the_other_once() {
    let resolved = resolve(
        &defs(&[
            (
                "a",
                Some(json!({"extends": "b", "fields": [{"name": "X"}]})),
            ),
            ("b", Some(json!({"extends": "a", "fields": []}))),
        ]),
        &no_types,
    );
    assert_eq!(resolved["a"].ancestors, ["b"]);
    assert_eq!(resolved["b"].ancestors, ["a"]);
    assert_eq!(names(&resolved["b"].effective_fields), ["X"]);
}

#[test]
fn a_missing_parent_stops_the_chain_relations_are_typed_and_reserved_names_and_plain_tags_skipped()
{
    let resolved = resolve(
        &defs(&[
            (
                "meeting",
                Some(json!({
                    "extends": "gone",
                    "fields": [
                        {"name": "Attendees", "relation": {"target": "Person", "many": true}},
                        {"name": "tags"}
                    ]
                })),
            ),
            ("plain", None),
        ]),
        &|_| {
            Some(PropertyInfo {
                type_name: "text".into(),
                options: Some(json!([{"value": "x"}])),
                show_on_calendar: Some(true),
            })
        },
    );
    let meeting = &resolved["meeting"];
    assert_eq!(meeting.extends.as_deref(), Some("gone"));
    assert!(meeting.ancestors.is_empty());
    assert_eq!(
        meeting.effective_fields,
        [ResolvedField {
            name: "Attendees".into(),
            type_name: "relation".into(),
            options: None,
            show_on_calendar: None,
            relation: Some(Relation {
                target: Some("person".into()),
                many: true,
                inverse: None
            }),
            defined_by: "meeting".into(),
        }]
    );
    assert!(!resolved.contains_key("plain"));
}

#[test]
fn a_project_definition_types_its_field_as_text() {
    let resolved = resolve(
        &defs(&[("t", Some(json!({"fields": [{"name": "Proj"}]})))]),
        &|_| {
            Some(PropertyInfo {
                type_name: "project".into(),
                options: None,
                show_on_calendar: None,
            })
        },
    );
    assert_eq!(resolved["t"].own_fields[0].type_name, "text");
}

#[test]
fn a_schema_a_newer_build_wrote_is_read_only() {
    let resolved = resolve(
        &defs(&[("future", Some(json!(r#"{"t":4,"fields":"v2-shape"}"#)))]),
        &no_types,
    );
    assert!(!resolved["future"].editable);
    assert!(!resolved["future"].has_fields);
}

#[test]
fn the_primary_object_tag_is_the_first_header_tag_with_fields_own_or_inherited() {
    let resolved = resolve(
        &defs(&[
            ("person", Some(json!({"fields": [{"name": "Role"}]}))),
            ("employee", Some(json!({"extends": "person"}))),
            ("idea", Some(json!({}))),
        ]),
        &no_types,
    );
    let tags = |list: &[&str]| list.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
    assert_eq!(
        primary_object_tag(&tags(&["idea", "Employee", "person"]), &resolved).as_deref(),
        Some("employee")
    );
    assert_eq!(
        primary_object_tag(&tags(&["idea", "untracked"]), &resolved),
        None
    );
}

fn edit_context() -> BTreeMap<String, ResolvedTag> {
    resolve(
        &defs(&[
            ("person", Some(json!({"fields": [{"name": "Role"}]}))),
            (
                "employee",
                Some(json!({"extends": "person", "fields": [{"name": "Team"}]})),
            ),
        ]),
        &no_types,
    )
}

fn employee() -> Map<String, Value> {
    obj(json!({"t": 5, "extends": "person", "fields": [{"name": "Team"}], "future": 1}))
}

fn field(name: &str) -> NewField {
    NewField {
        name: name.into(),
        relation: None,
    }
}

fn applied(
    current: Option<&Map<String, Value>>,
    edit: SchemaEdit,
    tag: &str,
) -> Result<Stamped, SchemaEditError> {
    edit::apply(current, &edit, tag, &edit_context())
}

#[test]
fn a_change_stamps_t_plus_one_and_keeps_keys_a_newer_build_added() {
    let result = applied(
        Some(&employee()),
        SchemaEdit::AddField {
            field: field("Desk"),
            index: None,
        },
        "employee",
    )
    .unwrap();
    assert!(result.changed);
    assert_eq!(
        Value::Object(result.next),
        json!({"t": 6, "extends": "person", "fields": [{"name": "Team"}, {"name": "Desk"}], "future": 1})
    );
}

#[test]
fn a_no_op_edit_is_unchanged_without_a_stamp() {
    let result = applied(
        Some(&employee()),
        SchemaEdit::SetExtends {
            parent: Some("Person".into()),
        },
        "employee",
    )
    .unwrap();
    assert_eq!(
        result,
        Stamped {
            next: employee(),
            changed: false
        }
    );
    let none = applied(None, SchemaEdit::SetTemplate { template: None }, "idea").unwrap();
    assert!(!none.changed);
}

#[test]
fn the_first_schema_is_created_at_t_one() {
    let result = applied(
        None,
        SchemaEdit::AddField {
            field: field("Role"),
            index: None,
        },
        "idea",
    )
    .unwrap();
    assert!(result.changed);
    assert_eq!(result.next["t"], json!(1));
    assert_eq!(result.next["fields"], json!([{"name": "Role"}]));
}

#[test]
fn every_refusal_names_its_cause() {
    let cases = [
        (
            SchemaEdit::AddField {
                field: field("Tags"),
                index: None,
            },
            SchemaEditError::ReservedName {
                name: "Tags".into(),
            },
        ),
        (
            SchemaEdit::AddField {
                field: field("team"),
                index: None,
            },
            SchemaEditError::DuplicateField {
                name: "team".into(),
                defined_by: "employee".into(),
            },
        ),
        (
            SchemaEdit::AddField {
                field: field("ROLE"),
                index: None,
            },
            SchemaEditError::DuplicateField {
                name: "ROLE".into(),
                defined_by: "person".into(),
            },
        ),
        (
            SchemaEdit::RemoveField {
                name: "Role".into(),
            },
            SchemaEditError::InheritedField {
                name: "Role".into(),
                defined_by: "person".into(),
            },
        ),
        (
            SchemaEdit::SetRelation {
                name: "Nope".into(),
                relation: None,
            },
            SchemaEditError::UnknownField {
                name: "Nope".into(),
            },
        ),
        (
            SchemaEdit::RenameField {
                from: "Team".into(),
                to: "coverZoom".into(),
                resuming: false,
            },
            SchemaEditError::ReservedName {
                name: "coverZoom".into(),
            },
        ),
    ];
    for (edit, error) in cases {
        assert_eq!(
            applied(Some(&employee()), edit.clone(), "employee"),
            Err(error),
            "{edit:?}"
        );
    }
}

#[test]
fn a_parent_that_would_close_a_cycle_is_refused() {
    let person = obj(json!({"t": 1, "fields": [{"name": "Role"}]}));
    assert_eq!(
        applied(
            Some(&person),
            SchemaEdit::SetExtends {
                parent: Some("employee".into())
            },
            "person"
        ),
        Err(SchemaEditError::Cycle {
            parent: "employee".into()
        })
    );
}

#[test]
fn a_schema_it_cannot_read_is_not_edited() {
    let unreadable = resolve(
        &defs(&[("future", Some(json!(r#"{"t":4,"fields":7}"#)))]),
        &no_types,
    );
    assert_eq!(
        edit::apply(
            None,
            &SchemaEdit::SetTemplate { template: None },
            "future",
            &unreadable
        ),
        Err(SchemaEditError::UnreadableSchema)
    );
}

#[test]
fn a_rename_works_in_place_and_a_resumed_one_drops_the_old_entry() {
    let rename = |from: &str, to: &str, resuming| SchemaEdit::RenameField {
        from: from.into(),
        to: to.into(),
        resuming,
    };
    let renamed = applied(
        Some(&employee()),
        rename("Team", "Squad", false),
        "employee",
    )
    .unwrap();
    assert_eq!(renamed.next["t"], json!(6));
    assert_eq!(renamed.next["fields"], json!([{"name": "Squad"}]));

    let both = obj(json!({"t": 2, "fields": [{"name": "Team"}, {"name": "Squad"}]}));
    let resumed = applied(Some(&both), rename("Team", "Squad", true), "employee").unwrap();
    assert_eq!(resumed.next["t"], json!(3));
    assert_eq!(resumed.next["fields"], json!([{"name": "Squad"}]));

    assert_eq!(
        applied(Some(&both), rename("Team", "squad", false), "employee"),
        Err(SchemaEditError::DuplicateField {
            name: "squad".into(),
            defined_by: "employee".into()
        })
    );
    assert!(
        !applied(Some(&employee()), rename("Absent", "X", false), "employee")
            .unwrap()
            .changed
    );
}

#[test]
fn a_preset_merge_appends_only_missing_fields_and_keeps_the_own_template_and_preset() {
    let own = obj(
        json!({"t": 3, "fields": [{"name": "email"}], "template": {"id": "mine"}, "preset": null}),
    );
    let result = applied(
        Some(&own),
        SchemaEdit::MergePreset {
            fields: vec![
                field("Email"),
                NewField {
                    name: "Company".into(),
                    relation: Some(Relation {
                        target: Some("company".into()),
                        many: false,
                        inverse: Some("People".into()),
                    }),
                },
            ],
            template: Some(("tpl_preset".into(), true)),
            preset: "person".into(),
        },
        "contact",
    )
    .unwrap();
    assert!(result.changed);
    assert_eq!(
        Value::Object(result.next),
        json!({
            "fields": [
                {"name": "email"},
                {"name": "Company", "relation": {"target": "company", "many": false, "inverse": "People"}}
            ],
            "template": {"id": "mine"},
            "preset": "person",
            "t": 4
        })
    );
}

#[test]
fn a_reference_to_a_renamed_or_deleted_tag_is_rewritten() {
    let meeting = obj(json!({
        "t": 2,
        "extends": "Person",
        "fields": [
            {"name": "With", "relation": {"target": "person", "many": true, "extra": 1}},
            {"name": "At", "relation": {"target": "company", "many": false}}
        ]
    }));
    let reference = |from: &str, to: Option<&str>| SchemaEdit::RewriteReference {
        from: from.into(),
        to: to.map(str::to_owned),
    };
    let renamed = applied(Some(&meeting), reference("person", Some("Contact")), "x").unwrap();
    assert_eq!(
        Value::Object(renamed.next),
        json!({
            "t": 3,
            "extends": "contact",
            "fields": [
                {"name": "With", "relation": {"target": "contact", "many": true, "extra": 1}},
                {"name": "At", "relation": {"target": "company", "many": false}}
            ]
        })
    );
    let deleted = applied(Some(&meeting), reference("company", None), "x").unwrap();
    assert_eq!(deleted.next["fields"][1]["relation"]["target"], Value::Null);
    let untouched = applied(Some(&meeting), reference("book", Some("reading")), "x").unwrap();
    assert_eq!(
        untouched,
        Stamped {
            next: meeting,
            changed: false
        }
    );
}

#[test]
fn a_field_added_at_an_index_and_moved_lands_in_place() {
    let three = obj(json!({"t": 1, "fields": [{"name": "A"}, {"name": "B"}, {"name": "C"}]}));
    let added = applied(
        Some(&three),
        SchemaEdit::AddField {
            field: field(" D "),
            index: Some(1),
        },
        "x",
    )
    .unwrap();
    assert_eq!(
        added.next["fields"],
        json!([{"name": "A"}, {"name": "D"}, {"name": "B"}, {"name": "C"}])
    );
    let moved = applied(
        Some(&three),
        SchemaEdit::MoveField {
            name: "a".into(),
            to_index: 9,
        },
        "x",
    )
    .unwrap();
    assert_eq!(
        moved.next["fields"],
        json!([{"name": "B"}, {"name": "C"}, {"name": "A"}])
    );
    let unrelated =
        obj(json!({"t": 1, "fields": [{"name": "A", "relation": {"target": "p"}, "x": 2}]}));
    let cleared = applied(
        Some(&unrelated),
        SchemaEdit::SetRelation {
            name: "A".into(),
            relation: None,
        },
        "x",
    )
    .unwrap();
    assert_eq!(cleared.next["fields"], json!([{"name": "A", "x": 2}]));
}

#[test]
fn a_canonical_field_name_reuses_a_spelling_that_differs_only_by_case() {
    assert_eq!(
        canonical_field_name(" email ", ["Phone", "Email"]),
        ("Email".to_owned(), true)
    );
    assert_eq!(
        canonical_field_name("Website", ["Phone"]),
        ("Website".to_owned(), false)
    );
}
