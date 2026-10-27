//! Untrusted structure that is not markdown: YAML frontmatter and a Yjs doc
//! from a peer. A stack overflow aborts the process, so each case runs on a
//! 2 MiB thread and must fail closed with a typed outcome. Run in release too
//! (`cargo test --release`), where the frames are smaller and the depth that
//! overflows is larger.

#![cfg(feature = "markdown")]

mod support;

use memry_core::markdown::convert::NoEmbeds;
use memry_core::markdown::convert::api::ReplaceOptions;
use memry_core::markdown::convert::apply::ReplaceOutcome;
use memry_core::markdown::frontmatter::{
    Eol, YamlMap, YamlValue, depth_visits, entries_scanned, parse_markdown_note, safe_dump,
    safe_load, stringify_frontmatter_block,
};
use support::doc_case::{converter_for, open_document};

fn on_small_stack(work: impl FnOnce() + Send + 'static) {
    std::thread::Builder::new()
        .stack_size(2 * 1024 * 1024)
        .spawn(work)
        .expect("spawn")
        .join()
        .expect("must not overflow the stack");
}

fn note(yaml: &str) -> String {
    format!("---\n{yaml}\n---\nbody\n")
}

fn yaml_shapes(n: usize) -> Vec<(&'static str, String)> {
    // Indentation makes these shapes quadratic in size; the others stay linear.
    let n_indented = n.min(3_000);
    let block_map: String = (0..n_indented)
        .map(|i| format!("{}k:\n", "  ".repeat(i)))
        .collect::<String>()
        + &"  ".repeat(n_indented)
        + "v";
    let block_seq: String = (0..n_indented)
        .map(|i| format!("{}-\n", "  ".repeat(i)))
        .collect::<String>()
        + &"  ".repeat(n_indented)
        + "v";
    vec![
        (
            "flow seq",
            format!("k: {}1{}", "[".repeat(n), "]".repeat(n)),
        ),
        (
            "flow map",
            format!("k: {}1{}", "{a: ".repeat(n), "}".repeat(n)),
        ),
        ("block map", block_map),
        ("block seq", block_seq),
        ("compact seq", format!("{}1", "- ".repeat(n))),
        (
            "anchors",
            format!("k: {}1{}", "&a [".repeat(n), "]".repeat(n)),
        ),
        (
            "flow key",
            format!("{}1{}: v", "[".repeat(n), "]".repeat(n)),
        ),
    ]
}

#[test]
fn deeply_nested_yaml_frontmatter_fails_closed() {
    for n in [1_000usize, 10_000, 100_000] {
        for (name, yaml) in yaml_shapes(n) {
            on_small_stack(move || {
                assert!(parse_markdown_note(&note(&yaml)).is_err(), "{name} n={n}");
                assert!(safe_load(&yaml).is_err(), "{name} n={n}");
            });
        }
    }
}

#[test]
fn real_yaml_depth_still_loads() {
    // js-yaml 3 refuses a collection as an implicit key at any depth.
    for (name, yaml) in yaml_shapes(40)
        .into_iter()
        .filter(|(name, _)| *name != "flow key")
    {
        on_small_stack(move || {
            assert!(parse_markdown_note(&note(&yaml)).is_ok(), "{name}");
        });
    }
}

/// An alias puts a whole anchored value under another node, so a chain of
/// anchors that each wrap the previous one grows the height by one level per
/// line of input without ever nesting in the text.
#[test]
fn anchor_chains_cannot_build_a_deep_value() {
    on_small_stack(|| {
        let mut yaml = String::from("a0: &a0 [x]\n");
        for i in 1..3_000 {
            yaml.push_str(&format!("a{i}: &a{i} [*a{}]\n", i - 1));
        }
        assert!(safe_load(&yaml).is_err());
    });
}

fn deep_value(depth: usize) -> YamlValue {
    let mut value = YamlValue::String("x".into());
    for _ in 0..depth {
        value = YamlValue::seq(vec![value]);
    }
    value
}

