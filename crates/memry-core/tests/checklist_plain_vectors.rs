//! `markAddedChecklistLinesPlain` against the TypeScript, case by case, from
//! `fixtures/checklist-plain.json` (`fixtures/gen-checklist-plain-vectors.mjs`).

#![cfg(feature = "markdown")]

use memry_core::markdown::shared::checklist_plain::mark_added_checklist_lines_plain;
use serde_json::Value;

#[test]
fn every_marking_equals_electrons() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/checklist-plain.json")).unwrap();
    let cases = fixture["cases"].as_array().unwrap();
    assert!(cases.len() > 300);
    for case in cases {
        let (markdown, previous) = (
            case["markdown"].as_str().unwrap(),
            case["previous"].as_str().unwrap(),
        );
        assert_eq!(
            mark_added_checklist_lines_plain(markdown, previous),
            case["output"].as_str().unwrap(),
            "{markdown:?} over {previous:?}"
        );
    }
}
