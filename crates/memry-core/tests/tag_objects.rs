//! The object search and Linked here (#3530 13j-3c) on real `data.db` and `index.db` files,
//! records applied as a pull applies them, the oracle being Electron's `searchObjects` and
//! `getLinkedHere`: only a live markdown note that is not a journal day is an object, equal
//! matches list newest first, then by id, and a trashed note links nothing.

#![cfg(feature = "markdown")]

use std::collections::BTreeMap;

use memry_core::domain::note_files::NoteFileStat;
use memry_core::domain::note_stats::MeasuredFile;
use memry_core::domain::property_values::IndexedProperty;
use memry_core::domain::tag_objects::LinkedGroup;
use memry_core::domain::tag_schema::{DefinitionInput, PropertyInfo, StoredSchema, resolve};
use serde_json::json;

use crate::tag_reads::{filed, measured, note, open, record};

#[test]
fn only_live_markdown_notes_that_are_not_days_are_found_ties_by_id() {
    let (_dir, vault, search) = open();
    let person = "---\ntags: [Person]\n---\n";
    for (id, title, modified) in [
        ("b-same", "Ada Two", "2026-01-02T00:00:00.000Z"),
        ("a-same", "Ada One", "2026-01-02T00:00:00.000Z"),
        ("newest", "Ada Newest", "2026-01-03T00:00:00.000Z"),
        ("gone", "Ada Gone", "2026-01-04T00:00:00.000Z"),
    ] {
        note(&vault, id, title, &[], modified);
        filed(&vault, id, &format!("{title}.md"));
        measured(&search, id, person);
    }
    // Trashed after it was filed and measured: its file and index rows outlive the record.
    record(&vault, "note", "gone", json!({"title": "Ada Gone"}), true);
    // A journal day whose file's header carries the tag.
    let day = json!({"date": "2026-01-05", "clock": {"peer": 1}, "modifiedAt": "2026-01-05T09:00:00.000Z"});
    record(&vault, "journal", "j2026-01-05", day, false);
    filed(&vault, "j2026-01-05", "journal/2026-01-05.md");
    measured(&search, "j2026-01-05", person);
    // A PDF the index measured with a header: not markdown, so no object.
    note(&vault, "scan", "Ada Scan", &[], "2026-01-06T00:00:00.000Z");
    vault
        .note_files()
        .upsert_stat(NoteFileStat {
            note_id: "scan".to_owned(),
            path: "Ada Scan.pdf".to_owned(),
            file_type: "pdf".to_owned(),
            mime_type: Some("application/pdf".to_owned()),
            file_size: Some(1),
            content_hash: None,
            file_hash: None,
            indexed_at: 1,
        })
        .expect("row");
    search
        .index_note_files(vec![MeasuredFile {
            note_id: "scan".to_owned(),
            file_hash: "hash-scan".to_owned(),
            text: person.to_owned(),
            properties: Vec::new(),
        }])
        .expect("measured");

    let definitions = BTreeMap::from([(
        "person".to_owned(),
        DefinitionInput {
            name: "person".to_owned(),
            color: "blue".to_owned(),
            icon: None,
            schema: StoredSchema::parse(Some(&json!({"t": 1, "fields": [{"name": "Role"}]}))),
        },
    )]);
    let resolved = resolve(&definitions, &|_| None::<PropertyInfo>);
    for query in ["", "ada"] {
        let found = search
            .search_objects(&resolved, query, Some("person"), 10)
            .expect("search");
        let shown: Vec<(&str, &str)> = found
            .iter()
            .map(|m| (m.note_id.as_str(), m.modified.as_str()))
            .collect();
        assert_eq!(
            shown,
            [
                ("newest", "2026-01-03T00:00:00.000Z"),
                ("a-same", "2026-01-02T00:00:00.000Z"),
                ("b-same", "2026-01-02T00:00:00.000Z"),
            ],
            "query {query:?}"
        );
    }
}

#[test]
fn a_trashed_note_whose_relation_links_the_note_is_not_listed() {
    let (_dir, vault, search) = open();
    note(&vault, "acme", "Acme", &[], "2026-01-01T00:00:00.000Z");
    filed(&vault, "acme", "Acme.md");
    let company = r#"["memry://note/acme"]"#;
    for id in ["ada", "gone"] {
        note(&vault, id, id, &[], "2026-01-02T00:00:00.000Z");
        filed(&vault, id, &format!("{id}.md"));
        search
            .index_note_files(vec![MeasuredFile {
                note_id: id.to_owned(),
                file_hash: format!("hash-{id}"),
                text: format!("---\ntags: [person]\nCompany: {company}\n---\n"),
                properties: vec![IndexedProperty {
                    name: "Company".to_owned(),
                    type_name: "relation".to_owned(),
                    text: Some(company.to_owned()),
                    value: json!(["memry://note/acme"]),
                }],
            }])
            .expect("measured");
    }
    // Trashed after it was measured: its property rows outlive the record.
    record(&vault, "note", "gone", json!({"title": "gone"}), true);

    let schema =
        json!({"t": 1, "fields": [{"name": "Company", "relation": {"target": "company"}}]});
    let definitions = BTreeMap::from([(
        "person".to_owned(),
        DefinitionInput {
            name: "person".to_owned(),
            color: "blue".to_owned(),
            icon: None,
            schema: StoredSchema::parse(Some(&schema)),
        },
    )]);
    let resolved = resolve(&definitions, &|_| None::<PropertyInfo>);
    let groups = search
        .linked_here(&resolved, "acme", 5)
        .expect("linked here");
    let listed: Vec<(&str, Vec<&str>)> = groups
        .iter()
        .map(|group| match group {
            LinkedGroup::Relation {
                source_tag, items, ..
            } => (
                source_tag.as_str(),
                items.iter().map(|item| item.note_id.as_str()).collect(),
            ),
            other => panic!("a relation group: {other:?}"),
        })
        .collect();
    assert_eq!(listed, [("person", vec!["ada"])]);
}
