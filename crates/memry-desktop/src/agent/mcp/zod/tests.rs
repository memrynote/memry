//! The walk's untrusted-input guards (`crates/AGENTS.md`, Untrusted-input tests). Tool and
//! desktop arguments come from any local MCP client holding the bearer. Electron's verdicts and
//! texts are held by `tests/agent_mcp.rs` over `examples.json`; these hold the bounds.

use memry_test_kit::{assert_steps_at_most, on_small_stack, proptest_config};
use proptest::prelude::*;
use serde_json::{Value, json};

use super::{DEPTH_MESSAGE, Issue, KEPT_ISSUES, Walker, steps};
use crate::agent::mcp::desktop_args;
use crate::agent::mcp::schemas::{MAX_ISSUES, TOOLS_JSON, catalog};

const EXAMPLES_JSON: &str =
    include_str!("../../../../../../packages/contracts/test-vectors/agent-mcp/examples.json");

/// `tasks-api.ts` `TaskFieldValueSchema` as zod prints it: a recursive union.
fn field_value_schema() -> Value {
    json!({
        "$ref": "#/$defs/value",
        "$defs": { "value": { "anyOf": [
            { "type": "number" },
            { "type": "array", "items": { "$ref": "#/$defs/value" } },
            { "type": "object", "propertyNames": { "type": "string" },
              "additionalProperties": { "$ref": "#/$defs/value" } }
        ] } }
    })
}

fn mentions(issues: &[Issue], message: &str) -> bool {
    issues.iter().any(|issue| {
        issue.message == message || issue.union.iter().any(|option| mentions(option, message))
    })
}

fn nested(levels: usize) -> Value {
    (0..levels).fold(json!(1), |inner, _| json!([inner]))
}

fn task_with_field(value: Value) -> Value {
    json!({
        "operation": "tasks.create",
        "args": [{ "projectId": "p", "title": "t", "fields": { "deep": value } }]
    })
}

/// zod has no depth limit; the walk refuses past `MAX_DEPTH` instead of overflowing the stack.
/// serde_json's parse stops at 128 levels, so the value is built in process.
#[test]
fn a_value_nested_a_thousand_deep_is_refused_on_a_small_stack() {
    on_small_stack(|| {
        let schema = field_value_schema();
        let deep = nested(1_000);
        let outcome = Walker::new(&schema, None).check(&schema, Some(&deep));
        assert!(mentions(&outcome.issues, DEPTH_MESSAGE));
        assert!(
            desktop_args::check("vault_desktop_write", &task_with_field(nested(1_000))).is_err()
        );
    });
}

fn count_nodes(value: &Value) -> usize {
    1 + match value {
        Value::Array(items) => items.iter().map(count_nodes).sum(),
        Value::Object(object) => object.values().map(count_nodes).sum(),
        _ => 0,
    }
}

/// Each value node costs the union's options and its record key once, so the walk is linear in
/// the value: a union that re-ran a nested option would double per level.
#[test]
fn recursive_arguments_cost_steps_linear_in_their_size() {
    let mut filter = json!("status = 'done'");
    let mut group = json!({ "match": "all", "rules": [] });
    let mut field = json!(1);
    for level in 0..20 {
        filter = json!({ "and": [filter, { "not": "x" }], "or": ["y"] });
        group = json!({ "match": "any", "rules": [group, { "field": "title", "op": "contains", "values": ["a"] }] });
        field = json!([field, { "k": level }, "text"]);
    }
    let calls = [
        json!({ "operation": "folderView.setConfig",
                "args": ["Projects", { "views": [{ "name": "v", "filters": filter }] }] }),
        json!({ "operation": "savedFilters.create",
                "args": [{ "name": "n", "config": { "filters": {} }, "expression": group }] }),
        task_with_field(field),
    ];
    for call in calls {
        let size = count_nodes(&call);
        let operation = call["operation"].as_str().unwrap_or_default().to_owned();
        assert_steps_at_most(&operation, steps, 12 * size + 64, || {
            let _ = desktop_args::check("vault_desktop_write", &call);
        });
    }
}

/// A huge wrong array keeps `KEPT_ISSUES` issues and counts the rest, and the reply names
/// `MAX_ISSUES` of them.
#[test]
fn issues_past_the_cap_are_counted_not_kept() {
    let schema = json!({ "type": "array", "items": { "type": "string" } });
    let items = Value::Array(vec![json!(1); 200_000]);
    let outcome = Walker::new(&schema, None).check(&schema, Some(&items));
    assert_eq!(outcome.issues.len(), KEPT_ISSUES);
    assert_eq!(outcome.more, 200_000 - KEPT_ISSUES);

    let spec = catalog().get("vault_bulk_tag_notes").unwrap();
    let mut args = example_args("vault_bulk_tag_notes");
    args["add"] = Value::Array(vec![json!(1); 5_000]);
    let text = spec.parse(args).unwrap_err();
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines.len(), MAX_ISSUES + 1, "{text}");
    assert!(lines[MAX_ISSUES].starts_with("and "), "{text}");
}

