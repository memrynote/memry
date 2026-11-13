//! Agent fill and writing assist without the model (#3539), on the vectors of Electron's
//! `fill-fields.test.ts` and `writing-assist.ts`: which fields are empty, how the model's
//! answer becomes proposals, how a number is read in the user's locale, and how alternatives
//! are cleaned.

use std::collections::{BTreeMap, HashMap};

use memry_core::domain::tag_objects::Resolved;
use memry_core::domain::tag_objects::search::ObjectMatch;
use memry_core::domain::tag_schema::{Relation, ResolvedField, ResolvedTag};
use memry_desktop::ai::fill_fields::values::{is_calendar_date, parse_locale_number};
use memry_desktop::ai::fill_fields::{
    FillAsk, FillCreate, FillNote, MAX_CANDIDATES, RawProposal, empty_fields, plan, prompt,
    proposals,
};
use memry_desktop::ai::writing_assist::{WritingAssistInput, clean_alternatives};
use memry_test_kit::proptest_config;
use proptest::prelude::*;
use serde_json::{Map, Value, json};

const BODY: &str = "Met at the Globex offsite. She runs engineering there as CTO and wants a field-team pilot in June. Reach her at elif@globex.io.";

fn field(name: &str, type_name: &str, target: Option<&str>) -> ResolvedField {
    ResolvedField {
        name: name.to_owned(),
        type_name: type_name.to_owned(),
        options: None,
        show_on_calendar: None,
        relation: (type_name == "relation").then(|| Relation {
            target: target.map(str::to_owned),
            many: false,
            inverse: None,
        }),
        defined_by: "person".to_owned(),
    }
}

fn tag(key: &str, fields: Vec<ResolvedField>, ancestors: &[&str]) -> ResolvedTag {
    ResolvedTag {
        name: key.to_owned(),
        key: key.to_owned(),
        color: "sky".to_owned(),
        icon: None,
        editable: true,
        own_fields: fields.clone(),
        inherited: Vec::new(),
        has_fields: !fields.is_empty(),
        effective_fields: fields,
        extends: ancestors.first().map(|a| (*a).to_owned()),
        ancestors: ancestors.iter().map(|a| (*a).to_owned()).collect(),
        template: None,
        preset: None,
        own_preset: None,
    }
}

fn person_fields() -> Vec<ResolvedField> {
    vec![
        field("Company", "relation", Some("company")),
        field("Role", "text", None),
        field("Email", "text", None),
        field("Phone", "text", None),
    ]
}

fn resolved() -> Resolved {
    let mut resolved = BTreeMap::new();
    resolved.insert("person".to_owned(), tag("person", person_fields(), &[]));
    resolved
}

fn note(properties: Value) -> FillNote {
    FillNote {
        title: "Elif Demir".to_owned(),
        content: format!("  {BODY}\n"),
        header_tags: vec!["person".to_owned()],
        properties: properties.as_object().cloned().unwrap_or_else(Map::new),
    }
}

fn object(id: &str, title: &str) -> ObjectMatch {
    ObjectMatch {
        note_id: id.to_owned(),
        title: title.to_owned(),
        tag: "company".to_owned(),
        group_tag: "company".to_owned(),
        via_tag: None,
        subtitle: Vec::new(),
        modified: "2026-01-01".to_owned(),
    }
}

fn names(fields: &[ResolvedField]) -> Vec<&str> {
    fields.iter().map(|f| f.name.as_str()).collect()
}

fn raw(field: &str, value: &str, source: &str) -> RawProposal {
    RawProposal {
        field: field.to_owned(),
        value: value.to_owned(),
        source_text: source.to_owned(),
    }
}

fn ask_with(objects: Vec<ObjectMatch>) -> FillAsk {
    plan::<()>(
        Some(note(json!({ "Phone": "" }))),
        &resolved(),
        None,
        |_| Ok(objects.clone()),
    )
    .unwrap()
    .expect("an ask")
}

#[test]
fn empty_fields_are_the_unfilled_fillable_fields_of_the_header_tags_once_each() {
    let mut resolved = resolved();
    let mut extra = vec![
        field("Role", "text", None),
        field("Done", "checkbox", None),
        field("Anyone", "relation", None),
        field("Met", "date", None),
    ];
    extra[0].defined_by = "lead".to_owned();
    resolved.insert("lead".to_owned(), tag("lead", extra, &["person"]));
    resolved.insert("plain".to_owned(), tag("plain", Vec::new(), &[]));
    let mut note = note(json!({ "Role": "  ", "Email": "e@x.io", "Company": [] }));
    note.header_tags = vec![
        "Person".into(),
        "lead".into(),
        "plain".into(),
        "gone".into(),
    ];

    let all = empty_fields(&note, &resolved, None);
    assert_eq!(names(&all), ["Company", "Role", "Phone", "Met"]);
    // Only `lead`, which extends `person`, or `person` with its descendants.
    assert_eq!(
        names(&empty_fields(&note, &resolved, Some("lead"))),
        ["Role", "Met"]
    );
    assert_eq!(
        names(&empty_fields(&note, &resolved, Some("PERSON"))),
        ["Company", "Role", "Phone", "Met"]
    );
}

