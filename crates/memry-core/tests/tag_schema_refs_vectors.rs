//! Conformance for `tag-schema-refs.json` (chapter 13 §13.7.7.2).
mod support;

use memry_core::domain::tag_schema_refs::rewrite_schema_reference;
use serde_json::Value;
use support::vector_file;

#[test]
fn tag_schema_refs_match_the_committed_vectors() {
    let file = vector_file("tag-schema-refs");
    let cases = file["cases"].as_array().expect("cases is an array");
    assert_eq!(
        cases.len() as u64,
        file["meta"]["caseCount"].as_u64().expect("a case count")
    );
    for case in cases {
        let name = case["name"].as_str().expect("named");
        let input = &case["input"];
        let schema = input["schema"].as_object().expect("schema object");
        let got = rewrite_schema_reference(
            schema,
            input["from"].as_str().expect("from"),
            input["to"].as_str(),
        )
        .map_or(Value::Null, Value::Object);
        assert_eq!(got, case["expected"]["schema"], "{name}");
    }
}
