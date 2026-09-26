//! `calendar.json` (spec 007 CL011-CL013) through the conformance seam:
//! every apply sequence ends on desktop's row, every range query answers
//! desktop's projection item for item, search ranks as desktop does, and
//! every write emits desktop's record.

use memry_core::api::calendar_conformance::calendar_conformance;
use serde_json::Value;

fn run() -> (Value, Value) {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/contracts/test-vectors/calendar.json"
    );
    let text = std::fs::read_to_string(path).expect("calendar.json");
    let file: Value = serde_json::from_str(&text).expect("calendar.json is JSON");
    let out: Value = serde_json::from_str(&calendar_conformance(text)).expect("seam answers JSON");
    assert!(out.get("error").is_none(), "seam failed: {}", out["error"]);
    (file, out)
}

#[test]
fn every_apply_sequence_ends_on_desktops_row() {
    let (file, out) = run();
    let expected = file["apply"].as_array().expect("apply cases");
    let actual = out["apply"].as_array().expect("apply results");
    assert_eq!(expected.len(), actual.len());
    for (want, got) in expected.iter().zip(actual) {
        assert!(
            got.get("error").is_none(),
            "{}: {}",
            want["name"],
            got["error"]
        );
        assert_eq!(got["actual"], want["expected"], "{}", want["name"]);
    }
}

#[test]
fn every_range_query_answers_desktops_projection() {
    let (file, out) = run();
    let queries = file["projection"]["queries"].as_array().expect("queries");
    let actual = out["projection"]["queries"]
        .as_array()
        .expect("query results");
    for (want, got) in queries.iter().zip(actual) {
        let expected = want["expected"].as_array().expect("items");
        let got = got.as_array().expect("items");
        let ids = |items: &[Value]| {
            items
                .iter()
                .map(|i| i["projectionId"].clone())
                .collect::<Vec<_>>()
        };
        assert_eq!(ids(got), ids(expected), "{}: order", want["name"]);
        for (w, g) in expected.iter().zip(got) {
            assert_eq!(g, w, "{}: {}", want["name"], w["projectionId"]);
        }
    }
}

#[test]
fn search_ranks_as_desktop_does() {
    let (file, out) = run();
    let searches = file["projection"]["searches"].as_array().expect("searches");
    let actual = out["projection"]["searches"]
        .as_array()
        .expect("search results");
    for (want, got) in searches.iter().zip(actual) {
        assert_eq!(got, &want["expected"], "search {}", want["query"]);
    }
}

#[test]
fn every_write_emits_desktops_record() {
    let (file, out) = run();
    let writes = &file["writes"];
    let got = &out["writes"];
    assert_eq!(got["create"], writes["create"]["expected"], "create");
    for (want, actual) in writes["updates"]
        .as_array()
        .expect("updates")
        .iter()
        .zip(got["updates"].as_array().expect("updates"))
    {
        assert_eq!(actual, &want["expected"], "{}", want["name"]);
    }
    let promote = &writes["promote"]["expected"];
    assert_eq!(got["promote"]["event"], promote["event"], "promoted event");
    assert_eq!(
        got["promote"]["binding"], promote["binding"],
        "promoted binding"
    );
    assert_eq!(
        got["promote"]["mirror"], promote["mirror"],
        "archived mirror"
    );
    assert_eq!(got["promote"]["repeatReturnsSameEvent"], true);
    assert_eq!(got["promote"]["readOnlyRefused"], true);
    let selection = &writes["selection"]["expected"];
    assert_eq!(
        got["selection"]["source"], selection["source"],
        "selected source"
    );
    assert_eq!(got["selection"]["mirrorDeleted"], true);
    assert_eq!(got["selection"]["bindingDeleted"], true);
}
