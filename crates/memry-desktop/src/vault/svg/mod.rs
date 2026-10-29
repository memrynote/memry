//! Conservative SVG sanitizer for stored custom icons: the passes of
//! `packages/shared/src/sanitize-svg.ts`, then a writer whose output is inert as a document of
//! its own.
//!
//! A custom icon is the one format the app keeps verbatim, and an SVG is a document: it can
//! carry script, event handlers, external references and entity declarations. The app shows
//! icons through `<img src>`, which runs no script, but the bytes in `.memry/icons/` also sync
//! to every device and open in a browser, in Finder or in an export. They must be inert there
//! too. The sanitizer strips rather than rejects: what is not allowed goes, an `<a>` wrapper
//! is unwrapped and its drawing kept.
//!
//! Two stages:
//!
//! 1. The TypeScript's passes, ported exactly. `tests/fixtures/sanitize-svg.json`, which the
//!    TypeScript produces, holds them to it byte for byte through
//!    [`sanitize_svg_as_typescript`]. The TypeScript is a chain of regex replacements, and
//!    several of them take quadratic time on hostile input (an unclosed DOCTYPE subset
//!    repeated, a long name run with no `>`). The input can come from a peer, so each pass
//!    here is a scanner that finds the regex's match and visits each byte a bounded number of
//!    times ([`steps`] counts the visits).
//! 2. `inert`, which writes the rewrite's pieces under rules of its own. The TypeScript's
//!    output is not a contract: a stored icon is re-sanitized on every write. Its output is
//!    also not inert: a `<` left over from a dropped tag rejoins the text after it into a new
//!    tag. So [`sanitize_svg`] differs from the TypeScript wherever those rules drop or escape
//!    something. They never add anything.
//!
//! The work is CPU and memory, linear in the input. At the cap a usual document peaks at about
//! twice its size; text of `<`, each written `&lt;`, at about seven times
//! (`tests/sanitize_svg_memory.rs`). Callers on an async runtime run it on a blocking thread,
//! one icon at a time.
//!
//! Text over [`MAX_SVG_BYTES`] is refused (`None`). Electron reads 2 MiB of upload
//! (`CUSTOM_ICON_MAX_INPUT_BYTES`), but its output can grow six times when `"` becomes
//! `&quot;`, so an icon an Electron build wrote can be over the cap. Such an icon is refused,
//! not cut.

mod attrs;
mod inert;
mod scan;
mod strip;
mod tags;

#[doc(hidden)]
pub use scan::steps;

/// The largest SVG this sanitizes: twice the upload cap of an icon.
pub const MAX_SVG_BYTES: usize = 4 * 1024 * 1024;

/// [`sanitize_svg`] of the bytes decoded as UTF-8. A malformed sequence becomes U+FFFD, as in
/// Node's `toString('utf8')`. Decoding never shortens the bytes, so the cap holds on them.
pub fn sanitize_svg_bytes(bytes: &[u8]) -> Option<Vec<u8>> {
    sanitize_svg(&String::from_utf8_lossy(bytes)).map(String::into_bytes)
}

/// The SVG with every scripting, external-reference and entity construct stripped, and with
/// only inert markup left (`inert`). `None` when no `<svg` tag survives or the input is over
/// [`MAX_SVG_BYTES`].
pub fn sanitize_svg(input: &str) -> Option<String> {
    inert::write(&typescript_passes(input)?)
}

/// What the TypeScript's `sanitizeSvg` returns for `input`, byte for byte. The tests compare it
/// with the TypeScript's own output; the app never writes it.
#[doc(hidden)]
pub fn sanitize_svg_as_typescript(input: &str) -> Option<String> {
    let text = typescript_passes(input)?;
    let mut out = Vec::with_capacity(text.len());
    tags::rewrite_tags(&text, |piece| tags::write_typescript(&mut out, piece));
    tags::has_svg_root(&out).then(|| String::from_utf8(out).expect("cut only at ASCII bytes"))
}

/// The passes before the tag rewrite.
fn typescript_passes(input: &str) -> Option<Vec<u8>> {
    if input.len() > MAX_SVG_BYTES {
        return None;
    }
    // Each pass replaces the text, so no more than two copies are alive at once.
    let mut text = strip::strip_comments(input.as_bytes());
    text = strip::strip_doctypes(&text);
    text = strip::strip_entities(&text);
    text = strip::strip_processing_instructions(&text);
    text = strip::strip_cdata(&text);
    text = strip::strip_forbidden_elements(text);
    Some(strip::strip_unsafe_styles(&text))
}
