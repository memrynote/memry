//! The writer that makes the output inert as a document of its own, whatever opens it: a
//! browser as `image/svg+xml`, Quick Look, an export, or HTML that inlines it.
//!
//! The passes before it follow the TypeScript, whose output is not inert. A `<` left over
//! when the rewrite drops a tag joins the text after it: `<<a>svg onload=x()>` becomes
//! `<svg onload=x()>`, and a DOCTYPE or an ENTITY comes back the same way. Its value checks
//! also miss entities, CSS escapes, prefixes bound to XLink and closers with attributes.
//! Instead of a fix per gap, this writer takes the rewrite's pieces and writes only markup
//! that obeys these rules:
//!
//! - Every `<` in text is written `&lt;`. Text cannot rejoin into markup, so the only `<` in
//!   the output start the tags below: no `<!`, no `<?`.
//! - A tag is kept only when its name is a plain name whose local part is in
//!   [`ELEMENTS`]. Those SVG elements neither run nor load anything themselves, and none is a
//!   point where HTML would parse its content as HTML (`title`, `desc`, `foreignObject`).
//!   A name the TypeScript's style pass reads as a style opener while it is not one
//!   (`<style:rect>`, or an empty `<style/>`) goes too, so a style pass over the output finds
//!   exactly the style elements below.
//! - An attribute is kept only when it has a value, a plain name, and none of `"`, `'`, `&`,
//!   `<` or `\` in the value. The parser decodes an entity after any check here, CSS decodes
//!   an escape, and a quote opens a CSS string. Names compare by local part, so `x:href` with
//!   `x` bound to XLink is still `href`. `on*` goes. `href` and `src` keep only a fragment or
//!   an inert image data URL. `attributeName` may name none of those, and every value passes
//!   [`css_is_inert`], since any attribute can be a presentation attribute (`fill="url(…)"`).
//! - A `<style>` element stays only as opener, text, closer, with text that passes
//!   [`css_is_inert`]. Unsafe CSS drops the element with its text. A tag inside it, or no
//!   closer, drops the opener and leaves the text as plain text.
//!
//! Every rule drops or escapes part of what the TypeScript writes and adds nothing:
//! `tests/sanitize_svg_vectors.rs` checks that against the TypeScript's own output.

use super::attrs::{Attribute, is_safe_url, local_name};
use super::scan::{as_str, prefixed_tag, squash, tick, word_ends};
use super::tags::{Piece, Tag, rewrite_tags};

/// The elements kept, by lowercased local name.
const ELEMENTS: &[&str] = &[
    "svg",
    "g",
    "defs",
    "symbol",
    "use",
    "metadata",
    "switch",
    "view",
    "path",
    "rect",
    "circle",
    "ellipse",
    "line",
    "polyline",
    "polygon",
    "text",
    "tspan",
    "textpath",
    "image",
    "lineargradient",
    "radialgradient",
    "stop",
    "pattern",
    "clippath",
    "mask",
    "marker",
    "filter",
    "feblend",
    "fecolormatrix",
    "fecomponenttransfer",
    "fecomposite",
    "feconvolvematrix",
    "fediffuselighting",
    "fedisplacementmap",
    "fedistantlight",
    "fedropshadow",
    "feflood",
    "fefunca",
    "fefuncb",
    "fefuncg",
    "fefuncr",
    "fegaussianblur",
    "feimage",
    "femerge",
    "femergenode",
    "femorphology",
    "feoffset",
    "fepointlight",
    "fespecularlighting",
    "fespotlight",
    "fetile",
    "feturbulence",
    "style",
    "animate",
    "animatemotion",
    "animatetransform",
    "set",
    "mpath",
];

/// CSS functions that load an image by more than a `url()`. Strings and escapes are refused
/// outright, so these are a second line.
const RESOURCE_FUNCTIONS: [&str; 5] = ["image", "image-set", "cross-fade", "element", "src"];

/// The pieces of the tag rewrite of `text`, written inert. `None` when no `<svg` tag is kept.
pub(super) fn write(text: &[u8]) -> Option<String> {
    let mut writer = Writer {
        out: Vec::with_capacity(text.len()),
        style: None,
        has_root: false,
    };
    rewrite_tags(text, |piece| match piece {
        Piece::Text(text) => writer.text(text),
        Piece::Dropped => writer.unwrap_style(),
        Piece::Tag(tag) => writer.tag(&tag),
    });
    writer.unwrap_style();
    let Writer { out, has_root, .. } = writer;
    has_root.then(|| String::from_utf8(out).expect("the writer adds only ASCII"))
}

struct Writer {
    out: Vec<u8>,
    /// The `<style>` element written last and not closed yet.
    style: Option<OpenStyle>,
    has_root: bool,
}

/// Where an open `<style>` element's opener and text start in the output.
struct OpenStyle {
    opener: usize,
    text: usize,
}

