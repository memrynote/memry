//! `sanitizeAttributes` and its value checks: event handlers, URLs that leave the document,
//! unsafe style values and animation values that would write one.

use super::scan::{Finder, as_str, ci_at, is_word, skip_ws, squash, tick, word_ends, ws_len};

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

/// `isSafeUrlValue`: empty, a `#fragment`, or an inert image data URL.
pub(super) fn is_safe_url(value: &str) -> bool {
    let trimmed = squash(value);
    let trimmed = trimmed.as_bytes();
    if trimmed.first().is_none_or(|first| *first == b'#') {
        return true;
    }
    // `/^data:image\/(png|jpe?g|gif|webp);base64,/i`
    ci_at(trimmed, 0, "data:image/")
        && DATA_IMAGE_TYPES
            .iter()
            .any(|kind| ci_at(trimmed, 11, kind) && ci_at(trimmed, 11 + kind.len(), ";base64,"))
}

/// `isSafeStyleValue`: nothing that reaches outside the document. Inside `url()` only
/// same-document references survive.
pub(super) fn is_safe_style(value: &str) -> bool {
    let lowered = squash(value).to_lowercase();
    if ["expression(", "javascript:", "@import"]
        .iter()
        .any(|bad| lowered.contains(bad))
    {
        return false;
    }
    if !lowered.contains("url(") {
        return true;
    }
    let lowered = lowered.as_bytes();
    let mut fragment = false;
    let mut elsewhere = false;
    for at in 0..lowered.len() {
        tick();
        if !lowered[at..].starts_with(b"url(") {
            continue;
        }
        let after = at + 4;
        let quoted = matches!(lowered.get(after), Some(b'\'' | b'"'));
        let target = lowered.get(after + usize::from(quoted)).copied();
        // `/url\(['"]?#/`
        fragment |= target == Some(b'#');
        // `/url\(['"]?[^#'")]/`: an unquoted target can be no quote either.
        elsewhere |= target.is_some_and(|c| !matches!(c, b'#' | b'\'' | b'"' | b')'));
    }
    fragment && !elsewhere
}

/// `/^\s*(?:[a-z][a-z0-9+.-]*:|\/\/)/i`: a scheme or a protocol-relative URL.
fn starts_with_scheme(value: &[u8]) -> bool {
    let rest = &value[skip_ws(value, 0)..];
    if rest.starts_with(b"//") {
        return true;
    }
    if !rest.first().is_some_and(u8::is_ascii_alphabetic) {
        return false;
    }
    let scheme = rest[1..]
        .iter()
        .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, b'+' | b'.' | b'-'))
        .count();
    rest.get(1 + scheme) == Some(&b':')
}

