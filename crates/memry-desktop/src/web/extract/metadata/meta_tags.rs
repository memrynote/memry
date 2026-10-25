//! `getMetaContent(s)`, `isPlaceholderValue` and `firstValid`.

use std::sync::LazyLock;

use regex::Regex;

use crate::web::extract::defuddle::schema_org::MetaTag;
use crate::web::extract::utils::js::{to_lower, trim};

/// Which attribute of a `<meta>` a lookup reads.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum MetaAttr {
    Name,
    Property,
}

/// `getMetaContents`: the trimmed content of every tag whose attribute equals `value`, ignoring case.
pub fn get_meta_contents(tags: &[MetaTag], attr: MetaAttr, value: &str) -> Vec<String> {
    let wanted = to_lower(value);
    tags.iter()
        .filter(|tag| {
            let found = match attr {
                MetaAttr::Name => tag.name.as_deref(),
                MetaAttr::Property => tag.property.as_deref(),
            };
            found.is_some_and(|f| to_lower(f) == wanted)
        })
        .map(|tag| trim(&tag.content).to_string())
        .collect()
}

/// `getMetaContent`: the first match, or the empty string.
pub fn get_meta_content(tags: &[MetaTag], attr: MetaAttr, value: &str) -> String {
    get_meta_contents(tags, attr, value)
        .into_iter()
        .next()
        .unwrap_or_default()
}

static LETTER_OR_NUMBER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[\p{L}\p{N}]").expect("static pattern"));

/// `isPlaceholderValue`: an unresolved template (`{{title}}`, `#author.fullName}`) or text with
/// no letter or digit (`". ."`, `"-"`).
pub fn is_placeholder_value(s: &str) -> bool {
    if s.contains(['{', '}'])
        || (s.starts_with('#') && s[1..].starts_with(|c: char| c.is_ascii_alphabetic()))
    {
        return true;
    }
    !LETTER_OR_NUMBER.is_match(s)
}

/// The value when it is truthy and not a placeholder (one step of `firstValid`).
pub fn valid(value: String) -> Option<String> {
    (!value.is_empty() && !is_placeholder_value(&value)).then_some(value)
}

/// `a || b || c`: the first non-empty string, or the empty string.
pub fn first_nonempty<const N: usize>(values: [String; N]) -> String {
    values
        .into_iter()
        .find(|v| !v.is_empty())
        .unwrap_or_default()
}
