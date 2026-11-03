//! `rewrite_file`, the inbound link repair over a whole vault file with its frontmatter read as
//! YAML: Electron's raw bytes wherever they read back as the values rewritten, the changed keys
//! written again by the frontmatter editor where they do not (a title YAML must quote
//! otherwise), and the untrusted-input guards: aliases walked once, the loader's deepest value
//! on a small stack, and output bounded by the input.

#![cfg(feature = "markdown")]

use memry_core::domain::notes::link_rewrite::{
    FileRewrite, LinkNames, rewrite_file, rewrite_text, text_steps,
};
use memry_core::markdown::frontmatter::{YamlValue, parse_markdown_note, split_frontmatter_block};
use memry_test_kit::{assert_steps_at_most, on_small_stack, proptest_config};
use proptest::prelude::*;

fn names(title: &str) -> LinkNames {
    LinkNames {
        title: title.to_owned(),
        folder: None,
        markdown: true,
    }
}

fn rename(text: &str, to: &str) -> FileRewrite {
    rewrite_file(text, "renamed", &names("Plan"), &names(to), |_| Ok(false)).unwrap()
}

fn wrote(text: &str, to: &str) -> String {
    rename(text, to).text.expect("a link changed")
}

#[test]
fn a_value_the_quoting_cannot_hold_is_written_by_yaml_and_untouched_lines_kept() {
    let text = "---\n# mine\nrelated: '[[Plan]]'\ntags: [x]\n---\nSee [[Plan]].\n";
    assert_eq!(
        wrote(text, "Kaan's Plan"),
        "---\n# mine\nrelated: '[[Kaan''s Plan]]'\ntags: [x]\n---\nSee [[Kaan's Plan]].\n"
    );
    // Then every key that names the note is written by YAML, the double-quoted one too.
    assert_eq!(
        wrote(
            "---\na: '[[Plan]]'\nb: \"[[Plan]]\"\nc: \"[[Other]]\"\n---\n",
            "Kaan's Plan"
        ),
        "---\na: '[[Kaan''s Plan]]'\nb: '[[Kaan''s Plan]]'\nc: \"[[Other]]\"\n---\n"
    );
    // A raw `\` in a double-quoted value would read as an escape.
    assert_eq!(
        wrote("---\nrelated: \"[[Plan]]\"\n---\n", "a\\b"),
        "---\nrelated: '[[a\\b]]'\n---\n"
    );
}

#[test]
fn electrons_bytes_where_they_read_back_as_the_values_rewritten() {
    let text = "---\n# see [[Plan]]\nrelated: \"[[Plan]]\"\nlinks: ['[[plan#H|h]]', \"[[Other]]\"]\n\
                meta: {see: \"[[Plan]]\"}\n---\n[[Plan]]\n";
    assert_eq!(
        wrote(text, "Roadmap"),
        "---\n# see [[Roadmap]]\nrelated: \"[[Roadmap]]\"\nlinks: ['[[Roadmap#H|h]]', \"[[Other]]\"]\n\
         meta: {see: \"[[Roadmap]]\"}\n---\n[[Roadmap]]\n"
    );
    // A frontmatter that names the note nowhere is left byte for byte.
    assert_eq!(
        wrote(
            "---\nrelated: \"[[Other]]\"\n---\n[[Plan]]\n",
            "Kaan's Plan"
        ),
        "---\nrelated: \"[[Other]]\"\n---\n[[Kaan's Plan]]\n"
    );
}

#[test]
fn a_block_the_editor_cannot_edit_key_by_key_keeps_its_links_and_the_body_follows() {
    // An alias ties two keys' lines together.
    let aliased = rename(
        "---\na: &x '[[Plan]]'\nb: *x\n---\n[[Plan]]\n",
        "Kaan's Plan",
    );
    assert_eq!(
        aliased,
        FileRewrite {
            text: Some("---\na: &x '[[Plan]]'\nb: *x\n---\n[[Kaan's Plan]]\n".into()),
            skipped: 0,
            frontmatter_kept: true,
        }
    );
    // `[[Plan]]` unquoted is a list in a list, not a link: the raw rewrite would change it.
    let listed = rename("---\na: [[Plan]]\n---\n", "Roadmap");
    assert_eq!(listed.text, None);
    assert!(listed.frontmatter_kept);
    // A frontmatter that does not parse is not touched.
    assert_eq!(
        wrote("---\na: [\nb: '[[Plan]]'\n---\n[[Plan]]\n", "Roadmap"),
        "---\na: [\nb: '[[Plan]]'\n---\n[[Roadmap]]\n"
    );
}

