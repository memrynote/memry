//! The journal name rules equal Electron's, case by case (`fixtures/journal-format.json`,
//! produced by `fixtures/gen-journal-vectors.mjs` from `journal-format.ts` and
//! `journal-format-migration.ts`).

use memry_desktop::vault::journal_format::{
    JournalDate, JournalDays, format_journal_filename, normalize_journal_date_format,
    normalize_journal_folder, parse_journal_date,
};
use memry_desktop::vault::journal_rename::{
    JournalRenamePlan, SkipReason, is_complete_journal_format, plan_journal_renames,
};
use serde_json::Value;

fn load() -> Value {
    serde_json::from_str(include_str!("fixtures/journal-format.json")).expect("vector file")
}

fn text(case: &Value, key: &str) -> String {
    case[key].as_str().expect(key).to_owned()
}

fn parsed(case: &Value) -> Option<String> {
    case["parsed"].as_str().map(str::to_owned)
}

#[test]
fn every_date_renders_and_parses_back_as_electron_does() {
    let vectors = load();
    let cases = vectors["render"].as_array().expect("render");
    assert!(cases.len() > 200);
    for case in cases {
        let (format, date) = (text(case, "format"), text(case, "date"));
        let stem = format_journal_filename(JournalDate::from_iso(&date).expect("a date"), &format);
        assert_eq!(stem, text(case, "stem"), "{case}");
        let back = parse_journal_date(&stem, &format).map(|date| date.to_string());
        assert_eq!(back, parsed(case), "{case}");
    }
}

#[test]
fn every_name_parses_as_electron_parses_it() {
    let vectors = load();
    for case in vectors["parse"].as_array().expect("parse") {
        let date = parse_journal_date(&text(case, "stem"), &text(case, "format"));
        assert_eq!(date.map(|date| date.to_string()), parsed(case), "{case}");
    }
}

#[test]
fn folders_and_formats_normalize_as_electron_normalizes_them() {
    let vectors = load();
    for case in vectors["normalize"].as_array().expect("normalize") {
        let input = text(case, "input");
        assert_eq!(
            normalize_journal_date_format(&input),
            text(case, "format"),
            "{case}"
        );
        assert_eq!(
            normalize_journal_folder(&input),
            text(case, "folder"),
            "{case}"
        );
    }
}

#[test]
fn a_format_is_complete_when_electron_calls_it_complete() {
    let vectors = load();
    for case in vectors["complete"].as_array().expect("complete") {
        let complete = case["complete"].as_bool().expect("complete");
        assert_eq!(
            is_complete_journal_format(&text(case, "format")),
            complete,
            "{case}"
        );
    }
}

fn plan_json(plan: &JournalRenamePlan) -> Value {
    let renames: Vec<Value> = plan
        .renames
        .iter()
        .map(|r| serde_json::json!({ "from": r.from, "to": r.to, "date": r.date.to_string() }))
        .collect();
    let skipped: Vec<Value> = plan
        .skipped
        .iter()
        .map(|s| {
            let reason = match s.reason {
                SkipReason::TargetExists => "target-exists",
                SkipReason::Unrepresentable => "unrepresentable",
            };
            serde_json::json!({ "file": s.file, "reason": reason })
        })
        .collect();
    serde_json::json!({ "renames": renames, "skipped": skipped })
}

#[test]
fn every_plan_equals_electrons() {
    let vectors = load();
    for case in vectors["plan"].as_array().expect("plan") {
        let files: Vec<String> = case["files"]
            .as_array()
            .expect("files")
            .iter()
            .map(|f| f.as_str().expect("file").to_owned())
            .collect();
        let plan = plan_journal_renames(&files, &text(case, "from"), &text(case, "to"));
        assert_eq!(plan_json(&plan), case["plan"], "{case}");
    }
}

/// The day a vault path names: a `.md` file right in the journal folder's format, the folder
/// and the format taken as the config holds them (normalized the same way).
#[test]
fn a_path_names_a_day_under_the_journal_folder_in_its_format() {
    let flat = JournalDays::new("journal", "YYYY-MM-DD");
    assert_eq!(
        flat.day_of("journal/2025-01-01.md").as_deref(),
        Some("2025-01-01")
    );
    for path in [
        "journals/2025-01-01.md",
        "journal/2025-01-01.txt",
        "journal/x/2025-01-01.md",
        "journal/Ideas.md",
        "2025-01-01.md",
    ] {
        assert_eq!(flat.day_of(path), None, "{path}");
    }
    assert_eq!(
        JournalDays::new("", "YYYY-MM-DD").day_of("2025-01-01.md"),
        None
    );
    let nested = JournalDays::new("/a/b/", " YYYY\\MMMM/./YYYY-MM-DD ");
    assert_eq!(
        nested.day_of("a/b/2025/January/2025-01-14.md").as_deref(),
        Some("2025-01-14")
    );
    assert_eq!(nested.day_of("a/b/2025-01-14.md"), None);
    assert!(nested.is_of("/a/b/", " YYYY\\MMMM/./YYYY-MM-DD "));
    assert!(!nested.is_of("a/b", "YYYY/MMMM/YYYY-MM-DD"));
}
