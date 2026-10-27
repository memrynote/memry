//! `telemetry-events.json`, generated from `packages/contracts/src/telemetry-api.ts`: the Rust
//! lists must equal the contract's and every sanitizer case must come out the same.

use std::collections::BTreeMap;

use memry_desktop::telemetry::events::{
    DIMENSION_KEYS, EVENT_NAMES, FailureDetail, RESULTS, SURFACES, sanitize_dimensions,
    sanitize_failure, to_safe_token,
};
use serde_json::Value;

const VECTORS: &str =
    include_str!("../../../packages/contracts/test-vectors/telemetry-events.json");

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .expect("array")
        .iter()
        .map(|v| v.as_str().expect("string").to_owned())
        .collect()
}

fn vectors() -> Value {
    serde_json::from_str(VECTORS).expect("vectors parse")
}

#[test]
fn the_closed_lists_equal_the_contract() {
    let v = vectors();
    for (key, rust) in [
        ("eventNames", EVENT_NAMES),
        ("surfaces", SURFACES),
        ("results", RESULTS),
        ("dimensionKeys", DIMENSION_KEYS),
    ] {
        let mut want = strings(&v[key]);
        let mut have: Vec<String> = rust.iter().map(|s| (*s).to_owned()).collect();
        want.sort();
        have.sort();
        assert_eq!(have, want, "{key}");
    }
}

#[test]
fn dimension_cases() {
    for case in vectors()["dimensions"].as_array().expect("cases") {
        let input: Option<BTreeMap<String, String>> =
            serde_json::from_value(case["input"].clone()).expect("input");
        let got = sanitize_dimensions(input.as_ref());
        let want: Option<BTreeMap<String, String>> =
            serde_json::from_value(case["expected"].clone()).expect("expected");
        assert_eq!(got, want, "{}", case["input"]);
    }
}

#[test]
fn failure_cases() {
    for case in vectors()["failures"].as_array().expect("cases") {
        // A wrongly typed field (`"httpStatus": "500"`) is not a value the Rust type can hold.
        let input: Option<FailureDetail> =
            serde_json::from_value(case["input"].clone()).unwrap_or(None);
        let wrong_typed = case["input"].as_object().is_some_and(|o| {
            o.get("httpStatus").is_some_and(|v| !v.is_u64())
                || o.get("serverCode").is_some_and(|v| !v.is_string())
                || o.get("retryable").is_some_and(|v| !v.is_boolean())
        });
        if wrong_typed
            || case["input"].as_object().is_some_and(|o| {
                o.get("httpStatus")
                    .and_then(Value::as_u64)
                    .is_some_and(|n| n > 65535)
            })
        {
            continue;
        }
        let got = sanitize_failure(input.as_ref());
        let want: Option<FailureDetail> =
            serde_json::from_value(case["expected"].clone()).expect("expected");
        assert_eq!(got, want, "{}", case["input"]);
    }
}

#[test]
fn token_cases() {
    for case in vectors()["tokens"].as_array().expect("cases") {
        let fallback = case["fallback"].as_str().expect("fallback");
        let got = match &case["input"] {
            Value::String(text) => to_safe_token(text, fallback),
            // JS stringifies numbers and booleans; everything else takes the fallback.
            number_or_bool @ (Value::Number(_) | Value::Bool(_)) => {
                to_safe_token(&number_or_bool.to_string(), fallback)
            }
            _ => fallback.to_owned(),
        };
        assert_eq!(
            got,
            case["expected"].as_str().expect("expected"),
            "{}",
            case["input"]
        );
    }
}
