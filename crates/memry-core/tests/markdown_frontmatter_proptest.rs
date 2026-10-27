//! Oracle-free properties of the frontmatter rules (protocol 12.4): the split
//! never loses a byte, and what the dumper writes the loader reads back.

#![cfg(feature = "markdown")]

use memry_core::markdown::frontmatter::{
    Eol, YamlMap, YamlValue, parse_markdown_note, safe_dump, safe_load, split_frontmatter_block,
    stringify_frontmatter_block,
};
use memry_test_kit::proptest_config;
use proptest::prelude::*;

fn config() -> ProptestConfig {
    proptest_config(2000)
}

fn scalar_string() -> impl Strategy<Value = String> {
    prop_oneof![
        "[a-zA-Z0-9 _.:#'\"\\\\/@!&*?|>%,\\[\\]{}=~-]{0,40}",
        "\\PC{0,30}",
        prop::sample::select(vec![
            "true",
            "No",
            "null",
            "~",
            "12",
            "1e3",
            "0x1F",
            "2024-01-01",
            "<<",
            "- x",
            "a: b",
            " lead",
            "trail ",
            "a\nb",
            "a\n",
            "\t",
            "é日本😀",
            "\u{85}",
            "\u{a0}",
            "",
        ])
        .prop_map(str::to_owned),
    ]
}

fn value() -> impl Strategy<Value = YamlValue> {
    let leaf = prop_oneof![
        Just(YamlValue::Null),
        any::<bool>().prop_map(YamlValue::Bool),
        (-1_000_000i64..1_000_000).prop_map(|n| YamlValue::Number(n as f64)),
        (-1.0e9f64..1.0e9).prop_map(YamlValue::Number),
        scalar_string().prop_map(YamlValue::String),
    ];
    leaf.prop_recursive(3, 24, 4, |inner| {
        prop_oneof![
            prop::collection::vec(inner.clone(), 0..4).prop_map(YamlValue::seq),
            prop::collection::vec((scalar_string(), inner), 0..4).prop_map(|pairs| {
                let mut map = YamlMap::new();
                for (key, item) in pairs {
                    map.insert(key, item);
                }
                YamlValue::map(map)
            }),
        ]
    })
}

proptest! {
    #![proptest_config(config())]

    #[test]
    fn the_split_never_loses_a_byte(raw in "(\u{feff}?---\r?\n)?[a-z:#\\- \r\n\u{feff}é]{0,60}") {
        let split = split_frontmatter_block(&raw);
        prop_assert_eq!(format!("{}{}", split.block.unwrap_or(""), split.body), raw);
    }

    #[test]
    fn loading_arbitrary_text_never_panics(text in "\\PC{0,80}") {
        let _ = safe_load(&text);
        let _ = parse_markdown_note(&format!("---\n{text}\n---\nbody\n"));
    }

    #[test]
    fn what_the_dumper_writes_the_loader_reads(map in prop::collection::vec((scalar_string(), value()), 0..4)) {
        let mut frontmatter = YamlMap::new();
        for (key, item) in map {
            frontmatter.insert(key, item);
        }
        let expected = YamlValue::map(frontmatter.clone());
        let dumped = safe_dump(&expected).expect("shallow value dumps");
        let loaded = safe_load(&dumped);
        prop_assert_eq!(loaded.as_ref().ok().and_then(Option::as_ref), Some(&expected), "{}", dumped);
        let block = stringify_frontmatter_block(&frontmatter, Eol::CrLf).expect("shallow value dumps");
        prop_assert!(block.is_empty() || block.ends_with("---\r\n"));
    }
}
