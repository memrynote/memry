//! The canonical serialisation of a `prosemirror` fragment (N101).
//!
//! **Why this exists.** The write-direction vector class has to compare a
//! document this port produced against one the TypeScript port produced, and
//! it cannot do that by comparing update bytes. A Yjs update encodes
//! `clientID` and per-client clocks, and struct ordering, origin ids and
//! run-length packing are free choices an implementation may make differently
//! while still converging. Two different updates that converge are *both
//! correct*, so a byte comparison would fail on correct ports and catch
//! nothing extra. `specs/003-ios-note-parity/research.md` records the full
//! argument.
//!
//! So the class compares the **resulting document**, and this is the one
//! textual form both ports emit for it. The TypeScript half is
//! `packages/contracts/scripts/fragment-canonical.ts`, and the committed
//! vectors are what hold the two together.
//!
//! ## The format
//!
//! One line per node, depth-first, in document order. The fragment itself is
//! not emitted; its children start at depth 0. An empty document is the empty
//! string, not a newline.
//!
//! ```text
//! <depth> <kind> <payload>
//! ```
//!
//! - `depth` is a decimal integer, `0` for a direct child of the fragment;
//! - `kind` is `element` or `text`;
//! - an element's payload is its tag, then one ` name=<json>` per attribute,
//!   **sorted by name**;
//! - a text chunk's payload is the quoted text, then one ` name=<json>` per
//!   mark, **sorted by name**.
//!
//! Sorting is what makes it canonical: a Yjs map's iteration order is not
//! stable across runs or across ports, so an unsorted rendering would differ
//! from itself.
//!
//! ## What it deliberately does not carry
//!
//! Nothing about *how* the document was built: no clocks, no client ids, no
//! tombstones. Two documents that render the same here are the same document
//! as far as any reader is concerned, which is the equivalence the class
//! wants.

use std::fmt::Write as _;

use yrs::types::text::YChange;
use yrs::{Any, Out, ReadTxn, Text as _, Xml as _, XmlFragment, XmlOut, XmlTextRef};

use super::errors::CrdtError;
use super::registry::Document;
use super::text_extract::BODY_FRAGMENT;

/// The canonical form of one document's body fragment.
pub fn canonical_fragment(document: &Document) -> Result<String, CrdtError> {
    document.read(|txn| {
        let mut out: Vec<String> = Vec::new();
        if let Some(fragment) = txn.get_xml_fragment(BODY_FRAGMENT) {
            walk(&fragment, txn, 0, &mut out);
        }
        out.join("\n")
    })
}

fn walk<F, T>(node: &F, txn: &T, depth: u32, out: &mut Vec<String>)
where
    F: XmlFragment,
    T: ReadTxn,
{
    for child in node.children(txn) {
        match child {
            XmlOut::Text(text) => text_lines(&text, txn, depth, out),
            XmlOut::Element(element) => {
                let tag = element.tag().clone();
                let pairs: Vec<(String, Any)> = element
                    .attributes(txn)
                    .map(|(name, value)| (name.to_owned(), any_of(value, txn)))
                    .collect();
                out.push(format!(
                    "{depth} element {}{}",
                    tag.as_ref(),
                    render_pairs(pairs)
                ));
                walk(&element, txn, depth + 1, out);
            }
            // A bare nested fragment carries no node of its own. `extract_text`
            // skips it for the same reason; recording a line for it would
            // invent structure the document does not have.
            XmlOut::Fragment(_) => {}
        }
    }
}

fn text_lines<T: ReadTxn>(text: &XmlTextRef, txn: &T, depth: u32, out: &mut Vec<String>) {
    for chunk in text.diff(txn, YChange::identity) {
        let Out::Any(Any::String(value)) = &chunk.insert else {
            continue;
        };
        let pairs: Vec<(String, Any)> = chunk
            .attributes
            .as_ref()
            .map(|attrs| {
                attrs
                    .iter()
                    .map(|(name, value)| (mark_name(name).to_owned(), value.clone()))
                    .collect()
            })
            .unwrap_or_default();
        out.push(format!(
            "{depth} text {}{}",
            canonical_string(value),
            render_pairs(pairs)
        ));
    }
}

/// An attribute's value as an [`Any`].
///
/// `XmlElementRef::attributes` yields an [`Out`], which is an `Any` for every
/// attribute a document really carries. A nested shared type as an attribute
/// value is not something y-prosemirror produces; it renders as its string
/// form rather than being dropped.
fn any_of<T: ReadTxn>(value: Out, txn: &T) -> Any {
    match value {
        Out::Any(any) => any,
        other => Any::String(other.to_string(txn).into()),
    }
}

/// y-prosemirror keys a mark that does not exclude itself as
/// `name--<8 character hash>` so two of them can overlap on one run, and
/// strips the suffix again when reading. A canonical form that kept the hash
/// would encode which *other* marks happened to be present, which is not a
/// fact about this run.
fn mark_name(attribute: &str) -> &str {
    let Some((name, hash)) = attribute.rsplit_once("--") else {
        return attribute;
    };
    let is_hash = hash.len() == 8
        && hash
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='));
    if is_hash && !name.is_empty() {
        name
    } else {
        attribute
    }
}