#[test]
fn dumping_a_deep_value_fails_closed() {
    on_small_stack(|| {
        let value = deep_value(100_000);
        assert!(safe_dump(&value).is_err());
        let mut map = YamlMap::new();
        map.insert("k".to_owned(), value);
        assert!(stringify_frontmatter_block(&map, Eol::Lf).is_err());
        // Dropping a 100k deep value is the caller's own recursion; leak it.
        std::mem::forget(map);
    });
}

#[test]
fn replacing_the_body_of_a_deep_yjs_doc_fails_closed() {
    use yrs::{WriteTxn, XmlElementPrelim, XmlFragment};
    for tag in ["blockGroup", "blockquote", "blockContainer"] {
        on_small_stack(move || {
            let converter = converter_for(&serde_json::json!({}));
            let doc = open_document();
            doc.write(|txn| {
                let fragment = txn.get_or_insert_xml_fragment("prosemirror");
                let mut parent = fragment.push_back(txn, XmlElementPrelim::empty(tag));
                for _ in 0..100_000 {
                    parent = parent.push_back(txn, XmlElementPrelim::empty(tag));
                }
            })
            .expect("write");
            let outcome = converter.replace_body(
                &doc,
                "new body",
                ReplaceOptions {
                    note_path: None,
                    writing: None,
                    unless_changed_from: Some("stale"),
                    embeds: Some(&NoEmbeds),
                },
            );
            assert_eq!(outcome, ReplaceOutcome::Failed, "{tag}");
            let outcome = converter.replace_body(
                &doc,
                "new body",
                ReplaceOptions {
                    note_path: None,
                    writing: None,
                    unless_changed_from: None,
                    embeds: Some(&NoEmbeds),
                },
            );
            assert_eq!(outcome, ReplaceOutcome::Failed, "{tag}");
        });
    }
}

/// An alias costs O(1), not the size of the anchored value: n aliases of one
/// wide anchor once took n x width steps. Counted in collections measured, so
/// the bound holds in debug and release and cannot flake on a slow runner.
#[test]
fn many_aliases_of_a_wide_anchor_do_not_hang() {
    let n = 10_000;
    let mut yaml = format!("a: &a [{}]\n", vec!["[]"; n].join(","));
    for i in 0..n {
        yaml.push_str(&format!("b{i}: *a\n"));
    }
    on_small_stack(move || {
        let before = depth_visits();
        assert!(safe_load(&yaml).is_ok());
        let visits = depth_visits() - before;
        // The anchored value and its n children, once: not n x n.
        assert!(visits <= 2 * n + 10, "{visits} collections measured");
    });
}

/// Keys cost O(1) each: 300000 plain keys and 100000 descending integer keys
/// took minutes through a linear duplicate scan. 20000 of each is enough to
/// show it: the count, not the size, is what the test checks. Counted in map entries walked
/// (every walk of a map's keys is counted), so the bound holds on any machine:
/// a scan walks n x n / 2 of them, loading walks none.
#[test]
fn a_frontmatter_of_many_keys_does_not_hang() {
    let plain: String = (0..20_000).map(|i| format!("k{i}: 1\n")).collect();
    let indexed: String = (0..20_000).rev().map(|i| format!("{i}: 1\n")).collect();
    on_small_stack(move || {
        let before = entries_scanned();
        assert!(safe_load(&plain).is_ok());
        let loaded = safe_load(&indexed).unwrap().unwrap();
        let YamlValue::Map(map) = loaded else {
            panic!()
        };
        assert_eq!(
            map.iter().next().map(|(k, _)| k.to_owned()),
            Some("0".to_owned())
        );
        assert_eq!(map.len(), 20_000);
        let walked = entries_scanned() - before;
        // Loading walks no entry; the check above reads one back.
        assert!(walked <= 10, "{walked} map entries walked");
    });
}
