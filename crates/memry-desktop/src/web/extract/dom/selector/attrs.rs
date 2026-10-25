//! Port of css-select 5.2.2 `attributes.js`: the attribute selector rules.

use super::parse::{AttributeAction, IgnoreCase};
use crate::web::extract::utils::js::{is_js_whitespace, utf16_len, utf16_slice};

/// Attributes that HTML defines as ASCII case-insensitive (`caseInsensitiveAttributes`).
const CASE_INSENSITIVE_ATTRIBUTES: &[&str] = &[
    "accept",
    "accept-charset",
    "align",
    "alink",
    "axis",
    "bgcolor",
    "charset",
    "checked",
    "clear",
    "codetype",
    "color",
    "compact",
    "declare",
    "defer",
    "dir",
    "direction",
    "disabled",
    "enctype",
    "face",
    "frame",
    "hreflang",
    "http-equiv",
    "lang",
    "language",
    "link",
    "media",
    "method",
    "multiple",
    "nohref",
    "noresize",
    "noshade",
    "nowrap",
    "readonly",
    "rel",
    "rev",
    "rules",
    "scope",
    "scrolling",
    "selected",
    "shape",
    "target",
    "text",
    "type",
    "valign",
    "valuetype",
    "vlink",
];

/// A compiled attribute rule. `value` is already lower-cased where `ic` is set.
#[derive(Debug, Clone)]
pub enum AttrRule {
    Equals { value: String, ic: bool },
    Hyphen { value: String, ic: bool },
    Element { value: String, ic: bool },
    Exists,
    Start { value: String, ic: bool },
    End { value: String, ic: bool },
    Any { value: String, ic: bool },
    Not { value: String, ic: bool },
}

/// `shouldIgnoreCase`. `quirksMode` is never set, so `"quirks"` means case-sensitive.
fn should_ignore_case(ignore_case: IgnoreCase, name: &str) -> bool {
    match ignore_case {
        IgnoreCase::Yes => true,
        IgnoreCase::No | IgnoreCase::Quirks => false,
        IgnoreCase::Unknown => CASE_INSENSITIVE_ATTRIBUTES.contains(&name),
    }
}

/// Compiles the rule; `None` is css-select's `falseFunc` (the selector can never match).
pub fn compile_attribute(
    action: AttributeAction,
    name: &str,
    value: &str,
    ignore_case: IgnoreCase,
) -> Option<AttrRule> {
    let ic = should_ignore_case(ignore_case, name);
    let lowered = |v: &str| if ic { v.to_lowercase() } else { v.to_string() };
    match action {
        AttributeAction::Equals => Some(AttrRule::Equals {
            value: lowered(value),
            ic,
        }),
        AttributeAction::Hyphen => Some(AttrRule::Hyphen {
            value: lowered(value),
            ic,
        }),
        AttributeAction::Element => {
            if value.chars().any(is_js_whitespace) {
                None
            } else {
                Some(AttrRule::Element {
                    value: lowered(value),
                    ic,
                })
            }
        }
        AttributeAction::Exists => Some(AttrRule::Exists),
        AttributeAction::Start => (!value.is_empty()).then(|| AttrRule::Start {
            value: lowered(value),
            ic,
        }),
        AttributeAction::End => (!value.is_empty()).then(|| AttrRule::End {
            value: lowered(value),
            ic,
        }),
        AttributeAction::Any => (!value.is_empty()).then(|| AttrRule::Any {
            value: lowered(value),
            ic,
        }),
        AttributeAction::Not => Some(AttrRule::Not {
            value: lowered(value),
            ic,
        }),
    }
}

impl AttrRule {
    /// Tests the value of the attribute (`None` when missing). `Exists` is decided by the caller
    /// from `hasAttribute`, because a missing `class` still reads as `""`.
    pub fn test(&self, attr: Option<&str>) -> bool {
        match self {
            AttrRule::Exists => attr.is_some(),
            AttrRule::Equals { value, ic } => attr.is_some_and(|a| {
                if *ic {
                    utf16_len(a) == utf16_len(value) && a.to_lowercase() == *value
                } else {
                    a == value
                }
            }),
            AttrRule::Hyphen { value, ic } => attr.is_some_and(|a| {
                let len = utf16_len(value);
                let boundary = utf16_len(a) == len || utf16_slice(a, len, len + 1) == "-";
                let head = utf16_slice(a, 0, len);
                boundary
                    && if *ic {
                        head.to_lowercase() == *value
                    } else {
                        head == *value
                    }
            }),
            AttrRule::Element { value, ic } => attr
                .is_some_and(|a| utf16_len(a) >= utf16_len(value) && contains_word(a, value, *ic)),
            AttrRule::Start { value, ic } => attr.is_some_and(|a| {
                let len = utf16_len(value);
                if *ic {
                    utf16_len(a) >= len && utf16_slice(a, 0, len).to_lowercase() == *value
                } else {
                    a.starts_with(value.as_str())
                }
            }),
            AttrRule::End { value, ic } => attr.is_some_and(|a| {
                if *ic {
                    let total = utf16_len(a);
                    let len = utf16_len(value);
                    // `substr(-len)`: the whole string when it is shorter.
                    utf16_slice(a, total.saturating_sub(len), total).to_lowercase() == *value
                } else {
                    a.ends_with(value.as_str())
                }
            }),
            AttrRule::Any { value, ic } => attr.is_some_and(|a| {
                if *ic {
                    utf16_len(a) >= utf16_len(value) && a.to_lowercase().contains(value.as_str())
                } else {
                    a.contains(value.as_str())
                }
            }),
            AttrRule::Not { value, ic } => {
                if value.is_empty() {
                    return attr.is_some_and(|a| !a.is_empty());
                }
                match attr {
                    None => true,
                    Some(a) if *ic => {
                        utf16_len(a) != utf16_len(value) || a.to_lowercase() != *value
                    }
                    Some(a) => a != value,
                }
            }
        }
    }
}

/// `new RegExp('(?:^|\\s)' + escape(value) + '(?:$|\\s)', ic ? 'i' : '').test(attr)`.
fn contains_word(attr: &str, value: &str, ic: bool) -> bool {
    let (attr, value) = if ic {
        (attr.to_lowercase(), value.to_string())
    } else {
        (attr.to_string(), value.to_string())
    };
    let mut from = 0usize;
    while let Some(rel) = attr[from..].find(value.as_str()) {
        let start = from + rel;
        let end = start + value.len();
        let before_ok = start == 0
            || attr[..start]
                .chars()
                .next_back()
                .is_some_and(is_js_whitespace);
        let after_ok =
            end == attr.len() || attr[end..].chars().next().is_some_and(is_js_whitespace);
        if before_ok && after_ok {
            return true;
        }
        match attr[start..].chars().next() {
            Some(c) => from = start + c.len_utf8(),
            None => break,
        }
        if from > attr.len() {
            break;
        }
    }
    false
}
