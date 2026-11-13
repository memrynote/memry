//! Expected values from Electron's own `resolvePropertyType` and `deserializeValue(serializeValue(..))`,
//! run over the same inputs with `tsx`.

use super::*;
use crate::markdown::frontmatter::{YamlMap, parse_markdown_note};
use serde_json::json;

/// The frontmatter values of `yaml`, by key.
fn values(yaml: &str) -> YamlMap {
    let parsed = parse_markdown_note(&format!("---\n{yaml}\n---\n")).expect("parses");
    match parsed.frontmatter {
        YamlValue::Map(map) => (*map).clone(),
        other => panic!("not a map: {other:?}"),
    }
}

#[test]
fn types_and_values_match_electrons_index() {
    let yaml = values(concat!(
        "project: x\n",
        "rel: ['memry://note/abc', 'memry://journal/2026-10-07']\n",
        "rel2: ['memry://journal/abc']\n",
        "rel3: []\n",
        "due: 2026-10-07\n",
        "due2: 2026-10-07T10:30:00Z\n",
        "n: 3\nn2: 1.5\nn3: 3\n",
        "b: true\nb2: false\n",
        "s: '2026-02-31'\ns2: '2026-02-32'\ns3: '2026-01-01T24:00:00'\n",
        "s4: '2026-01-01T10:00:00.123Z'\n",
        "u: https://example.com/a b\nu2: ftp://x\n",
        "t: hello\nt2: ' 12 '\nt3: '0x10'\n",
        "a: [x, y]\na2: [x, y]\na3: solo\n",
        "o: { k: 1, at: 2026-10-07 }\n",
        "nul: null\nbig: 1e21\nst: Done\nyes: yes",
    ));
    let defined = [
        ("project", "text"),
        ("rel", "text"),
        ("due", "text"),
        ("n2", "text"),
        ("n3", "multiselect"),
        ("b2", "text"),
        ("t", "number"),
        ("t2", "number"),
        ("t3", "number"),
        ("a2", "multiselect"),
        ("a3", "multiselect"),
        ("nul", "text"),
        ("big", "text"),
        ("st", "status"),
        ("yes", "checkbox"),
    ];
    let expected = [
        ("project", "project", json!(["x"])),
        (
            "rel",
            "relation",
            json!(["memry://note/abc", "memry://journal/2026-10-07"]),
        ),
        ("rel2", "text", json!("[\"memry://journal/abc\"]")),
        ("rel3", "text", json!("[]")),
        ("due", "date", json!("2026-10-07")),
        ("due2", "date", json!("2026-10-07T10:30:00.000Z")),
        ("n", "number", json!(3)),
        ("n2", "text", json!("1.5")),
        ("n3", "multiselect", json!(["3"])),
        ("b", "checkbox", json!(true)),
        ("b2", "text", json!("false")),
        ("s", "date", json!("2026-02-31")),
        ("s2", "text", json!("2026-02-32")),
        ("s3", "date", json!("2026-01-01T24:00:00")),
        ("s4", "date", json!("2026-01-01T10:00:00.123Z")),
        ("u", "url", json!("https://example.com/a b")),
        ("u2", "text", json!("ftp://x")),
        // A value its type cannot show reads as the file's text (2b3a512960).
        ("t", "number", json!("hello")),
        ("t2", "number", json!(12)),
        ("t3", "number", json!(16)),
        ("a", "text", json!("[\"x\",\"y\"]")),
        ("a2", "multiselect", json!(["x", "y"])),
        ("a3", "multiselect", json!(["solo"])),
        (
            "o",
            "text",
            json!("{\"k\":1,\"at\":\"2026-10-07T00:00:00.000Z\"}"),
        ),
        ("nul", "text", Value::Null),
        ("big", "text", json!("1e+21")),
        ("st", "status", json!("Done")),
        ("yes", "checkbox", json!("yes")),
    ];
    let defined = |name: &str| {
        defined
            .iter()
            .find(|(n, _)| *n == name)
            .map(|(_, t)| (*t).to_owned())
    };
    let got: Vec<(String, String, Value)> = indexed_properties(yaml.iter(), defined)
        .into_iter()
        .map(|property| (property.name, property.type_name, property.value))
        .collect();
    let want: Vec<(String, String, Value)> = expected
        .into_iter()
        .map(|(name, type_name, value)| (name.to_owned(), type_name.to_owned(), value))
        .collect();
    assert_eq!(got, want);
}