#[test]
fn plan_stops_without_a_note_an_empty_field_or_a_body_and_searches_each_target_once() {
    let none = |_: &str| -> Result<Vec<ObjectMatch>, ()> { panic!("no search") };
    assert!(plan(None, &resolved(), None, none).unwrap().is_none());
    let filled = json!({ "Company": ["memry://note/x"], "Role": "a", "Email": "b", "Phone": "c" });
    assert!(
        plan(Some(note(filled)), &resolved(), None, none)
            .unwrap()
            .is_none()
    );
    let mut blank = note(json!({}));
    blank.content = " \n ".to_owned();
    assert!(
        plan(Some(blank), &resolved(), None, none)
            .unwrap()
            .is_none()
    );

    let mut searched = Vec::new();
    let many: Vec<ObjectMatch> = (0..MAX_CANDIDATES + 5)
        .map(|n| object(&format!("n{n}"), &format!("Co {n}")))
        .collect();
    let ask = plan::<()>(Some(note(json!({}))), &resolved(), None, |target| {
        searched.push(target.to_owned());
        Ok(many.clone())
    })
    .unwrap()
    .unwrap();
    assert_eq!(searched, ["company"]);
    assert_eq!(ask.candidates["company"].len(), MAX_CANDIDATES);
    assert_eq!(ask.body, BODY);
    assert_eq!(
        plan(Some(note(json!({}))), &resolved(), None, |_| Err("down")).err(),
        Some("down")
    );
}

#[test]
fn proposals_follow_the_panel_order_and_keep_only_quotes_from_the_note() {
    let ask = ask_with(vec![object("n-globex", "Globex")]);
    let got = proposals(
        &ask,
        vec![
            raw("Email", "elif@globex.io", "not in the note"),
            raw("Company", "Globex", "Met at the Globex offsite."),
            raw(" role ", "CTO", " She runs engineering there as CTO "),
            raw("Role", "Founder", ""),
            raw("Unknown", "x", ""),
            raw("Phone", "  ", ""),
        ],
        "en",
    );
    let shown: Vec<(&str, Value, &str, &str)> = got
        .iter()
        .map(|p| {
            (
                p.field.as_str(),
                p.value.clone(),
                p.display.as_str(),
                p.source_text.as_str(),
            )
        })
        .collect();
    assert_eq!(
        shown,
        [
            (
                "Company",
                json!(["memry://note/n-globex"]),
                "Globex",
                "Met at the Globex offsite."
            ),
            (
                "Role",
                json!("CTO"),
                "CTO",
                "She runs engineering there as CTO"
            ),
            ("Email", json!("elif@globex.io"), "elif@globex.io", ""),
        ]
    );
}

#[test]
fn the_prompt_holds_the_note_but_never_another_note_title() {
    let ask = ask_with(vec![
        object("n-globex", "Globex"),
        object("n-i", "Initech Holdings"),
    ]);
    let text = prompt(&ask);
    assert!(text.contains("elif@globex.io"));
    assert!(text.contains("- \"Company\" (relation); the name of a #company"));
    assert!(!text.contains("Initech"));
}

#[test]
fn a_relation_nobody_matches_offers_to_create_it_and_a_bad_value_is_dropped() {
    let mut ask = ask_with(Vec::new());
    ask.fields.push(field("Met", "date", None));
    let mut seats = field("Seats", "number", None);
    seats.name = "Seats".to_owned();
    ask.fields.push(seats);
    let mut stage = field("Stage", "select", None);
    stage.options = Some(json!([{ "value": "Lead" }, { "value": "Won" }]));
    ask.fields.push(stage);
    let mut tags = field("Areas", "multiselect", None);
    tags.options = Some(json!([{ "value": "Ops" }, { "value": "Eng" }]));
    ask.fields.push(tags);
    let candidates: HashMap<String, Vec<ObjectMatch>> = HashMap::new();
    ask.candidates = candidates;

    let got = proposals(
        &ask,
        vec![
            raw("Company", "Globex", ""),
            raw("Met", "2026-02-30", ""),
            raw("Seats", "1,5", ""),
            raw("Stage", "won", ""),
            raw("Areas", "eng, nope, OPS", ""),
        ],
        "en",
    );
    assert_eq!(got.len(), 3);
    assert_eq!(got[0].value, Value::Null);
    assert_eq!(
        got[0].create,
        Some(FillCreate {
            title: "Globex".to_owned(),
            tag: "company".to_owned()
        })
    );
    assert_eq!(
        (got[1].field.as_str(), &got[1].value),
        ("Stage", &json!("Won"))
    );
    assert_eq!(
        (got[2].value.clone(), got[2].display.as_str()),
        (json!(["Eng", "Ops"]), "Eng, Ops")
    );

    let seats = proposals(&ask, vec![raw("Seats", "1.500", "")], "tr");
    assert_eq!(seats[0].value, json!(1500.0));
    assert_eq!(seats[0].display, "1.500");
}

