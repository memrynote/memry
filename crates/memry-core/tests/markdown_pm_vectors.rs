//! The `markdown-convert/pm-schema.json` conformance file: the memry
//! ProseMirror schema and the content-expression automaton of
//! `prosemirror-model`, as the TypeScript schema produced them.

#![cfg(feature = "markdown")]

mod support;

use memry_core::markdown::pm::schema::{AttrSpec, Default, Excludes, Marks};
use memry_core::markdown::pm::specs::{MARK_SPECS, NODE_SPECS, TOP_NODE};
use memry_core::markdown::pm::{Fragment, Node, NodeTypeId, Schema};
use serde_json::{Value as Json, json};
use support::vector_compare::Failures;
use support::vector_file;

fn number(n: f64) -> Json {
    if n.fract() == 0.0 {
        json!(n as i64)
    } else {
        json!(n)
    }
}

fn attrs_json(attrs: &[AttrSpec]) -> Json {
    attrs
        .iter()
        .map(|a| {
            let default = match a.default {
                Default::Required => json!({"t": "required"}),
                Default::Str(s) => json!({"t": "str", "v": s}),
                Default::Number(n) => json!({"t": "num", "v": number(n)}),
                Default::Bool(b) => json!({"t": "bool", "v": b}),
                Default::Null => json!({"t": "null"}),
                Default::Undefined => json!({"t": "undefined"}),
            };
            json!({"name": a.name, "default": default})
        })
        .collect()
}

fn schema_json(schema: &Schema) -> Json {
    let nodes: Vec<Json> = NODE_SPECS
        .iter()
        .map(|spec| {
            let ty = schema.node_ty(schema.node_type(spec.name).expect("declared"));
            json!({
                "name": spec.name,
                "content": spec.content,
                "marks": if spec.marks == Marks::None { json!("") } else { Json::Null },
                "group": spec.group,
                "inline": spec.inline,
                "atom": spec.atom,
                "code": spec.code,
                "defining": spec.defining,
                "isolating": spec.isolating,
                "selectable": spec.selectable,
                "linebreakReplacement": spec.linebreak_replacement,
                "attrs": attrs_json(spec.attrs),
                "derived": {
                    "isInline": ty.is_inline,
                    "isText": ty.is_text,
                    "isLeaf": ty.is_leaf,
                    "isAtom": ty.is_atom(),
                    "inlineContent": ty.inline_content,
                    "allMarks": ty.all_marks,
                    "hasRequiredAttrs": ty.has_required_attrs,
                    "whitespace": if ty.preserves_whitespace() { "pre" } else { "normal" },
                },
            })
        })
        .collect();
    let marks: Vec<Json> = MARK_SPECS
        .iter()
        .map(|spec| {
            let id = schema.mark_type(spec.name).expect("declared");
            let excludes: Vec<&str> = schema
                .mark_types()
                .filter(|(other, _)| schema.mark_excludes(id, *other))
                .map(|(_, ty)| ty.name)
                .collect();
            json!({
                "name": spec.name,
                "excludes": match spec.excludes {
                    Excludes::Own => "own",
                    Excludes::None => "none",
                    Excludes::All => "all",
                },
                "inclusive": spec.inclusive,
                "attrs": attrs_json(spec.attrs),
                "derived": {"rank": schema.mark_ty(id).rank, "excludesNames": excludes},
            })
        })
        .collect();
    json!({"topNode": TOP_NODE, "nodes": nodes, "marks": marks})
}

/// A child the sweeps generate: `text` is one character, any other type is
/// `createAndFill`.
fn sample(schema: &Schema, name: &str) -> Node {
    if name == "text" {
        return schema.text("x", Vec::new()).expect("text");
    }
    let ty = schema.node_type(name).expect("type");
    schema.create_and_fill(ty).expect("sample node")
}

fn names_json(schema: &Schema, types: Option<Vec<NodeTypeId>>) -> Json {
    types.map_or(Json::Null, |types| {
        Json::Array(
            types
                .iter()
                .map(|ty| json!(schema.node_ty(*ty).name))
                .collect(),
        )
    })
}