impl Writer {
    fn text(&mut self, text: &[u8]) {
        for &byte in text {
            tick();
            match byte {
                b'<' => self.out.extend_from_slice(b"&lt;"),
                _ => self.out.push(byte),
            }
        }
    }

    /// Drops the opener of the open `<style>`, if any, and keeps its text as plain text.
    fn unwrap_style(&mut self) {
        if let Some(style) = self.style.take() {
            self.out.drain(style.opener..style.text);
        }
    }

    fn tag(&mut self, tag: &Tag<'_>) {
        let is_style = tag.local == "style";
        let reads_as_style = !tag.closing
            && prefixed_tag(tag.name.as_bytes(), 0, "style", word_ends).is_some()
            && (!is_style || tag.self_closing);
        let kept = tag.name.starts_with(|c: char| c.is_ascii_alphabetic())
            && is_plain_name(tag.name)
            && ELEMENTS.contains(&tag.local.as_str())
            && !reads_as_style;
        if let Some(style) = self.style.take() {
            if kept && is_style && tag.closing {
                if css_is_inert(as_str(&self.out[style.text..])) {
                    self.write_closer(tag.name);
                } else {
                    self.out.truncate(style.opener);
                }
                return;
            }
            // Another tag inside the style: its text stays, as plain text.
            self.out.drain(style.opener..style.text);
        }
        if !kept {
            return;
        }
        if tag.closing {
            self.write_closer(tag.name);
            return;
        }
        let opener = self.out.len();
        self.out.push(b'<');
        self.out.extend_from_slice(tag.name.as_bytes());
        for Attribute { name, value } in tag.attributes() {
            let Some(value) = value.filter(|value| keeps(name, value)) else {
                continue;
            };
            self.out.push(b' ');
            self.out.extend_from_slice(name.as_bytes());
            self.out.extend_from_slice(b"=\"");
            self.out.extend_from_slice(value.as_bytes());
            self.out.push(b'"');
        }
        self.out
            .extend_from_slice(if tag.self_closing { b"/>" } else { b">" });
        self.has_root |= tag.local == "svg";
        if is_style && !tag.self_closing {
            self.style = Some(OpenStyle {
                opener,
                text: self.out.len(),
            });
        }
    }

    fn write_closer(&mut self, name: &str) {
        self.out.extend_from_slice(b"</");
        self.out.extend_from_slice(name.as_bytes());
        self.out.push(b'>');
    }
}

/// `[A-Za-z_][A-Za-z0-9_.-]*` between colons: a name every XML and HTML parser reads the same
/// way, and that the TypeScript's prefix chain reads to its last part.
fn is_plain_name(name: &str) -> bool {
    name.split(':').all(|part| {
        let mut bytes = part.bytes();
        bytes
            .next()
            .is_some_and(|first| first.is_ascii_alphabetic() || first == b'_')
            && bytes.all(|byte| {
                tick();
                byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-')
            })
    })
}

/// `"`, `'`, `&`, `<` or `\`: a value holding one means something other than it reads.
fn has_decoded_or_quoted(value: &str) -> bool {
    value.bytes().any(|byte| {
        tick();
        matches!(byte, b'"' | b'\'' | b'&' | b'<' | b'\\')
    })
}

/// Whether the attribute `name="value"`, which the TypeScript kept, stays.
fn keeps(name: &str, value: &str) -> bool {
    if !is_plain_name(name) || has_decoded_or_quoted(value) {
        return false;
    }
    let local = local_name(name);
    if local.starts_with("on") {
        return false;
    }
    if matches!(local.as_str(), "href" | "src") && !is_safe_url(value) {
        return false;
    }
    if local == "attributename" {
        // What an animation writes, after any prefix: never a URL or a handler.
        let target = local_name(&squash(value));
        if matches!(target.as_str(), "href" | "src") || target.starts_with("on") {
            return false;
        }
    }
    css_is_inert(value)
}

/// CSS, or a value CSS may read, that loads nothing: no string, escape, entity or `<`, no
/// `@import`, `expression(` or `javascript:`, no `url(` but `url(#…)`, and none of
/// [`RESOURCE_FUNCTIONS`]. Whitespace and control characters go first, as in the TypeScript.
pub(super) fn css_is_inert(css: &str) -> bool {
    let css = squash(css).to_ascii_lowercase();
    if has_decoded_or_quoted(&css)
        || ["expression(", "javascript:", "@import"]
            .iter()
            .any(|bad| css.contains(bad))
    {
        return false;
    }
    let css = css.as_bytes();
    (0..css.len()).all(|open| {
        tick();
        if css[open] != b'(' {
            return true;
        }
        let start = css[..open]
            .iter()
            .rposition(|byte| {
                tick();
                !(byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_') || *byte >= 0x80)
            })
            .map_or(0, |before| before + 1);
        let function = &css[start..open];
        if function.ends_with(b"url") {
            return css.get(open + 1) == Some(&b'#');
        }
        !RESOURCE_FUNCTIONS
            .iter()
            .any(|resource| function.ends_with(resource.as_bytes()))
    })
}
