//! Conservative SVG sanitizer for stored custom icons: a port of
//! `packages/shared/src/sanitize-svg.ts`, held to it byte for byte by
//! `tests/fixtures/sanitize-svg.json`, which the TypeScript produces.
//!
//! A custom icon is the one format the app keeps verbatim, and an SVG is a document: it can
//! carry script, event handlers, external references and entity declarations. The icons are
//! rendered through `<img src>`, which runs no script, so this is defense in depth: the bytes
//! in `.memry/icons/` (which also sync to every device) are inert whatever a renderer, an
//! export or another tool does with them. It strips rather than rejects: what is not on the
//! allowlist goes, an `<a>` wrapper is unwrapped and its drawing kept.
//!
//! The TypeScript is a chain of regex replacements. Several of them iterate in quadratic time
//! on hostile input (an unclosed DOCTYPE subset repeated, a long name run with no `>`), and the
//! input can come from a peer, so each pass here is a scanner that reproduces the regex's match
//! exactly and visits each character a bounded number of times ([`steps`] counts the visits).
//!
//! Divergence: text over [`MAX_SVG_BYTES`] is refused (`None`), where the TypeScript would
//! sanitize it. An uploaded icon is at most 2 MiB (`CUSTOM_ICON_MAX_INPUT_BYTES`) before it is
//! sanitized, so no icon written by the app comes near the cap.

mod attrs;
mod scan;
mod strip;
mod tags;

#[doc(hidden)]
pub use scan::steps;

/// The largest SVG this sanitizes: twice the upload cap of an icon.
pub const MAX_SVG_BYTES: usize = 4 * 1024 * 1024;

/// `sanitizeSvgBytes`: the bytes decoded as UTF-8 (a malformed sequence becomes U+FFFD, as
/// Node's `toString('utf8')` does), sanitized, encoded back. `None` when no `<svg` root
/// survives or the text is over [`MAX_SVG_BYTES`]; decoding never shortens the bytes.
pub fn sanitize_svg_bytes(bytes: &[u8]) -> Option<Vec<u8>> {
    sanitize_svg(&String::from_utf8_lossy(bytes)).map(String::into_bytes)
}

/// `sanitizeSvg`: every scripting, external-reference and entity construct stripped. `None`
/// when no `<svg` root survives or the input is over [`MAX_SVG_BYTES`].
pub fn sanitize_svg(input: &str) -> Option<String> {
    if input.len() > MAX_SVG_BYTES {
        return None;
    }
    let text: Vec<char> = input.chars().collect();
    let text = strip::strip_comments(&text);
    let text = strip::strip_doctypes(&text);
    let text = strip::strip_entities(&text);
    let text = strip::strip_processing_instructions(&text);
    let text = strip::strip_cdata(&text);
    let text = strip::strip_forbidden_elements(text);
    let text = strip::strip_unsafe_styles(&text);
    let text = tags::rewrite_tags(&text);
    tags::has_svg_root(&text).then(|| text.into_iter().collect())
}
