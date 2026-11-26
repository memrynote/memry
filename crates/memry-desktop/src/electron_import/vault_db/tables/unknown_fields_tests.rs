//! `mergeUnknownPayloadFields` parity. Each expected string is what Electron's function returns
//! for the same three inputs (its body run in Node 22).

use memry_test_kit::{
    DEFAULT_CASES, assert_steps_at_most, on_small_stack, output_bound, proptest_config,
};
use proptest::prelude::*;

use super::super::js_json::{self, JsonError, MAX_DEPTH};
use super::{Merge, merge};

fn merged(payload: &str, fields: &str, nested: Option<&str>) -> String {
    match merge(payload, fields, nested).unwrap() {
        Merge::Merged(text) => text,
        Merge::Ignored => panic!("ignored"),
    }
}

#[test]
fn a_local_key_wins_and_a_kept_key_rides_along_in_spread_order() {
    assert_eq!(
        merged(
            r#"{"name":"t","clock":{"a":1}}"#,
            r#"{"newKey":5,"name":"old"}"#,
            None
        ),
        r#"{"newKey":5,"name":"t","clock":{"a":1}}"#
    );
    assert_eq!(
        merged(r#"{"a":1,"b":9}"#, r#"{"10":1,"b":2,"2":3}"#, None),
        r#"{"2":3,"10":1,"b":9,"a":1}"#
    );
    assert_eq!(
        merged(r#"{"a":1}"#, r#"{"x":1.50,"y":1e21,"z":-0}"#, Some("null")),
        r#"{"x":1.5,"y":1e+21,"z":0,"a":1}"#
    );
}

#[test]
fn a_nested_key_lands_only_in_a_parent_the_payload_still_holds() {
    let nested = r#"[{"path":["cover","blur"],"value":2},{"path":["meta","x"],"value":1},
        {"path":["missing","y"],"value":1},{"path":["cover","url"],"value":"old"},
        {"path":["cover","toString"],"value":1},{"path":["cover","constructor","x"],"value":1},
        {"path":[],"value":1},{"path":["cover",1],"value":1},{"path":["cover","7"],"value":true},
        {"nope":1},{"path":["cover","n"]}]"#;
    assert_eq!(
        merged(r#"{"cover":{"url":"x"},"meta":null}"#, "{}", Some(nested)),
        r#"{"cover":{"7":true,"url":"x","blur":2},"meta":null}"#
    );
    // A remainder that is no array of fields merges the top-level keys only.
    assert_eq!(
        merged(r#"{"a":1}"#, r#"{"x":1}"#, Some(r#"{"path":["a"]}"#)),
        r#"{"x":1,"a":1}"#
    );
}

/// `row.nestedFields ? JSON.parse(row.nestedFields) : []`: an empty text is no nested fields,
/// and the kept `fields` still ride along.
#[test]
fn an_empty_nested_fields_text_still_merges_the_kept_fields() {
    assert_eq!(
        merged(r#"{"a":1}"#, r#"{"x":1}"#, Some("")),
        r#"{"x":1,"a":1}"#
    );
}

#[test]
fn electron_gives_up_on_an_unreadable_remainder_and_this_import_stops_on_one_it_cannot_write() {
    for (fields, nested) in [
        ("not json", None),
        ("[1]", None),
        (r#"{"x":1}"#, Some("oops")),
    ] {
        assert_eq!(
            merge(r#"{"a":1}"#, fields, nested),
            Ok(Merge::Ignored),
            "{fields}"
        );
    }
    assert_eq!(
        merge(r#"{"a":1}"#, r#"{"x":"\ud800"}"#, None),
        Err(JsonError::Unsupported)
    );
}

fn nested_arrays(depth: usize) -> String {
    format!(
        r#"{{"x":{}1{}}}"#,
        "[".repeat(depth - 1),
        "]".repeat(depth - 1)
    )
}

/// Guard: [`js_json::MAX_DEPTH`] (the scan in `js_json::parse`). Without it serde_json's own
/// limit still refuses the text, but the JS-grammar parser then recurses through it.
#[test]
fn deep_remainders_fail_closed_on_a_small_stack() {
    on_small_stack(|| {
        assert!(matches!(
            merge("{}", &nested_arrays(MAX_DEPTH), None),
            Ok(Merge::Merged(_))
        ));
        for depth in [MAX_DEPTH + 1, 200_000] {
            assert_eq!(
                merge("{}", &nested_arrays(depth), None),
                Err(JsonError::Unsupported)
            );
        }
    });
}

/// Every value of the merged payload is converted once: the bound is linear in the input.
#[test]
fn merging_is_linear_in_the_kept_keys() {
    let n = 20_000;
    let fields = format!(
        "{{{}}}",
        (0..n)
            .map(|i| format!(r#""k{i}":{i}"#))
            .collect::<Vec<_>>()
            .join(",")
    );
    let nested = format!(
        "[{}]",
        (0..n)
            .map(|i| format!(r#"{{"path":["o","k{i}"],"value":[{i}]}}"#))
            .collect::<Vec<_>>()
            .join(",")
    );
    assert_steps_at_most("values converted", js_json::visits, 4 * n + 10, || {
        merged(r#"{"o":{}}"#, &fields, Some(&nested));
    });
}

proptest! {
    #![proptest_config(proptest_config(DEFAULT_CASES))]

    #[test]
    fn merge_is_bounded_and_idempotent(
        payload in proptest::collection::btree_map("[a-z0-9]{1,3}", any::<i32>(), 0..8),
        fields in proptest::collection::btree_map("[a-z0-9]{1,3}", "[ -~]{0,8}", 0..8),
        paths in proptest::collection::vec(proptest::collection::vec("[a-z0-9]{1,3}", 1..3), 0..6),
    ) {
        let payload = serde_json::to_string(&payload).unwrap();
        let fields = serde_json::to_string(&fields).unwrap();
        let nested = serde_json::to_string(
            &paths.iter().map(|p| serde_json::json!({ "path": p, "value": 1 })).collect::<Vec<_>>(),
        )
        .unwrap();
        let Merge::Merged(once) = merge(&payload, &fields, Some(&nested)).unwrap() else {
            panic!("ignored");
        };
        prop_assert!(once.len() <= output_bound(payload.len() + fields.len() + nested.len()));
        prop_assert_eq!(merge(&once, &fields, Some(&nested)).unwrap(), Merge::Merged(once.clone()));
    }

    /// A number re-serialises as V8 prints the double it parses to.
    #[test]
    fn numbers_print_as_v8_prints_them(
        mantissa in "-?(0|[1-9][0-9]{0,24})(\\.[0-9]{1,20})?",
        exponent in proptest::option::of(-320i32..320),
    ) {
        let text = match exponent {
            Some(e) => format!("{mantissa}e{e}"),
            None => mantissa,
        };
        let value: f64 = text.parse().unwrap();
        prop_assume!(value.is_finite());
        let expected = crate::web::extract::utils::json::number_to_string(value);
        prop_assert_eq!(js_json::stringify(&js_json::parse(&text).unwrap()), expected);
    }
}