fn example_args(tool: &str) -> Value {
    examples()
        .iter()
        .find(|(name, _)| name == tool)
        .map(|(_, args)| args.clone())
        .unwrap_or_default()
}

fn examples() -> Vec<(String, Value)> {
    let file: Value = serde_json::from_str(EXAMPLES_JSON).unwrap_or_default();
    file["tools"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|case| case["variant"] == "example")
        .map(|case| {
            let tool = case["tool"].as_str().unwrap_or_default().to_owned();
            (tool, case["arguments"].clone())
        })
        .collect()
}

/// Every path to a value inside `value`, the root first.
fn paths(value: &Value, at: Vec<Value>, out: &mut Vec<Vec<Value>>) {
    out.push(at.clone());
    let children: Vec<(Value, &Value)> = match value {
        Value::Array(items) => items
            .iter()
            .enumerate()
            .map(|(i, v)| (json!(i), v))
            .collect(),
        Value::Object(object) => object.iter().map(|(k, v)| (json!(k), v)).collect(),
        _ => Vec::new(),
    };
    for (seg, child) in children {
        let mut next = at.clone();
        next.push(seg);
        paths(child, next, out);
    }
}

fn replace(value: &mut Value, path: &[Value], with: Value) {
    let mut current = value;
    for seg in path {
        current = match seg {
            Value::Number(index) => &mut current[index.as_u64().unwrap_or_default() as usize],
            other => &mut current[other.as_str().unwrap_or_default()],
        };
    }
    *current = with;
}

/// The longest `enum` of the tool schemas as zod lists it in a message: the one line a reply
/// takes from the schema rather than the input (`vault_desktop_describe`'s 284 operations).
fn longest_enum_text() -> usize {
    fn walk(node: &Value) -> usize {
        match node {
            Value::Object(object) => {
                let own = object
                    .get("enum")
                    .and_then(Value::as_array)
                    .map_or(0, |values| {
                        values.iter().map(|value| value.to_string().len() + 1).sum()
                    });
                object.values().map(walk).fold(own, usize::max)
            }
            Value::Array(items) => items.iter().map(walk).max().unwrap_or_default(),
            _ => 0,
        }
    }
    walk(&serde_json::from_str(TOOLS_JSON).unwrap_or_default())
}

fn any_json() -> impl Strategy<Value = Value> {
    let leaf = prop_oneof![
        Just(Value::Null),
        any::<bool>().prop_map(Value::from),
        any::<i64>().prop_map(Value::from),
        any::<f64>()
            .prop_filter("finite", |n| n.is_finite())
            .prop_map(Value::from),
        ".{0,40}".prop_map(Value::from),
    ];
    leaf.prop_recursive(4, 64, 8, |inner| {
        prop_oneof![
            prop::collection::vec(inner.clone(), 0..8).prop_map(Value::Array),
            prop::collection::btree_map(".{0,12}", inner, 0..8)
                .prop_map(|map| Value::Object(map.into_iter().collect())),
        ]
    })
}

proptest! {
    #![proptest_config(proptest_config(256))]

    /// An example call with one value replaced (by a random value, or by many copies of one so a
    /// list breaks item by item): the walk answers, and the reply holds at most `MAX_ISSUES`
    /// issues plus a count, each line bounded by the input that produced it and the longest list
    /// of allowed values the schemas hold.
    #[test]
    fn a_mutated_tool_call_gets_a_bounded_reply(
        pick in any::<prop::sample::Index>(),
        at in any::<prop::sample::Index>(),
        with in any_json(),
        copies in 0usize..64,
    ) {
        let cases = examples();
        let (tool, mut args) = cases[pick.index(cases.len())].clone();
        let mut all = Vec::new();
        paths(&args, Vec::new(), &mut all);
        let path = all[at.index(all.len())].clone();
        let with = if copies > 1 { Value::Array(vec![with; copies]) } else { with };
        replace(&mut args, &path, with);
        let input_len = args.to_string().len();
        let schema_text = longest_enum_text() + 256;
        let spec = catalog().get(&tool).unwrap();
        if let Err(text) = spec.parse(args.clone()) {
            let lines: Vec<&str> = text.lines().collect();
            prop_assert!(lines.len() <= MAX_ISSUES + 1, "{} lines", lines.len());
            for line in lines {
                prop_assert!(
                    line.len() <= 2 * input_len + schema_text,
                    "{} bytes from {input_len}",
                    line.len()
                );
            }
        }
        let desktop = json!({ "operation": "tasks.create", "args": [args] });
        let _ = desktop_args::check("vault_desktop_write", &desktop);
    }
}