fn fill_json(schema: &Schema, fill: Option<Vec<Node>>) -> Json {
    fill.map_or(Json::Null, |nodes| {
        Json::Array(nodes.iter().map(|n| n.to_json(schema)).collect())
    })
}

fn sequence(schema: &Schema, entry: &Json) -> Vec<Node> {
    entry["seq"]
        .as_array()
        .or_else(|| entry["after"].as_array())
        .expect("sequence")
        .iter()
        .map(|name| sample(schema, name.as_str().expect("name")))
        .collect()
}

#[test]
fn the_static_schema_equals_the_typescript_schema() {
    let file = vector_file("markdown-convert/pm-schema");
    let case = &file["cases"][0];
    assert_eq!(case["id"], "pm-schema/schema/memry");
    let expected = &case["expected"]["output"];
    let actual = schema_json(Schema::memry());
    assert_eq!(
        &actual, expected,
        "the Rust schema table differs from the TypeScript schema"
    );
}

#[test]
fn every_mark_excludes_itself_so_none_is_keyed_by_a_hash() {
    let schema = Schema::memry();
    for (id, ty) in schema.mark_types() {
        assert!(
            schema.mark_excludes(id, id),
            "{} does not exclude itself",
            ty.name
        );
    }
}

#[test]
fn content_match_agrees_with_prosemirror_model() {
    let schema = Schema::memry();
    let file = vector_file("markdown-convert/pm-schema");
    let mut failures = Failures::default();
    let mut entries = 0;
    for case in file["cases"].as_array().expect("cases") {
        if case["op"] != "match-sweep" {
            continue;
        }
        let node = case["input"]["node"].as_str().expect("node");
        let start = schema.content_match(schema.node_type(node).expect("type"));
        for entry in case["expected"]["output"].as_array().expect("entries") {
            entries += 1;
            let nodes = sequence(schema, entry);
            let fragment = Fragment::from_array(nodes);
            let matched = start.match_fragment(fragment.nodes(), 0);
            let fill = start.fill_before(fragment.nodes(), false, 0);
            let fill_end = start.fill_before(fragment.nodes(), true, 0);
            let actual = json!({
                "seq": entry["seq"],
                "valid": matched.is_some(),
                "validEnd": matched.is_some_and(|m| m.valid_end()),
                "defaultType": matched
                    .and_then(|m| m.default_type())
                    .map_or(Json::Null, |ty| json!(schema.node_ty(ty).name)),
                "inlineContent": matched.is_some_and(|m| m.inline_content()),
                "fill": fill_json(schema, fill),
                "fillToEnd": fill_json(schema, fill_end),
            });
            let id = format!("{}/{}", case["id"].as_str().unwrap_or(""), entry["seq"]);
            failures.check(
                &id,
                if &actual == entry {
                    Ok(())
                } else {
                    Err(format!("expected {entry}\n  actual   {actual}"))
                },
            );
        }
    }
    println!("pm content-match sweeps: {entries} entries");
    assert!(entries > 500);
    failures.finish("content match");
}

#[test]
fn find_wrapping_agrees_with_prosemirror_model() {
    let schema = Schema::memry();
    let file = vector_file("markdown-convert/pm-schema");
    let mut failures = Failures::default();
    for case in file["cases"].as_array().expect("cases") {
        if case["op"] != "find-wrapping" {
            continue;
        }
        let node = case["input"]["node"].as_str().expect("node");
        let start = schema.content_match(schema.node_type(node).expect("type"));
        for entry in case["expected"]["output"].as_array().expect("entries") {
            let after = Fragment::from_array(sequence(schema, entry));
            let target = schema
                .node_type(entry["target"].as_str().expect("target"))
                .expect("target type");
            let wrapping = start
                .match_fragment(after.nodes(), 0)
                .and_then(|state| state.find_wrapping(target));
            let id = format!(
                "{}/{}/{}",
                case["id"].as_str().unwrap_or(""),
                entry["after"],
                entry["target"]
            );
            let actual = names_json(schema, wrapping);
            failures.check(
                &id,
                if actual == entry["wrapping"] {
                    Ok(())
                } else {
                    Err(format!("expected {} got {actual}", entry["wrapping"]))
                },
            );
        }
    }
    println!("pm find-wrapping probes: {}", failures.checked());
    failures.finish("findWrapping");
}
