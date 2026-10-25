//! BlockNote's `Link` mark: which `href` it accepts (`isAllowedUri`).

use crate::markdown::bn::dom::{Dom, NodeId};
use crate::markdown::bn::dom_parser::AttrsResult;

/// `UNICODE_WHITESPACE_REGEX_GLOBAL`: `[\u0000-\u0020\u00A0\u1680\u180E\u2000-\u2029\u205F\u3000]`.
fn is_uri_whitespace(c: char) -> bool {
    matches!(c,
        '\u{0}'..='\u{20}' | '\u{A0}' | '\u{1680}' | '\u{180E}' | '\u{2000}'..='\u{2029}'
            | '\u{205F}' | '\u{3000}')
}

const SCHEMES: &[&str] = &[
    "http", "https", "ftp", "ftps", "mailto", "tel", "callto", "sms", "cid", "xmpp",
];

fn is_scheme_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-')
}

/// `ALLOWED_URI_REGEX` on the whitespace-free uri:
/// `/^(?:(?:http|https|...):|[^a-z]|[a-z0-9+.\-]+(?:[^a-z+.\-:]|$))/i`.
fn matches_allowed(uri: &[char]) -> bool {
    let lower: String = uri.iter().map(char::to_ascii_lowercase).collect();
    if SCHEMES.iter().any(|s| lower.starts_with(&format!("{s}:"))) {
        return true;
    }
    let Some(first) = uri.first() else {
        return false;
    };
    if !first.is_ascii_alphabetic() {
        return true;
    }
    // `[a-z0-9+.\-]+` backtracks: it ends before a character that is no
    // letter, `+`, `.`, `-` or `:` (a digit inside the run qualifies), or at the end.
    let run = uri.iter().take_while(|c| is_scheme_char(**c)).count();
    (1..=run).rev().any(|end| {
        uri.get(end)
            .is_none_or(|c| !(c.is_ascii_alphabetic() || matches!(c, '+' | '.' | '-' | ':')))
    })
}

pub fn is_allowed_uri(uri: &str) -> bool {
    if uri.is_empty() {
        return true;
    }
    let cleaned: Vec<char> = uri.chars().filter(|c| !is_uri_whitespace(*c)).collect();
    matches_allowed(&cleaned)
}

/// The link mark's own `getAttrs` for `a[href]`: an empty or disallowed
/// `href` does not match.
pub fn link_attrs(dom: &Dom, id: NodeId) -> AttrsResult {
    match dom.attr(id, "href") {
        Some(href) if !href.is_empty() && is_allowed_uri(href) => AttrsResult::NoAttrs,
        _ => AttrsResult::Reject,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowed_uris() {
        for uri in [
            "https://a.com",
            "HTTP://a.com",
            "mailto:x@y.z",
            "tel:123",
            "/path",
            "#frag",
            "./a",
            "a/b",
            "page.html",
            "a1:b",
            "https:",
            "1:2",
            " \t http://a.com",
        ] {
            assert!(is_allowed_uri(uri), "{uri:?} is allowed");
        }
        assert!(is_allowed_uri(""));
    }

    #[test]
    fn rejected_uris() {
        for uri in [
            "javascript:alert(1)",
            "java\tscript:alert(1)",
            "data:text/html,x",
            "vbscript:x",
            "abc:def",
            "j:",
        ] {
            assert!(!is_allowed_uri(uri), "{uri:?} is rejected");
        }
    }
}
