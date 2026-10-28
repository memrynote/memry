//! The `writing` key of a parsed note's frontmatter (`ParsedMarkdownNote::frontmatter`):
//! `writingFrontmatterOf` and `mergeWritingFrontmatter` of desktop `crdt-writeback.ts`,
//! over YAML values rather than the objects gray-matter gives JavaScript.

use super::frontmatter::{read_writing_frontmatter, to_writing_frontmatter_value};
use super::types::{WRITING_FRONTMATTER_KEY, WritingFrontmatter};
use crate::markdown::frontmatter::{YamlMap, YamlValue, json_to_yaml, yaml_to_json};

/// What a `writing` key holds: writing tools data, or the author's own property.
fn ours(value: &YamlValue) -> Option<WritingFrontmatter> {
    read_writing_frontmatter(&yaml_to_json(value)?)
}

/// The writing tools data a whole file says. A file without the key, or whose key is the
/// author's own (`writing: draft`), says there is none.
pub fn writing_of_yaml(frontmatter: &YamlValue) -> WritingFrontmatter {
    match frontmatter {
        YamlValue::Map(map) => map.get(WRITING_FRONTMATTER_KEY).and_then(ours),
        _ => None,
    }
    .unwrap_or_default()
}

/// Puts the document's writing tools data on `frontmatter.writing`, removing the key when
/// there is none. True when that changed the map. A key that is the author's own is left
/// alone, at the cost of not writing ours.
pub fn merge_writing_yaml(frontmatter: &mut YamlMap, writing: &WritingFrontmatter) -> bool {
    let current = frontmatter.get(WRITING_FRONTMATTER_KEY);
    if current.is_some_and(|value| ours(value).is_none()) {
        return false;
    }
    let next = to_writing_frontmatter_value(writing);
    if current.and_then(yaml_to_json) == next {
        return false;
    }
    match next {
        Some(value) => frontmatter.insert(WRITING_FRONTMATTER_KEY.to_owned(), json_to_yaml(&value)),
        None => {
            frontmatter.remove(WRITING_FRONTMATTER_KEY);
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::markdown::frontmatter::parse_markdown_note;
    use crate::markdown::shared::writing_tools::{
        WritingFrontmatterAlternative, WritingFrontmatterVersion,
    };

    fn frontmatter(raw: &str) -> YamlValue {
        parse_markdown_note(raw).unwrap().frontmatter
    }

    fn map(raw: &str) -> YamlMap {
        match frontmatter(raw) {
            YamlValue::Map(map) => (*map).clone(),
            other => panic!("not a map: {other:?}"),
        }
    }

    fn some_writing() -> WritingFrontmatter {
        WritingFrontmatter {
            alternatives: vec![(
                "a1".to_owned(),
                WritingFrontmatterAlternative {
                    versions: vec![WritingFrontmatterVersion {
                        text: "other words".to_owned(),
                        ai: None,
                    }],
                    original: None,
                },
            )],
            overflow: Vec::new(),
        }
    }

    #[test]
    fn the_writing_a_file_holds_round_trips_through_its_frontmatter() {
        let mut fm = map("---\ntitle: x\n---\nbody\n");
        assert!(merge_writing_yaml(&mut fm, &some_writing()));
        let written = YamlValue::map(fm.clone());
        assert_eq!(writing_of_yaml(&written), some_writing());
        assert!(
            !merge_writing_yaml(&mut fm, &some_writing()),
            "same data, no change"
        );
        assert!(merge_writing_yaml(&mut fm, &WritingFrontmatter::default()));
        assert!(!fm.contains_key(WRITING_FRONTMATTER_KEY));
    }

    #[test]
    fn a_writing_key_of_the_authors_own_is_never_touched() {
        let mut fm = map("---\nwriting: draft\n---\n");
        assert!(!merge_writing_yaml(&mut fm, &some_writing()));
        assert_eq!(
            fm.get(WRITING_FRONTMATTER_KEY),
            Some(&YamlValue::String("draft".to_owned()))
        );
        assert_eq!(
            writing_of_yaml(&frontmatter("---\nwriting: draft\n---\n")),
            WritingFrontmatter::default()
        );
    }

    #[test]
    fn no_data_and_no_key_is_no_change() {
        let mut fm = map("---\ntitle: x\n---\n");
        assert!(!merge_writing_yaml(&mut fm, &WritingFrontmatter::default()));
    }
}
