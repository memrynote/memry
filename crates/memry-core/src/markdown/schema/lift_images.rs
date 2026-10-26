//! Port of `packages/editor-schema/src/lift-images.ts`.
//!
//! An image inside a paragraph or a heading has nowhere to go in the editor:
//! outside a table cell an image is a block, so ProseMirror drops an `<img>` it
//! meets inside a text block. The images are moved out of the text block in the
//! HTML the markdown parses to, each into a block of its own right after it.
//!
//! Only top-level `<p>` and `<h1>`..`<h6>` are touched. A paragraph holding
//! nothing but images already parses to image blocks, so it is left as it is.
//! A link wrapped around nothing but an image stays in the text block with the
//! image's alt text (or, without one, its target) as its label.
//!
//! The TypeScript scans the HTML string with regexes and no DOM; so does this.
//! The patterns run over bytes with Unicode switched off wherever JavaScript's
//! `i` flag and `\b` are ASCII-only, and spell out JavaScript's `\s`.

use std::sync::OnceLock;

use regex::bytes::{Captures, Regex};

/// JavaScript `\s`.
const JS_WS: &str = r"[\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]";

const VOID_TAGS: [&str; 13] = [
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track",
    "wbr",
];

fn compile(slot: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    slot.get_or_init(|| Regex::new(pattern).expect("a lift-images pattern is valid"))
}

fn tag_pattern() -> &'static Regex {
    static SLOT: OnceLock<Regex> = OnceLock::new();
    compile(
        &SLOT,
        r"<!--(?s:.*?)-->|<(/?)((?i-u:[a-z][a-z0-9-]*))(?-u:\b)[^>]*>",
    )
}

fn image_pattern() -> &'static Regex {
    static SLOT: OnceLock<Regex> = OnceLock::new();
    compile(
        &SLOT,
        &format!(
            r"([ \t]*)(?:<(?i-u:a)(?-u:\b)([^>]*)>{JS_WS}*(<(?i-u:img)(?-u:\b)[^>]*>){JS_WS}*</(?i-u:a)>|(<(?i-u:img)(?-u:\b)[^>]*>))([ \t]*)"
        ),
    )
}

fn any_tag_pattern() -> &'static Regex {
    static SLOT: OnceLock<Regex> = OnceLock::new();
    compile(&SLOT, r"<[^>]*>")
}

fn img_start_pattern() -> &'static Regex {
    static SLOT: OnceLock<Regex> = OnceLock::new();
    compile(&SLOT, r"<(?i-u:img)(?-u:\b)")
}

fn alt_attribute_pattern() -> &'static Regex {
    static SLOT: OnceLock<Regex> = OnceLock::new();
    compile(&SLOT, &format!(r#"{JS_WS}(?i-u:alt)="([^"]*)""#))
}

fn href_attribute_pattern() -> &'static Regex {
    static SLOT: OnceLock<Regex> = OnceLock::new();
    compile(&SLOT, &format!(r#"{JS_WS}(?i-u:href)="([^"]*)""#))
}

fn is_text_block_tag(tag: &str) -> bool {
    matches!(tag, "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6")
}

fn group<'a>(caps: &Captures<'a>, index: usize) -> Option<&'a [u8]> {
    caps.get(index).map(|m| m.as_bytes())
}

fn has_non_whitespace(bytes: &[u8]) -> bool {
    String::from_utf8_lossy(bytes)
        .chars()
        .any(|ch| !crate::markdown::frontmatter::js::is_js_whitespace(ch))
}

struct Split {
    text: Vec<u8>,
    images: Vec<Vec<u8>>,
}

fn split_images_out(inner: &[u8], lift_when_alone: bool) -> Option<Split> {
    if !img_start_pattern().is_match(inner) {
        return None;
    }
    if !lift_when_alone {
        let without_images = image_pattern().replace_all(inner, &b""[..]);
        let without_tags = any_tag_pattern().replace_all(&without_images, &b""[..]);
        if !has_non_whitespace(&without_tags) {
            return None;
        }
    }

    let mut images: Vec<Vec<u8>> = Vec::new();
    let mut text: Vec<u8> = Vec::with_capacity(inner.len());
    let mut copied = 0;
    for caps in image_pattern().captures_iter(inner) {
        let Some(found) = caps.get(0) else { continue };
        text.extend_from_slice(&inner[copied..found.start()]);
        copied = found.end();
        let before = group(&caps, 1).unwrap_or(b"");
        let after = group(&caps, 5).unwrap_or(b"");
        if let (Some(linked_image), Some(link_attributes)) = (group(&caps, 3), group(&caps, 2)) {
            images.push(linked_image.to_vec());
            let label = group_non_empty(alt_attribute_pattern(), linked_image)
                .or_else(|| group_non_empty(href_attribute_pattern(), link_attributes));
            text.extend_from_slice(before);
            if let Some(label) = label {
                text.extend_from_slice(b"<a");
                text.extend_from_slice(link_attributes);
                text.push(b'>');
                text.extend_from_slice(label);
                text.extend_from_slice(b"</a>");
            }
            text.extend_from_slice(after);
        } else {
            images.push(group(&caps, 4).unwrap_or(b"").to_vec());
            let at_edge = found.start() == 0 || found.end() == inner.len();
            if !at_edge && (!before.is_empty() || !after.is_empty()) {
                text.push(b' ');
            }
        }
    }
    text.extend_from_slice(&inner[copied..]);
    Some(Split { text, images })
}

/// `pattern.exec(haystack)?.[1]` when it is a non-empty string.
fn group_non_empty<'a>(pattern: &Regex, haystack: &'a [u8]) -> Option<&'a [u8]> {
    group(&pattern.captures(haystack)?, 1).filter(|label| !label.is_empty())
}

/// The HTML with every lifted image moved, or `None` when there was none to lift.
pub fn lift_images_out_of_text_blocks(html: &str) -> Option<String> {
    let bytes = html.as_bytes();
    let mut out: Vec<u8> = Vec::new();
    let mut copied = 0usize;
    let mut depth = 0usize;
    let mut block: Option<(String, usize)> = None;

    for caps in tag_pattern().captures_iter(bytes) {
        let (Some(token), Some(raw_tag)) = (caps.get(0), caps.get(2)) else {
            continue;
        };
        let tag = String::from_utf8_lossy(raw_tag.as_bytes()).to_ascii_lowercase();
        if VOID_TAGS.contains(&tag.as_str()) {
            continue;
        }
        let closing = caps.get(1).is_some_and(|m| !m.is_empty());
        if !closing {
            if depth == 0 && is_text_block_tag(&tag) {
                block = Some((tag, token.end()));
            }
            depth += 1;
            continue;
        }
        depth = depth.saturating_sub(1);
        if depth > 0 {
            continue;
        }
        if let Some((block_tag, inner_start)) = &block
            && *block_tag == tag
            && let Some(split) = split_images_out(&bytes[*inner_start..token.start()], tag != "p")
        {
            out.extend_from_slice(&bytes[copied..*inner_start]);
            out.extend_from_slice(&split.text);
            out.extend_from_slice(token.as_bytes());
            for image in &split.images {
                out.extend_from_slice(image);
            }
            copied = token.end();
        }
        block = None;
    }

    if copied == 0 {
        return None;
    }
    out.extend_from_slice(&bytes[copied..]);
    Some(String::from_utf8_lossy(&out).into_owned())
}