#[test]
fn a_link_the_new_name_would_break_is_counted_in_the_frontmatter_and_the_body() {
    let out = rename("---\na: '[[Plan]]'\n---\n[[Plan]] [[Plan]]\n", "A|B");
    assert_eq!(
        out,
        FileRewrite {
            text: None,
            skipped: 3,
            frontmatter_kept: false,
        }
    );
}

/// `depth` flow lists, the link at the bottom: the loader's deepest frontmatter.
fn nested(depth: usize) -> String {
    let open = "[ ".repeat(depth);
    let close = " ]".repeat(depth);
    format!("---\na: {open}'[[Plan]]'{close}\n---\n")
}

#[test]
fn the_loaders_deepest_value_is_walked_on_a_small_stack() {
    on_small_stack(|| {
        assert!(
            parse_markdown_note(&nested(99)).is_err(),
            "one more is the loader's"
        );
        let text = nested(98);
        let out = rename(&text, "Kaan's Plan");
        assert!(
            out.text
                .is_some_and(|text| text.contains("'[[Kaan''s Plan]]'"))
        );
    });
}

/// Each level holds `width` aliases of the one below: `width ^ levels` strings, in a text that
/// grows by `width` names per level.
fn laughs(levels: usize, width: usize) -> String {
    let mut text = String::from("---\nl0: &l0 '[[Plan]]'\n");
    for level in 1..=levels {
        let items = vec![format!("*l{}", level - 1); width].join(", ");
        text.push_str(&format!("l{level}: &l{level} [{items}]\n"));
    }
    text + "---\n"
}

#[test]
fn an_alias_is_walked_once() {
    on_small_stack(|| {
        let text = laughs(8, 10);
        assert_steps_at_most("aliases", text_steps, 4 * text.len(), || {
            rename(&text, "Kaan's Plan");
        });
    });
}

/// The reference for one frontmatter value: its strings through `rewrite_text`.
fn values_rewritten(value: &YamlValue, to: &str) -> YamlValue {
    match value {
        YamlValue::String(text) => YamlValue::String(
            rewrite_text(text, "renamed", &names("Plan"), &names(to), |_| Ok(false))
                .unwrap()
                .unwrap_or_else(|| text.clone()),
        ),
        YamlValue::Seq(items) => YamlValue::Seq(std::sync::Arc::new(
            items
                .iter()
                .map(|item| values_rewritten(item, to))
                .collect(),
        )),
        YamlValue::Map(map) => {
            let mut next = (**map).clone();
            for (key, item) in map.iter() {
                next.insert(key.to_owned(), values_rewritten(item, to));
            }
            YamlValue::map(next)
        }
        other => other.clone(),
    }
}

proptest! {
    #![proptest_config(proptest_config(memry_test_kit::DEFAULT_CASES))]

    #[test]
    fn the_values_are_the_references_and_the_output_is_bounded(
        entries in prop::collection::vec(
            prop_oneof![
                Just("'[[Plan]]'"),
                Just("\"[[plan#H|x]]\""),
                Just("'see [[Plan]] and [[Other]]'"),
                Just("[\"[[Plan]]\", '[[Plan]]']"),
                Just("{a: '[[Plan]]'}"),
                Just("plain"),
                Just("'it''s [[Plan]]'"),
            ],
            0..8,
        ),
        comment in any::<bool>(),
        to in prop_oneof![
            Just("Roadmap"),
            Just("Kaan's Plan"),
            Just("a\\b"),
            Just("Say \"hi\""),
            Just("x: y"),
        ],
    ) {
        let mut text = String::from("---\n");
        if comment {
            text.push_str("# [[Plan]]\n");
        }
        for (at, value) in entries.iter().enumerate() {
            text.push_str(&format!("k{at}: {value}\n"));
        }
        text.push_str("---\nBody [[Plan]].\n");
        let before = parse_markdown_note(&text).unwrap().frontmatter;
        let out = rename(&text, to);
        let written = out.text.clone().unwrap_or_else(|| text.clone());
        let after = parse_markdown_note(&written).expect("the frontmatter still parses");
        if !out.frontmatter_kept {
            prop_assert_eq!(after.frontmatter, values_rewritten(&before, to));
        }
        prop_assert_eq!(
            split_frontmatter_block(&written).body,
            format!("Body [[{to}]].\n")
        );
        let links = text.matches("[[").count();
        prop_assert!(written.len() <= 2 * (text.len() + links * to.len()));
    }
}
