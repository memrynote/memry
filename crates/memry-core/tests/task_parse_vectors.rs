//! The `task-parsing` committed vector class (spec 004 D1, D5): natural-language
//! task input pinned against `packages/domain-tasks/src/parsing`.
//!
//! Each section gets its own test so a failure names the parser it belongs to.
//! Every case is asserted; mismatches are collected and reported together, one
//! line per case with its input, the expected value and the actual value, so a
//! single run shows the whole gap. The committed JSON is the only input and
//! nothing here recomputes an expectation.

mod support;

use memry_core::domain::calendar::{CivilDate, LocalDateTime};
use memry_core::domain::task_parse::completion::{
    is_time_in_progress, predict_date_completion, predict_time,
};
use memry_core::domain::task_parse::natural_date::parse_natural_date;
use memry_core::domain::task_parse::quick_add::{
    QuickAddProject, find_quick_add_spans, has_special_syntax, parse_quick_add,
    predict_repeat_completion,
};
use memry_core::domain::task_parse::repeat_phrase::{find_repeat_phrase, parse_repeat_phrase};
use serde_json::{Value as Json, json};
use support::{str_field, vector_file};

/// A vector's local wall-clock `now`, `YYYY-MM-DDTHH:MM:SS`.
fn now(text: &str) -> LocalDateTime {
    LocalDateTime::parse(text).unwrap_or_else(|| panic!("`now` is not a local instant: {text}"))
}

/// A section of the `task-parsing` vectors as its case list.
fn cases(vectors: &Json, pointer: &str) -> Vec<Json> {
    vectors
        .pointer(pointer)
        .and_then(Json::as_array)
        .unwrap_or_else(|| panic!("task-parsing has no case list at {pointer}"))
        .clone()
}

/// Panics once, listing every mismatch, when there are any.
fn assert_no_mismatches(section: &str, total: usize, mismatches: &[String]) {
    assert!(
        mismatches.is_empty(),
        "{} of {total} `{section}` cases differ:\n{}",
        mismatches.len(),
        mismatches.join("\n")
    );
}

#[test]
fn natural_date_vectors() {
    let vectors = vector_file("task-parsing");
    let cases = cases(&vectors, "/naturalDate");
    assert!(!cases.is_empty(), "naturalDate has no cases");

    let mut mismatches = Vec::new();
    for case in &cases {
        let input = str_field(case, "input");
        let at = str_field(case, "now");
        let actual = match parse_natural_date(input, now(at)) {
            Ok(parsed) => json!({
                "success": true,
                "date": parsed.date.key(),
                "time": parsed.time,
                "displayText": parsed.display_text,
            }),
            Err(error) => json!({ "success": false, "error": error.message() }),
        };
        if actual != case["expected"] {
            mismatches.push(format!(
                "input {input:?} now {at}: expected {} got {actual}",
                case["expected"]
            ));
        }
    }
    assert_no_mismatches("naturalDate", cases.len(), &mismatches);
}

#[test]
fn completion_date_vectors() {
    let vectors = vector_file("task-parsing");
    let cases = cases(&vectors, "/completion/date");
    assert!(!cases.is_empty(), "completion.date has no cases");

    let mut mismatches = Vec::new();
    for case in &cases {
        let query = str_field(case, "query");
        let at = str_field(case, "now");
        let now = now(at);
        let checks = [
            (
                "predictDateCompletion",
                json!(predict_date_completion(query, now)),
            ),
            ("predictTime", json!(predict_time(query, now))),
            ("isTimeInProgress", json!(is_time_in_progress(query, now))),
        ];
        for (function, actual) in checks {
            if actual != case[function] {
                mismatches.push(format!(
                    "{function}({query:?}) now {at}: expected {} got {actual}",
                    case[function]
                ));
            }
        }
    }
    assert_no_mismatches("completion.date", cases.len(), &mismatches);
}

/// A vector's `YYYY-MM-DD` anchor date.
fn civil_date(key: &str) -> CivilDate {
    CivilDate::parse_key(key).unwrap_or_else(|| panic!("not a date key: {key}"))
}

