//! `import::obsidian_tasks` against `packages/contracts/test-vectors/importers/obsidian-tasks.json`,
//! which `buildObsidianTaskImport` recorded
//! (`apps/desktop/src/main/import/__vectors__/obsidian-task-import-vectors.test.ts`): every line
//! in UTC and its done date in the other recorded zones, and every line of the Obsidian Tasks
//! plugin's own fixtures through both the line parser and the import (the real-zone done dates
//! run in `obsidian_task_local_zone.rs`, a process of their own). Then the untrusted-input guards of the line parser the import
//! reads through: a hostile line stays linear in steps and bounded in output on a small stack.

use std::fs;

use chrono::{DateTime, FixedOffset, TimeZone, Utc};
use memry_core::markdown::shared::obsidian_tasks::{parse_obsidian_task_line, parse_steps};
use memry_desktop::import::obsidian_tasks::build_obsidian_task_import;
use memry_test_kit::{
    assert_output_bounded, assert_steps_at_most, on_small_stack, output_bound, proptest_config,
};
use proptest::prelude::*;
use serde_json::{Value, json};

const VECTORS: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../packages/contracts/test-vectors/importers/obsidian-tasks.json"
);

fn vectors() -> Value {
    serde_json::from_str(&fs::read_to_string(VECTORS).unwrap()).unwrap()
}

fn now(vectors: &Value) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(vectors["now"].as_str().unwrap())
        .unwrap()
        .with_timezone(&Utc)
}

/// A recorded zone from its `getTimezoneOffset()` (minutes behind UTC).
fn fixed_zone(zone: &Value) -> (String, FixedOffset) {
    let behind = zone["offset"].as_i64().unwrap();
    let offset = FixedOffset::west_opt(i32::try_from(behind * 60).unwrap()).unwrap();
    (zone["zone"].as_str().unwrap().to_owned(), offset)
}

fn completed_at<Tz: TimeZone>(text: &str, now: DateTime<Utc>, tz: &Tz) -> Value {
    build_obsidian_task_import(text, now, tz)
        .and_then(|import| import.completed_at)
        .map_or(Value::Null, Value::String)
}