/// Electron's `valueFitsType` over the index's text of each value.
#[test]
fn a_value_fits_its_type_as_electron_decides() {
    let cases = [
        ("number", "5", true),
        ("number", "1.5e3", true),
        ("number", "good", false),
        ("number", "", true),
        ("checkbox", "true", true),
        ("checkbox", "yes", false),
        ("date", "2026-10-07", true),
        ("date", "2026-10-07T10:30:00+02:00", true),
        ("date", "\"2026-10-07T00:00:00.000Z\"", true),
        ("date", "soon", false),
        ("url", "https://example.com", true),
        ("url", "ftp://x", false),
        ("text", "anything", true),
        ("select", "anything", true),
    ];
    for (type_name, text, fits) in cases {
        assert_eq!(value_fits_type(type_name, text), fits, "{type_name} {text}");
    }
}

/// Six levels of ten aliases each: a 250-byte frontmatter that stands for a million values.
fn laughs() -> String {
    let mut yaml = String::from("l0: &l0 [a, b, c, d, e, f, g, h, i, j]\n");
    for level in 1..6 {
        let prev = format!("*l{}", level - 1);
        let refs = [prev.as_str(); 10].join(", ");
        yaml.push_str(&format!("l{level}: &l{level} [{refs}]\n"));
    }
    yaml
}

/// The same as maps: `m0` holds two strings, each next level ten entries naming the last.
fn map_laughs() -> String {
    let mut yaml = String::from("m0: &m0 {a: x, b: y}\n");
    for level in 1..6 {
        let entries: Vec<String> = (0..10)
            .map(|at| format!("k{at}: *m{}", level - 1))
            .collect();
        yaml.push_str(&format!("m{level}: &m{level} {{{}}}\n", entries.join(", ")));
    }
    yaml
}

/// The steps a note's values may take: each node once, plus the alias budget.
fn step_bound(distinct_nodes: usize) -> usize {
    distinct_nodes + ALIAS_NODES_PER_NODE * distinct_nodes + ALIAS_NODES_BASE
}

#[test]
fn nested_list_aliases_expand_until_the_budget_runs_out_and_the_walk_stays_linear() {
    let yaml = values(laughs().trim_end());
    // Six values, and ten items in each of the six lists.
    let nodes = 6 + 6 * 10;
    let mut got = Vec::new();
    memry_test_kit::assert_steps_at_most(
        "list alias expansion",
        json_visits,
        step_bound(nodes),
        || {
            got = indexed_properties(yaml.iter(), |_| None);
        },
    );
    let l0 = "[\"a\",\"b\",\"c\",\"d\",\"e\",\"f\",\"g\",\"h\",\"i\",\"j\"]";
    assert_eq!(got[0].value, json!(l0));
    assert_eq!(got[1].value, json!(format!("[{}]", [l0; 10].join(","))));
    assert!(got[2..].iter().all(|p| p.value.is_null()), "{got:?}");
}

#[test]
fn nested_map_aliases_expand_until_the_budget_runs_out_and_the_walk_stays_linear() {
    let yaml = values(map_laughs().trim_end());
    // Six values, two entries in `m0` and ten in each of the five maps after it.
    let nodes = 6 + 2 + 5 * 10;
    let mut got = Vec::new();
    memry_test_kit::assert_steps_at_most(
        "map alias expansion",
        json_visits,
        step_bound(nodes),
        || {
            got = indexed_properties(yaml.iter(), |_| None);
        },
    );
    // Each level is ten copies of the one before.
    let next = |inner: &str| {
        let entries: Vec<String> = (0..10).map(|at| format!("\"k{at}\":{inner}")).collect();
        format!("{{{}}}", entries.join(","))
    };
    let m0 = "{\"a\":\"x\",\"b\":\"y\"}".to_owned();
    let m1 = next(&m0);
    let m2 = next(&m1);
    let expanded: Vec<&Value> = got[..3].iter().map(|p| &p.value).collect();
    assert_eq!(expanded, [&json!(m0), &json!(m1), &json!(m2)]);
    assert!(got[3..].iter().all(|p| p.value.is_null()), "{got:?}");
}