/// `name=<value>` pairs, sorted, each prefixed with a space.
///
/// Sorted by byte, which matches the TypeScript port's code-point ordering for
/// the ASCII names BlockNote uses.
///
/// **An attribute holding null or undefined is omitted, and the two ports had
/// to be made to agree on that.** y-prosemirror skips a `null` attribute when
/// it writes, but it happily writes an `undefined` one — a `numberedListItem`
/// carries `start: undefined` on every item. This port saw `Any::Undefined`
/// and rendered `start=null`; the other port saw JavaScript `undefined` and
/// dropped the key, so one document rendered two ways. Omitting is the
/// agreement: an attribute with no value says nothing a reader can act on,
/// and the block walk still reports it in `props` for anyone who cares.
fn render_pairs(mut pairs: Vec<(String, Any)>) -> String {
    pairs.retain(|(_, value)| !matches!(value, Any::Null | Any::Undefined));
    pairs.sort_by(|left, right| left.0.cmp(&right.0));
    let mut out = String::new();
    for (name, value) in pairs {
        // `write!` to a `String` cannot fail.
        let _ = write!(out, " {name}={}", canonical_value(&value));
    }
    out
}

/// One attribute or mark value, as canonical JSON with object keys sorted.
fn canonical_value(value: &Any) -> String {
    match value {
        // Both ports spell "this slot was never set" as `null`: JavaScript
        // round-trips an `undefined` inside an array through Yjs and reads it
        // back as `undefined`, and this port sees `Any::Undefined`. Collapsing
        // them is what keeps a `colwidth` of `[undefined, 180]` from
        // rendering two different ways.
        Any::Null | Any::Undefined => "null".to_owned(),
        Any::Bool(value) => value.to_string(),
        Any::Number(value) => canonical_number(*value),
        Any::BigInt(value) => value.to_string(),
        Any::String(text) => canonical_string(text),
        Any::Array(values) => {
            let rendered: Vec<String> = values.iter().map(canonical_value).collect();
            format!("[{}]", rendered.join(","))
        }
        Any::Map(entries) => {
            let mut pairs: Vec<(&String, &Any)> = entries.iter().collect();
            pairs.sort_by(|left, right| left.0.cmp(right.0));
            let rendered: Vec<String> = pairs
                .into_iter()
                .filter(|(_, value)| !matches!(value, Any::Undefined))
                .map(|(key, value)| format!("{}:{}", canonical_string(key), canonical_value(value)))
                .collect();
            format!("{{{}}}", rendered.join(","))
        }
        // A binary attribute is not something y-prosemirror writes. Rendered
        // rather than dropped, so an unexpected one is visible as a mismatch.
        Any::Buffer(bytes) => {
            let mut out = String::from("\"0x");
            for byte in bytes.iter() {
                let _ = write!(out, "{byte:02x}");
            }
            out.push('"');
            out
        }
    }
}

/// A number, in the one spelling both ports produce.
///
/// JavaScript and Rust both print the shortest representation that round-trips
/// a double, so they agree on every value a document realistically carries.
/// They disagree only at the exponent thresholds, which is why the TypeScript
/// half refuses a value past 1e21; this half renders an integer without a
/// fractional part so `180.0` and `180` are one string.
fn canonical_number(value: f64) -> String {
    if !value.is_finite() {
        return "null".to_owned();
    }
    if value.fract() == 0.0 && value.abs() < 1e21 {
        format!("{value:.0}")
    } else {
        value.to_string()
    }
}

/// A quoted, escaped string.
///
/// Hand-written rather than `serde_json` because the two ports must agree byte
/// for byte. Escape exactly: backslash, quote, the four named control
/// characters, and everything else below `0x20` as `\u00xx` with lowercase
/// hex. Every other code point is emitted as its own UTF-8 bytes.
fn canonical_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for character in value.chars() {
        match character {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            other if (other as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", other as u32);
            }
            other => out.push(other),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strings_escape_the_way_the_other_port_escapes() {
        assert_eq!(canonical_string("plain"), "\"plain\"");
        assert_eq!(canonical_string("a\"b"), "\"a\\\"b\"");
        assert_eq!(canonical_string("a\\b"), "\"a\\\\b\"");
        assert_eq!(canonical_string("a\nb"), "\"a\\nb\"");
        assert_eq!(canonical_string("a\tb"), "\"a\\tb\"");
        // Below 0x20 and unnamed: lowercase hex, four digits.
        assert_eq!(canonical_string("a\u{1}b"), "\"a\\u0001b\"");
        // Non-ASCII is emitted as itself, never escaped.
        assert_eq!(canonical_string("Grüße 世界 🙂"), "\"Grüße 世界 🙂\"");
    }

    #[test]
    fn a_whole_integer_renders_without_a_fractional_part() {
        assert_eq!(canonical_number(180.0), "180");
        assert_eq!(canonical_number(-3.0), "-3");
        assert_eq!(canonical_number(1.5), "1.5");
        assert_eq!(canonical_number(0.0), "0");
    }

    #[test]
    fn undefined_and_null_are_one_spelling() {
        assert_eq!(canonical_value(&Any::Undefined), "null");
        assert_eq!(canonical_value(&Any::Null), "null");
    }

    #[test]
    fn a_map_sorts_its_keys() {
        let map: std::collections::HashMap<String, Any> = [
            ("b".to_owned(), Any::from("two")),
            ("a".to_owned(), Any::from("one")),
        ]
        .into();
        assert_eq!(
            canonical_value(&Any::from(map)),
            "{\"a\":\"one\",\"b\":\"two\"}"
        );
    }

    #[test]
    fn the_hashed_mark_suffix_is_stripped() {
        assert_eq!(mark_name("textColor--AbCd1234"), "textColor");
        assert_eq!(mark_name("textColor"), "textColor");
        // Not eight characters, so not a hash.
        assert_eq!(mark_name("some--thing"), "some--thing");
        // A hyphenated name with no hash keeps every byte.
        assert_eq!(mark_name("data--x"), "data--x");
    }
}
