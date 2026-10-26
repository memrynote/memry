//! `redact.json` and `safe-dimension.json`, generated from the TypeScript production
//! functions: every case must come out byte for byte.

use memry_desktop::redact::{
    RedactOptions, is_safe_dimension_value, redact_log_line, redact_sensitive, redact_text,
    salted_hash,
};
use serde_json::{Map, Value};

const REDACT: &str = include_str!("../../../packages/contracts/test-vectors/redact.json");
const SAFE: &str = include_str!("../../../packages/contracts/test-vectors/safe-dimension.json");

fn run<T>(file: &Value, salt: &str, case: &Value, body: impl FnOnce(&RedactOptions) -> T) -> T {
    let _ = file;
    let wire = &case["options"];
    let hasher = |value: &str| salted_hash(salt, value);
    let opts = RedactOptions {
        vault_root: wire["vaultRoot"].as_str(),
        hash: wire["hash"].as_bool().unwrap_or(false).then_some(&hasher),
    };
    body(&opts)
}

#[test]
fn redact_vectors() {
    let file: Value = serde_json::from_str(REDACT).expect("redact.json");
    let salt = file["meta"]["salt"].as_str().expect("salt");
    let mut checked = 0;
    let mut mismatches = Vec::new();

    for case in file["hashes"].as_array().expect("hashes") {
        let got = salted_hash(salt, case["value"].as_str().expect("value"));
        if got != case["expected"] {
            mismatches.push(format!("hash {}: {got}", case["value"]));
        }
        checked += 1;
    }
    for case in file["text"].as_array().expect("text") {
        let input = case["input"].as_str().expect("input");
        let got = run(&file, salt, case, |opts| redact_text(input, opts));
        if case["expected"] != Value::String(got.clone()) {
            mismatches.push(format!(
                "{} {input:?}\n  want {}\n  got  {got:?}",
                case["mode"], case["expected"]
            ));
        }
        checked += 1;
    }
    for case in file["lines"].as_array().expect("lines") {
        let line = &case["input"];
        let empty = Map::new();
        let fields = line["fields"].as_object().unwrap_or(&empty);
        let got = run(&file, salt, case, |opts| {
            redact_log_line(line["message"].as_str().expect("message"), fields, opts)
        });
        let want = &case["expected"];
        if want["message"] != Value::String(got.message.clone())
            || want["fields"] != Value::Object(got.fields.clone())
        {
            mismatches.push(format!("line {line}\n  want {want}\n  got  {:?}", got));
        }
        checked += 1;
    }
    for case in file["sensitive"].as_array().expect("sensitive") {
        let input = case["input"].as_str().expect("input");
        let got = redact_sensitive(input);
        if case["expected"] != Value::String(got.clone()) {
            mismatches.push(format!(
                "sensitive {input:?}\n  want {}\n  got  {got:?}",
                case["expected"]
            ));
        }
        checked += 1;
    }
    assert!(checked >= 300, "the vector file shrank to {checked} cases");
    assert!(
        mismatches.is_empty(),
        "{} mismatches:\n{}",
        mismatches.len(),
        mismatches.join("\n")
    );
}

#[test]
fn safe_dimension_vectors() {
    let file: Value = serde_json::from_str(SAFE).expect("safe-dimension.json");
    let cases = file["cases"].as_array().expect("cases");
    assert!(cases.len() >= 200);
    let wrong: Vec<String> = cases
        .iter()
        .filter(|case| {
            is_safe_dimension_value(case["value"].as_str().expect("value")) != case["expected"]
        })
        .map(|case| format!("{}", case["value"]))
        .collect();
    assert!(
        wrong.is_empty(),
        "{} mismatches: {}",
        wrong.len(),
        wrong.join(", ")
    );
}