#[test]
fn a_number_is_read_the_way_the_locale_writes_it() {
    let cases = [
        ("1,500", "en", Some(1500.0)),
        ("1,234.5", "en", Some(1234.5)),
        ("1.500", "tr", Some(1500.0)),
        ("1,5", "tr", Some(1.5)),
        ("1.5", "tr", Some(1.5)),
        ("-42", "en", Some(-42.0)),
        ("\u{2212}7", "en", Some(-7.0)),
        ("1.234.567,25", "de-DE", Some(1_234_567.25)),
        ("1\u{202f}234,5", "fr", Some(1234.5)),
        ("1 234 567", "fr", Some(1_234_567.0)),
        ("12,5", "fr", Some(12.5)),
        ("1,500", "pt_BR", Some(1.5)),
        ("1,5", "en", None),
        ("12,34,5", "en", None),
        ("about 3", "en", None),
        ("1.2.3", "de", None),
        ("", "en", None),
        ("-", "en", None),
        ("1e5", "en", None),
        ("Infinity", "en", None),
        ("\u{0661}\u{0662}", "ar", None),
    ];
    for (text, locale, expected) in cases {
        assert_eq!(
            parse_locale_number(text, locale),
            expected,
            "{text:?} in {locale}"
        );
    }
}

/// `n` written with `group` every three digits and `decimal` before `cents`.
fn written(n: u64, cents: Option<u8>, group: &str, decimal: char) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (at, c) in digits.chars().enumerate() {
        if at > 0 && (digits.len() - at).is_multiple_of(3) {
            out.push_str(group);
        }
        out.push(c);
    }
    if let Some(cents) = cents {
        out.push(decimal);
        out.push_str(&format!("{cents:02}"));
    }
    out
}

proptest! {
    #![proptest_config(proptest_config(256))]

    #[test]
    fn a_number_the_locale_writes_reads_back(
        n in 0u64..10_000_000_000,
        cents in proptest::option::of(0u8..100),
        locale in prop::sample::select(vec!["en", "de", "tr", "fr"]),
    ) {
        let (group, decimal) = match locale {
            "en" => (",", '.'),
            "fr" => ("\u{202f}", ','),
            _ => (".", ','),
        };
        let text = written(n, cents, group, decimal);
        let expected = n as f64 + f64::from(cents.unwrap_or(0)) / 100.0;
        let got = parse_locale_number(&text, locale);
        prop_assert!(got.is_some_and(|got| (got - expected).abs() < 1e-6), "{text} {got:?}");
    }

    #[test]
    fn any_text_reads_as_a_finite_number_or_nothing(text in "\\PC{0,40}", locale in "[a-z]{2}") {
        if let Some(number) = parse_locale_number(&text, &locale) {
            prop_assert!(number.is_finite());
        }
    }
}

#[test]
fn a_date_names_a_real_day() {
    for day in [
        "2026-01-31",
        "2024-02-29",
        "2000-02-29",
        "2026-12-01",
        "0100-01-01",
    ] {
        assert!(is_calendar_date(day), "{day}");
    }
    for day in [
        "2026-02-30",
        "2023-02-29",
        // `Date.UTC` reads these as 1900 to 1999.
        "0000-01-01",
        "0050-06-15",
        "0099-12-31",
        "1900-02-29",
        "2026-13-01",
        "2026-00-10",
        "2026-01-00",
        "2026-1-01",
        "2026-01-01x",
        "2026/01/01",
        "+026-01-01",
        "２０２６-01-01",
        "",
    ] {
        assert!(!is_calendar_date(day), "{day}");
    }
}

#[test]
fn alternatives_are_trimmed_unquoted_new_and_at_most_five() {
    let candidates: Vec<String> = [
        "  \u{201C}Hi\u{201D} ",
        "Hello",
        "'hey'",
        "\"\"",
        "Hi",
        "a",
        "b",
        "c",
        "d",
    ]
    .map(str::to_owned)
    .to_vec();
    assert_eq!(
        clean_alternatives(&candidates, " Hello "),
        ["Hi", "hey", "a", "b", "c"]
    );
}

#[test]
fn writing_assist_input_is_held_to_the_contract_limits() {
    let input = |text: String, context: String| WritingAssistInput::Alternatives { text, context };
    assert_eq!(
        input("  hi \n".into(), String::new()).validate(),
        Some(input("hi".into(), String::new()))
    );
    assert_eq!(input(" \n ".into(), String::new()).validate(), None);
    // UTF-16 code units, as zod counts: an emoji is two.
    assert!(
        input("x".repeat(4_000), "y".repeat(8_000))
            .validate()
            .is_some()
    );
    assert!(
        input("😀".repeat(2_001), String::new())
            .validate()
            .is_none()
    );
    assert!(input("x".into(), "😀".repeat(4_001)).validate().is_none());
}