/// The `quickAddProjects` fixture every `quickAdd` case resolves against.
fn quick_add_projects(vectors: &Json) -> Vec<QuickAddProject> {
    cases(vectors, "/quickAddProjects")
        .iter()
        .map(|project| QuickAddProject {
            id: str_field(project, "id").to_owned(),
            name: str_field(project, "name").to_owned(),
            is_archived: project["isArchived"].as_bool().unwrap_or(false),
        })
        .collect()
}

#[test]
fn repeat_phrase_parse_vectors() {
    let vectors = vector_file("task-parsing");
    let cases = cases(&vectors, "/repeatPhrase/parse");
    assert!(!cases.is_empty(), "repeatPhrase.parse has no cases");

    let mut mismatches = Vec::new();
    for case in &cases {
        let phrase = str_field(case, "phrase");
        let anchor = str_field(case, "anchor");
        let at = str_field(case, "now");
        let actual = parse_repeat_phrase(phrase, civil_date(anchor), now(at))
            .map_or(Json::Null, |config| config.to_wire());
        if actual != case["expected"] {
            mismatches.push(format!(
                "phrase {phrase:?} anchor {anchor} now {at}: expected {} got {actual}",
                case["expected"]
            ));
        }
    }
    assert_no_mismatches("repeatPhrase.parse", cases.len(), &mismatches);
}

#[test]
fn repeat_phrase_find_vectors() {
    let vectors = vector_file("task-parsing");
    let cases = cases(&vectors, "/repeatPhrase/find");
    assert!(!cases.is_empty(), "repeatPhrase.find has no cases");

    let mut mismatches = Vec::new();
    for case in &cases {
        let input = str_field(case, "input");
        let anchor = str_field(case, "anchor");
        let at = str_field(case, "now");
        let actual =
            find_repeat_phrase(input, civil_date(anchor), now(at)).map_or(Json::Null, |found| {
                json!({
                    "start": found.start,
                    "end": found.end,
                    "text": found.text,
                    "config": found.config.to_wire(),
                })
            });
        if actual != case["expected"] {
            mismatches.push(format!(
                "input {input:?} anchor {anchor} now {at}: expected {} got {actual}",
                case["expected"]
            ));
        }
    }
    assert_no_mismatches("repeatPhrase.find", cases.len(), &mismatches);
}

#[test]
fn quick_add_vectors() {
    let vectors = vector_file("task-parsing");
    let projects = quick_add_projects(&vectors);
    let cases = cases(&vectors, "/quickAdd");
    assert!(!cases.is_empty(), "quickAdd has no cases");

    let mut mismatches = Vec::new();
    for case in &cases {
        let input = str_field(case, "input");
        let at = str_field(case, "now");
        let now = now(at);
        let parsed = parse_quick_add(input, &projects, now);
        let spans: Vec<Json> = find_quick_add_spans(input, now)
            .iter()
            .map(|span| json!({ "start": span.start, "end": span.end, "kind": span.kind.as_str() }))
            .collect();
        let actual = json!({
            "title": parsed.title,
            "dueDate": parsed.due_date.map(|date| date.key()),
            "dueTime": parsed.due_time,
            "priority": parsed.priority.name(),
            "projectId": parsed.project_id,
            "repeat": parsed.repeat.map(|config| config.to_wire()),
            "tags": parsed.tags,
            "noteTitles": parsed.note_titles,
            "spans": spans,
            "hasSpecialSyntax": has_special_syntax(input, now),
        });
        if actual != case["expected"] {
            mismatches.push(format!(
                "input {input:?} now {at}: expected {} got {actual}",
                case["expected"]
            ));
        }
    }
    assert_no_mismatches("quickAdd", cases.len(), &mismatches);
}

#[test]
fn completion_repeat_vectors() {
    let vectors = vector_file("task-parsing");
    let cases = cases(&vectors, "/completion/repeat");
    assert!(!cases.is_empty(), "completion.repeat has no cases");

    let mut mismatches = Vec::new();
    for case in &cases {
        let query = str_field(case, "query");
        let actual = json!(predict_repeat_completion(query));
        if actual != case["expected"] {
            mismatches.push(format!(
                "predictRepeatCompletion({query:?}): expected {} got {actual}",
                case["expected"]
            ));
        }
    }
    assert_no_mismatches("completion.repeat", cases.len(), &mismatches);
}
