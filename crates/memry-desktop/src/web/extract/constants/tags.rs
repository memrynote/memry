//! Element-name tables of `dist/constants.js`. The JS `Set`s keep insertion order and hold each
//! name once; the slices here do the same.

use std::sync::LazyLock;

pub const MOBILE_WIDTH: u32 = 600;

pub const BLOCK_ELEMENTS: &[&str] = &[
    "div", "section", "article", "main", "aside", "header", "footer", "nav", "content",
];

/// `BLOCK_ELEMENTS.join(',')`.
pub static BLOCK_ELEMENTS_SELECTOR: LazyLock<String> = LazyLock::new(|| BLOCK_ELEMENTS.join(","));

/// All block-level HTML elements: `BLOCK_ELEMENTS` plus the semantic content blocks.
pub const BLOCK_LEVEL_ELEMENTS: &[&str] = &[
    "div",
    "section",
    "article",
    "main",
    "aside",
    "header",
    "footer",
    "nav",
    "content",
    "p",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "ul",
    "ol",
    "li",
    "dl",
    "dt",
    "dd",
    "pre",
    "blockquote",
    "figure",
    "figcaption",
    "table",
    "thead",
    "tbody",
    "tfoot",
    "tr",
    "td",
    "th",
    "details",
    "summary",
    "address",
    "hr",
    "form",
    "fieldset",
];

/// Elements that are not unwrapped.
pub const PRESERVE_ELEMENTS: &[&str] = &[
    "pre",
    "code",
    "table",
    "thead",
    "tbody",
    "tr",
    "td",
    "th",
    "ul",
    "ol",
    "li",
    "dl",
    "dt",
    "dd",
    "figure",
    "figcaption",
    "picture",
    "details",
    "summary",
    "blockquote",
    "form",
    "fieldset",
];

/// Inline elements that are not unwrapped.
pub const INLINE_ELEMENTS: &[&str] = &[
    "a",
    "span",
    "strong",
    "em",
    "i",
    "b",
    "u",
    "code",
    "br",
    "small",
    "sub",
    "sup",
    "mark",
    "date",
    "del",
    "ins",
    "q",
    "abbr",
    "cite",
    "relative-time",
    "time",
    "font",
];