/// `/\battributeName\s*=\s*["']?(?:xlink:)?(?:href|src)\b/i`: an animation that swaps a
/// reference after load. The whole element goes rather than half of it.
pub(super) fn retargets_reference(attrs: &[u8]) -> bool {
    (0..attrs.len()).any(|at| {
        tick();
        if !ci_at(attrs, at, "attributeName") || (at > 0 && is_word(attrs[at - 1])) {
            return false;
        }
        let mut at = skip_ws(attrs, at + 13);
        if attrs.get(at) != Some(&b'=') {
            return false;
        }
        at = skip_ws(attrs, at + 1);
        if matches!(attrs.get(at), Some(b'"' | b'\'')) {
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

/// `[^\s"'=/<>]` at `at`, a character of an attribute name. A byte inside a longer character
/// counts as one: it is never a `\s` lead byte.
fn is_name_char(text: &[u8], at: usize) -> bool {
    ws_len(text, at) == 0 && !matches!(text[at], b'"' | b'\'' | b'=' | b'/' | b'<' | b'>')
}

/// `[^\s"'=<>\x60]` at `at`, a character of an unquoted value.
fn is_bare_value_char(text: &[u8], at: usize) -> bool {
    ws_len(text, at) == 0 && !matches!(text[at], b'"' | b'\'' | b'=' | b'<' | b'>' | b'`')
}

/// One match of `ATTR_RE`: the name, and the value when the `=value` group matched.
pub(super) struct Attribute<'a> {
    pub(super) name: &'a str,
    pub(super) value: Option<&'a str>,
}

/// The matches of
/// `/([^\s"'=/<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>\x60]+)))?/g` over `raw`, one
/// at a time. A value group that fails (an unclosed quote) leaves the match at the name, and
/// the next match starts right after it.
struct Attributes<'a> {
    raw: &'a [u8],
    at: usize,
    double: Finder,
    single: Finder,
}

impl<'a> Iterator for Attributes<'a> {
    type Item = Attribute<'a>;

    fn next(&mut self) -> Option<Attribute<'a>> {
        let raw = self.raw;
        let mut at = self.at;
        while at < raw.len() && !is_name_char(raw, at) {
            tick();
            at += ws_len(raw, at).max(1);
        }
        if at == raw.len() {
            self.at = at;
            return None;
        }
        let start = at;
        while at < raw.len() && is_name_char(raw, at) {
            tick();
            at += 1;
        }
        let name = as_str(&raw[start..at]);
        let mut value = None;
        let eq = skip_ws(raw, at);
        if raw.get(eq) == Some(&b'=') {
            let open = skip_ws(raw, eq + 1);
            let quote = match raw.get(open) {
                Some(b'"') => Some(&mut self.double),
                Some(b'\'') => Some(&mut self.single),
                _ => None,
            };
            if let Some(finder) = quote {
                if let Some(close) = finder.next(raw, open + 1) {
                    value = Some(as_str(&raw[open + 1..close]));
                    at = close + 1;
                }
            } else if open < raw.len() && is_bare_value_char(raw, open) {
                let mut end = open;
                while end < raw.len() && is_bare_value_char(raw, end) {
                    tick();
                    end += 1;
                }
                value = Some(as_str(&raw[open..end]));
                at = end;
            }
        }
        self.at = at;
        Some(Attribute { name, value })
    }
}

/// `sanitizeAttributes(raw, element)`: the attributes the TypeScript keeps, in order.
pub(super) fn sanitize_attributes<'a>(
    raw: &'a [u8],
    element: &str,
) -> impl Iterator<Item = Attribute<'a>> + use<'a> {
    let animation = ANIMATION_ELEMENTS.contains(&element);
    let attributes = Attributes {
        raw,
        at: 0,
        double: Finder::new(b'"', raw),
        single: Finder::new(b'\'', raw),
    };
    attributes.filter(move |Attribute { name, value }| {
        let shown = value.unwrap_or("");
        let lower = name.to_lowercase();
        let refused = lower.starts_with("on")
            || (URL_ATTRIBUTES.contains(&lower.as_str()) && !is_safe_url(shown))
            || (lower == "style" && !is_safe_style(shown))
            || lower == "xlink:base"
            || lower == "xml:base"
            // An animation writes its value into another attribute, so its value is held to
            // the style rules whatever the target attribute is.
            || (animation
                && ANIMATION_VALUE_ATTRIBUTES.contains(&local_name(&lower).as_str())
                && (!is_safe_style(shown) || starts_with_scheme(squash(shown).as_bytes())));
        !refused
    })
}

/// The attributes as the TypeScript writes them: each after one space, a value double-quoted
/// with its `"` written `&quot;`.
pub(super) fn write_attributes<'a>(out: &mut Vec<u8>, kept: impl Iterator<Item = Attribute<'a>>) {
    for Attribute { name, value } in kept {
        out.push(b' ');
        out.extend_from_slice(name.as_bytes());
        if let Some(value) = value {
            out.extend_from_slice(b"=\"");
            for byte in value.bytes() {
                tick();
                match byte {
                    b'"' => out.extend_from_slice(b"&quot;"),
                    _ => out.push(byte),
                }
            }
            out.push(b'"');
        }
    }
}
