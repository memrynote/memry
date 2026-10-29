//! `sanitizeAttributes` and its value checks: event handlers, URLs that leave the document,
//! unsafe style values and animation values that would write one.

use super::scan::{Finder, ci_at, is_word, is_ws, tick, word_ends};

/// SMIL elements that can rewrite another element's attribute after load.
const ANIMATION_ELEMENTS: [&str; 4] = ["animate", "set", "animatetransform", "animatemotion"];

/// Animation attributes carrying the value that gets written.
const ANIMATION_VALUE_ATTRIBUTES: [&str; 4] = ["to", "from", "values", "by"];

/// Attributes that may carry a URL.
const URL_ATTRIBUTES: [&str; 5] = ["href", "xlink:href", "xml:href", "src", "xlink:src"];

/// Image types a `data:` URL may carry and stay inert.
const DATA_IMAGE_TYPES: [&str; 5] = ["png", "jpeg", "jpg", "gif", "webp"];

/// `name.replace(/^.*:/, '').toLowerCase()`. A name holds no line terminator (they are `\s`),
/// so `.*:` reaches the last colon.
pub(super) fn local_name(name: &str) -> String {
    name.rsplit(':').next().unwrap_or(name).to_lowercase()
}

/// `squash`: drops every character at or below U+0020, the classic scheme-smuggling trick
/// (`java\tscript:`).
fn squash(value: &[char]) -> Vec<char> {
    value
        .iter()
        .copied()
        .filter(|c| {
            tick();
            u32::from(*c) > 0x20
        })
        .collect()
}

/// `isSafeUrlValue`: empty, a `#fragment`, or an inert image data URL.
fn is_safe_url(value: &[char]) -> bool {
    let trimmed = squash(value);
    if trimmed.is_empty() || trimmed[0] == '#' {
        return true;
    }
    // `/^data:image\/(png|jpe?g|gif|webp);base64,/i`
    ci_at(&trimmed, 0, "data:image/")
        && DATA_IMAGE_TYPES
            .iter()
            .any(|kind| ci_at(&trimmed, 11, kind) && ci_at(&trimmed, 11 + kind.len(), ";base64,"))
}

/// `isSafeStyleValue`: nothing that reaches outside the document. Inside `url()` only
/// same-document references survive.
pub(super) fn is_safe_style(value: &[char]) -> bool {
    let lowered: String = squash(value).into_iter().collect::<String>().to_lowercase();
    if ["expression(", "javascript:", "@import"]
        .iter()
        .any(|bad| lowered.contains(bad))
    {
        return false;
    }
    if !lowered.contains("url(") {
        return true;
    }
    let lowered: Vec<char> = lowered.chars().collect();
    let mut fragment = false;
    let mut elsewhere = false;
    for (at, _) in lowered.iter().enumerate() {
        tick();
        if !lowered[at..].starts_with(&['u', 'r', 'l', '(']) {
            continue;
        }
        let after = at + 4;
        let quoted = matches!(lowered.get(after), Some('\'' | '"'));
        let target = lowered.get(after + usize::from(quoted)).copied();
        // `/url\(['"]?#/`
        fragment |= target == Some('#');
        // `/url\(['"]?[^#'")]/`: an unquoted target can be no quote either.
        elsewhere |= target.is_some_and(|c| !matches!(c, '#' | '\'' | '"' | ')'));
    }
    fragment && !elsewhere
}

/// `/^\s*(?:[a-z][a-z0-9+.-]*:|\/\/)/i`: a scheme or a protocol-relative URL.
fn starts_with_scheme(value: &[char]) -> bool {
    let start = value.iter().take_while(|c| is_ws(**c)).count();
    let rest = &value[start..];
    if rest.starts_with(&['/', '/']) {
        return true;
    }
    if !rest.first().is_some_and(char::is_ascii_alphabetic) {
        return false;
    }
    let scheme = rest[1..]
        .iter()
        .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
        .count();
    rest.get(1 + scheme) == Some(&':')
}

