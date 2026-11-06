use std::collections::{BTreeMap, HashMap};

use serde_json::{Value, json};

use super::search::{Candidate, fold_for_search, members, ranked, subtitle};
use super::*;
use crate::domain::tag_schema::{DefinitionInput, PropertyInfo, StoredSchema, resolve};

fn tags() -> Resolved {
    let def = |name: &str, schema: Value| {
        let input = DefinitionInput {
            name: name.to_owned(),
            color: "blue".to_owned(),
            icon: None,
            schema: StoredSchema::parse(Some(&schema)),
        };
        (name.to_owned(), input)
    };
    let definitions: BTreeMap<String, DefinitionInput> = [
        def(
            "person",
            json!({"t": 1, "fields": [{"name": "Role"}, {"name": "Company", "relation": {"target": "company"}}]}),
        ),
        def("employee", json!({"t": 1, "extends": "person", "fields": [{"name": "Team"}]})),
        def("company", json!({"t": 1, "fields": [{"name": "Website"}]})),
        def("person/vip", Value::Null),
    ]
    .into_iter()
    .collect();
    resolve(&definitions, &|_| None::<PropertyInfo>)
}

fn candidate(id: &str, title: &str, modified: &str) -> Candidate {
    Candidate {
        id: id.to_owned(),
        title: title.to_owned(),
        modified: modified.to_owned(),
        tag: "person".to_owned(),
    }
}

#[test]
fn search_folds_case_diacritics_and_both_turkish_is() {
    assert_eq!(fold_for_search("İlker Şahin"), "ilker sahin");
    assert_eq!(fold_for_search("Işık"), "isik");
    assert_eq!(fold_for_search("ISIK"), "isik");
    assert_eq!(fold_for_search("Crème Brûlée"), "creme brulee");
}

#[test]
fn a_title_start_beats_a_word_start_beats_a_substring_then_newest_first() {
    let found = ranked(
        vec![
            candidate("inner", "Teacher", "2026-03-01T00:00:00.000Z"),
            candidate("word", "Big Each", "2026-02-01T00:00:00.000Z"),
            candidate("old", "Each one", "2026-01-01T00:00:00.000Z"),
            candidate("new", "Ëach two", "2026-04-01T00:00:00.000Z"),
            candidate("none", "Other", "2026-05-01T00:00:00.000Z"),
        ],
        "  each ",
        10,
    );
    let ids: Vec<&str> = found.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(ids, ["new", "old", "word", "inner"]);
    assert_eq!(
        ranked(found, "", 2).len(),
        2,
        "an empty query lists all, cut at the limit"
    );
}

#[test]
fn a_family_holds_the_tags_that_extend_it_and_a_tag_without_fields_has_none() {
    let resolved = tags();
    let mut family = family_of("Person", &resolved).unwrap();
    family.sort();
    assert_eq!(family, ["employee", "person"]);
    assert_eq!(family_of("person/vip", &resolved), None);
    assert_eq!(root_of("employee", &resolved), "person");
    assert_eq!(root_of("company", &resolved), "company");

    let headers = vec![
        (
            "a".to_owned(),
            vec![
                "idea".to_owned(),
                "Employee".to_owned(),
                "person".to_owned(),
            ],
        ),
        ("b".to_owned(), vec!["idea".to_owned()]),
    ];
    let first = members(headers, &family);
    assert_eq!(
        first,
        HashMap::from([("a".to_owned(), "employee".to_owned())])
    );
}

#[test]
fn a_subtitle_is_the_first_text_field_then_the_first_linked_title() {
    let resolved = tags();
    let values = HashMap::from([
        ("Role".to_owned(), json!("Engineer")),
        (
            "Company".to_owned(),
            json!(["memry://note/gone", "memry://note/acme"]),
        ),
        ("Team".to_owned(), json!(7)),
    ]);
    let title_of = |id: &str| (id == "acme").then(|| "Acme".to_owned());
    assert_eq!(
        subtitle(&values, resolved.get("employee"), title_of),
        ["Engineer", "Acme"]
    );
    let no_link = HashMap::from([
        ("Role".to_owned(), json!("  ")),
        ("Team".to_owned(), json!(7)),
    ]);
    assert_eq!(
        subtitle(&no_link, resolved.get("employee"), title_of),
        ["7"]
    );
    assert!(subtitle(&values, None, title_of).is_empty());
}

#[test]
fn only_a_list_of_relation_links_links_notes() {
    assert_eq!(
        note_refs(&json!(["memry://note/a", "memry://task/b"])),
        ["a"]
    );
    assert!(note_refs(&json!(["memry://note/a", "plain"])).is_empty());
    assert!(note_refs(&json!("memry://note/a")).is_empty());
    assert!(note_refs(&json!([])).is_empty());
}