#[test]
fn an_ordinary_alias_reads_as_electron_reads_it() {
    let yaml = values("a: &x [1]\nb: *x\nc: [*x, *x]\nd: &m {k: v}\ne: [*m, *m]");
    let got: Vec<Value> = indexed_properties(yaml.iter(), |_| None)
        .into_iter()
        .map(|p| p.value)
        .collect();
    assert_eq!(
        got,
        [
            json!("[1]"),
            json!("[1]"),
            json!("[[1],[1]]"),
            json!("{\"k\":\"v\"}"),
            json!("[{\"k\":\"v\"},{\"k\":\"v\"}]"),
        ]
    );
}

#[test]
fn the_deepest_value_the_loader_reads_converts_on_a_small_stack() {
    let depth = crate::markdown::frontmatter::value::MAX_YAML_DEPTH - 2;
    let yaml = format!("deep: {}x{}", "[".repeat(depth), "]".repeat(depth));
    let got =
        memry_test_kit::on_small_stack(move || indexed_properties(values(&yaml).iter(), |_| None));
    assert!(
        got[0]
            .value
            .as_str()
            .is_some_and(|text| text.contains("\"x\""))
    );
}

mod properties {
    use super::*;
    use memry_test_kit::{DEFAULT_CASES, output_bound, proptest_config};
    use proptest::prelude::*;

    fn scalar() -> impl Strategy<Value = String> {
        prop_oneof![
            "[a-z0-9 :./-]{0,12}",
            prop::sample::select(vec![
                "2026-10-07",
                "2026-10-07T10:00:00Z",
                "1e21",
                ".5",
                "0x1F",
                "true",
                "~",
                "'memry://note/a1'",
                "https://x.y",
                "!!binary aGVsbG8=",
                "'\"\"'",
                "-0",
            ])
            .prop_map(str::to_owned),
        ]
    }

    fn value() -> impl Strategy<Value = String> {
        scalar().prop_recursive(4, 24, 4, |inner| {
            prop_oneof![
                prop::collection::vec(inner.clone(), 0..4)
                    .prop_map(|items| format!("[{}]", items.join(", "))),
                prop::collection::vec(("[a-z]{1,3}", inner), 0..3).prop_map(|entries| {
                    let entries: Vec<String> = entries
                        .into_iter()
                        .map(|(k, v)| format!("{k}: {v}"))
                        .collect();
                    format!("{{{}}}", entries.join(", "))
                }),
            ]
        })
    }

    proptest! {
        #![proptest_config(proptest_config(DEFAULT_CASES))]

        #[test]
        fn the_indexed_values_stay_within_the_output_bound(
            entries in prop::collection::vec((value(), prop::sample::select(vec![
                None, Some("text"), Some("number"), Some("checkbox"), Some("multiselect"),
                Some("date"), Some("status"),
            ])), 0..6),
        ) {
            let mut yaml = String::new();
            for (at, (value, _)) in entries.iter().enumerate() {
                yaml.push_str(&format!("k{at}: {value}\n"));
            }
            let raw = format!("---\n{yaml}---\n");
            let Ok(parsed) = parse_markdown_note(&raw) else { return Ok(()) };
            let YamlValue::Map(map) = parsed.frontmatter else { return Ok(()) };
            let defined = |name: &str| {
                let at: usize = name[1..].parse().ok()?;
                entries.get(at)?.1.map(str::to_owned)
            };
            let got = indexed_properties(map.iter(), defined);
            let out: usize = got.iter().map(|p| p.value.to_string().len()).sum();
            prop_assert!(out <= output_bound(raw.len()), "{out} bytes from {}", raw.len());
        }
    }
}