/// `/\battributeName\s*=\s*["']?(?:xlink:)?(?:href|src)\b/i`: an animation that swaps a
/// reference after load. The whole element goes rather than half of it.
pub(super) fn retargets_reference(attrs: &[char]) -> bool {
    (0..attrs.len()).any(|at| {
        tick();
        if !ci_at(attrs, at, "attributeName") || (at > 0 && is_word(attrs[at - 1])) {
            return false;
        }
        let mut at = skip_ws(attrs, at + 13);
        if attrs.get(at) != Some(&'=') {
            return false;
        }
        at = skip_ws(attrs, at + 1);
        if matches!(attrs.get(at), Some('"' | '\'')) {
            at += 1;
        }
        if ci_at(attrs, at, "xlink:") {
            at += 6;
        }
        ["href", "src"]
            .iter()
            .any(|name| ci_at(attrs, at, name) && word_ends(attrs, at + name.len()).is_some())
    })
}

fn skip_ws(text: &[char], mut at: usize) -> usize {
    while text.get(at).copied().is_some_and(is_ws) {
        tick();
        at += 1;
    }
    at
}

/// `[^\s"'=/<>]`, a character of an attribute name.
fn is_name_char(c: char) -> bool {
    !is_ws(c) && !matches!(c, '"' | '\'' | '=' | '/' | '<' | '>')
}

/// `[^\s"'=<>\x60]`, a character of an unquoted value.
fn is_bare_value_char(c: char) -> bool {
    !is_ws(c) && !matches!(c, '"' | '\'' | '=' | '<' | '>' | '`')
}

/// One match of `ATTR_RE`: the name, and the value when the `=value` group matched.
struct Attribute<'a> {
    name: &'a [char],
    value: Option<&'a [char]>,
}

/// The matches of
/// `/([^\s"'=/<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>\x60]+)))?/g` over `raw`. A value
/// group that fails (an unclosed quote) leaves the match at the name, and the next match starts
/// right after it.
fn attributes(raw: &[char]) -> Vec<Attribute<'_>> {
    let mut double = Finder::new('"', raw);
    let mut single = Finder::new('\'', raw);
    let mut found = Vec::new();
    let mut at = 0;
    loop {
        while at < raw.len() && !is_name_char(raw[at]) {
            tick();
            at += 1;
        }
        if at == raw.len() {
            return found;
        }
        let start = at;
        while at < raw.len() && is_name_char(raw[at]) {
            tick();
            at += 1;
        }
        let name = &raw[start..at];
        let eq = skip_ws(raw, at);
        let mut value = None;
        if raw.get(eq) == Some(&'=') {
            let open = skip_ws(raw, eq + 1);
            let quote = match raw.get(open) {
                Some('"') => Some(&mut double),
                Some('\'') => Some(&mut single),
                _ => None,
            };
            if let Some(finder) = quote {
                if let Some(close) = finder.next(raw, open + 1) {
                    value = Some(&raw[open + 1..close]);
                    at = close + 1;
                }
            } else if raw.get(open).copied().is_some_and(is_bare_value_char) {
                let mut end = open;
                while end < raw.len() && is_bare_value_char(raw[end]) {
                    tick();
                    end += 1;
                }
                value = Some(&raw[open..end]);
                at = end;
            }
        }
        found.push(Attribute { name, value });
    }
}

/// `sanitizeAttributes(raw, element)`: the kept attributes, each value double-quoted, joined
/// with single spaces after a leading one; empty when none is kept.
pub(super) fn sanitize_attributes(raw: &[char], element: &str) -> String {
    let mut kept = Vec::new();
    for Attribute { name, value } in attributes(raw) {
        let shown = value.unwrap_or(&[]);
        let name: String = name.iter().collect();
        let lower = name.to_lowercase();
        if lower.starts_with("on")
            || (URL_ATTRIBUTES.contains(&lower.as_str()) && !is_safe_url(shown))
            || (lower == "style" && !is_safe_style(shown))
            || lower == "xlink:base"
            || lower == "xml:base"
        {
            continue;
        }
        // An animation writes its value into another attribute, so its value is held to the
        // style rules whatever the target attribute is.
        if ANIMATION_ELEMENTS.contains(&element)
            && ANIMATION_VALUE_ATTRIBUTES.contains(&local_name(&lower).as_str())
            && (!is_safe_style(shown) || starts_with_scheme(&squash(shown)))
        {
            continue;
        }
        kept.push(match value {
            Some(value) => {
                let value: String = value.iter().collect();
                format!("{name}=\"{}\"", value.replace('"', "&quot;"))
            }
            None => name,
        });
    }
    if kept.is_empty() {
        String::new()
    } else {
        format!(" {}", kept.join(" "))
    }
}