#[test]
fn every_line_matches_the_typescript() {
    let vectors = vectors();
    let now = now(&vectors);
    let zones: Vec<_> = vectors["zones"]
        .as_array()
        .unwrap()
        .iter()
        .map(fixed_zone)
        .collect();
    assert_eq!(zones[0].1, FixedOffset::east_opt(0).unwrap(), "UTC first");

    let mut failures = Vec::new();
    for case in vectors["cases"].as_array().unwrap() {
        let text = case["text"].as_str().unwrap();
        let got = serde_json::to_value(build_obsidian_task_import(text, now, &zones[0].1)).unwrap();
        if got != case["import"] {
            failures.push(format!("{text:?}\n  want {}\n  got  {got}", case["import"]));
        }
        for (name, offset) in &zones[1..] {
            let want = case["completedAt"]
                .get(name)
                .cloned()
                .unwrap_or(Value::Null);
            let got = completed_at(text, now, offset);
            if got != want {
                failures.push(format!("{text:?} in {name}: want {want}, got {got}"));
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// Core's line JSON writes a JS number as an f64 (`1.0`), which `JSON.stringify` writes as `1`.
fn integral_numbers(value: Value) -> Value {
    match value {
        Value::Number(n) => match n.as_f64() {
            Some(x) if n.is_f64() && x.fract() == 0.0 && x >= 0.0 && x < u64::MAX as f64 => {
                json!(x as u64)
            }
            _ => Value::Number(n),
        },
        Value::Array(items) => Value::Array(items.into_iter().map(integral_numbers).collect()),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, inner)| (key, integral_numbers(inner)))
                .collect(),
        ),
        other => other,
    }
}

#[test]
fn the_plugin_fixtures_parse_and_import_as_in_typescript() {
    let vectors = vectors();
    let now = now(&vectors);
    let fixtures = vectors["fixtures"].as_array().unwrap();
    assert_eq!(fixtures.len(), 36, "every fixture line is recorded");
    for case in fixtures {
        let line = case["line"].as_str().unwrap();
        let parsed = parse_obsidian_task_line(line).map_or(Value::Null, |line| line.to_json());
        let parsed = integral_numbers(parsed);
        assert_eq!(parsed, case["parsed"], "{line}");
        let import = case["text"].as_str().map_or(Value::Null, |text| {
            serde_json::to_value(build_obsidian_task_import(text, now, &Utc)).unwrap()
        });
        assert_eq!(import, case["import"], "{line}");
    }
}

/// The fixed instant the guards build with.
fn guard_now() -> DateTime<Utc> {
    DateTime::from_timestamp_millis(1_772_616_600_000).unwrap()
}

/// Every pass of the strip loop scans at most this many rules: 11 emoji, 11 dataview, 1 tag.
const SCANS_PER_PASS: usize = 23;
/// The strip loop stops after this many passes, as `obsidian-tasks.ts` does.
const MAX_PASSES: usize = 21;

#[test]
fn many_distinct_tags_are_deduplicated_in_linear_steps() {
    let tags = 5_000;
    let line: String = (0..tags).map(|i| format!("#t{i} ")).collect::<String>() + "📅 2026-01-01";
    assert_steps_at_most(
        "tag dedupe",
        parse_steps,
        tags + MAX_PASSES * SCANS_PER_PASS + 16,
        || {
            let import = build_obsidian_task_import(&line, guard_now(), &Utc).unwrap();
            assert_eq!(import.tags.len(), tags);
        },
    );
}

#[test]
fn fields_interleaved_with_tags_stop_after_the_last_pass() {
    // Each pass peels one `⏫` and one tag off the end, so without the pass cap a line of n
    // pairs takes n passes over the whole line.
    let pairs = 5_000;
    let line = "x".to_owned() + &" ⏫ #a".repeat(pairs);
    assert_steps_at_most(
        "strip passes",
        parse_steps,
        MAX_PASSES * SCANS_PER_PASS + pairs + 16,
        || {
            let import = build_obsidian_task_import(&line, guard_now(), &Utc).unwrap();
            assert_eq!(import.priority, Some(3));
        },
    );
}

#[test]
fn a_huge_hostile_line_imports_on_a_small_stack_within_the_output_bound() {
    let mut line = String::new();
    while line.len() < 4 * 1024 * 1024 {
        line.push_str("[[((#a ⏫ [due:: 2026-01-01] (repeat:: every 2 days) 🔁 every ");
    }
    line.push_str("📅 2026-01-01 ✅ 2026-02-30");
    let len = line.len();
    let import = on_small_stack(move || build_obsidian_task_import(&line, guard_now(), &Utc))
        .expect("the line carries a due date");
    assert_eq!(import.due_date.as_deref(), Some("2026-01-01"));
    assert_eq!(import.completed_at, None, "2026-02-30 is not a date");
    assert_output_bounded("title", len, import.title.len());
    assert_output_bounded("tags", len, import.tags.iter().map(String::len).sum());
}

fn fragment() -> impl Strategy<Value = String> {
    prop_oneof![
        Just(" ".to_owned()),
        Just("\u{FE0F}".to_owned()),
        Just("^ab".to_owned()),
        Just("::".to_owned()),
        "[ #a-zA-Z0-9]{0,6}",
        "[-0-9]{0,12}",
        prop::sample::select(vec![
            "🔺",
            "⏫",
            "🔼",
            "🔽",
            "⏬",
            "🛫",
            "➕",
            "⏳",
            "⌛",
            "📅",
            "📆",
            "🗓",
            "✅",
            "❌",
            "🔁",
            "🏁",
            "⛔",
            "🆔",
            "[",
            "]",
            "(",
            ")",
            "due::",
            "completion::",
            "repeat::",
            "priority::",
            "every",
            "when done",
            "2026-02-30",
            "2024-02-29",
            "0026-01-01",
        ])
        .prop_map(str::to_owned),
    ]
}

proptest! {
    #![proptest_config(proptest_config(256))]

    #[test]
    fn any_line_imports_without_panicking_within_the_output_bound(
        parts in prop::collection::vec(fragment(), 0..40),
        noise in any::<String>(),
    ) {
        for text in [parts.concat(), noise] {
            if let Some(import) = build_obsidian_task_import(&text, guard_now(), &Utc) {
                prop_assert_eq!(&import.description, &text);
                prop_assert!(import.title.len() <= output_bound(text.len()));
                let tag_bytes: usize = import.tags.iter().map(String::len).sum();
                prop_assert!(tag_bytes <= output_bound(text.len()));
                if let Some(done) = &import.completed_at {
                    prop_assert!(DateTime::parse_from_rfc3339(done).is_ok(), "{}", done);
                }
                let json = serde_json::to_value(&import).unwrap();
                prop_assert_eq!(json["description"].clone(), json!(text));
            }
        }
    }
}
