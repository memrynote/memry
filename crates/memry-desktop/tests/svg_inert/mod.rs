//! What an inert SVG is, checked on the sanitizer's output without its code. The output may
//! hold only text and plain tags, and no tag, attribute or style may run script or load
//! anything from outside the document, whatever opens it.

#![allow(dead_code, reason = "each test binary uses a part of it")]

/// Elements that run script, load something by themselves, or make HTML parse their content as
/// HTML.
const DANGEROUS_ELEMENTS: &[&str] = &[
    "script",
    "foreignobject",
    "iframe",
    "embed",
    "object",
    "handler",
    "listener",
    "a",
    "title",
    "desc",
    "img",
    "link",
    "meta",
    "base",
    "audio",
    "video",
    "source",
    "input",
    "form",
    "body",
    "html",
    "frame",
    "applet",
    "include",
];

/// `Err` naming the first construct that is not inert.
pub fn check_inert(svg: &str) -> Result<(), String> {
    let mut at = 0;
    // The open style's name and where its text starts.
    let mut style: Option<(&str, usize)> = None;
    while let Some(offset) = svg[at..].find('<') {
        let lt = at + offset;
        let (tag, end) = parse_tag(svg, lt)
            .ok_or_else(|| format!("markup that is no plain tag: {}", near(svg, lt)))?;
        if let Some((opener, text)) = style.take() {
            check_css(&svg[text..lt]).map_err(|err| format!("style text: {err}"))?;
            // XML ends a style only at its own name, and HTML at no other one.
            if !(tag.closing && tag.name == opener) {
                return Err(format!("a style that does not end here: {}", near(svg, lt)));
            }
        }
        check_tag(&tag).map_err(|err| format!("{err}: {}", near(svg, lt)))?;
        if !tag.closing && !tag.self_closing && local(tag.name) == "style" {
            style = Some((tag.name, end));
        }
        at = end;
    }
    match style {
        Some(_) => Err("a style with no closer".into()),
        None => Ok(()),
    }
}

fn near(svg: &str, at: usize) -> String {
    svg[at..].chars().take(60).collect()
}

struct Tag<'a> {
    name: &'a str,
    closing: bool,
    self_closing: bool,
    attributes: Vec<(&'a str, &'a str)>,
}

fn name_len(text: &str) -> usize {
    text.bytes()
        .take_while(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-'))
        .count()
}

/// `</?N( N="[^"]*")*/?>` at `lt`, the name starting with a letter: the tag and the index after
/// it.
fn parse_tag(svg: &str, lt: usize) -> Option<(Tag<'_>, usize)> {
    let mut at = lt + 1;
    let closing = svg[at..].starts_with('/');
    at += usize::from(closing);
    if !svg[at..].starts_with(|c: char| c.is_ascii_alphabetic()) {
        return None;
    }
    let name = &svg[at..at + name_len(&svg[at..])];
    at += name.len();
    let mut attributes = Vec::new();
    loop {
        let rest = &svg[at..];
        if rest.starts_with('>') {
            return Some((
                Tag {
                    name,
                    closing,
                    self_closing: false,
                    attributes,
                },
                at + 1,
            ));
        }
        if rest.starts_with("/>") && !closing {
            return Some((
                Tag {
                    name,
                    closing,
                    self_closing: true,
                    attributes,
                },
                at + 2,
            ));
        }
        let rest = rest.strip_prefix(' ').filter(|_| !closing)?;
        let attribute = &rest[..name_len(rest)];
        let value = rest[attribute.len()..].strip_prefix("=\"")?;
        let value = &value[..value.find('"')?];
        if attribute.is_empty() {
            return None;
        }
        attributes.push((attribute, value));
        at += 1 + attribute.len() + 2 + value.len() + 1;
    }
}

fn local(name: &str) -> String {
    name.rsplit(':').next().unwrap_or(name).to_ascii_lowercase()
}

/// A value as HTML hands it to CSS, a NUL read as U+FFFD, without the whitespace CSS skips. A
/// control character stays: CSS reads it as itself.
fn squash(value: &str) -> String {
    value
        .replace('\0', "\u{FFFD}")
        .chars()
        .filter(|c| !c.is_ascii_whitespace())
        .collect::<String>()
        .to_ascii_lowercase()
}

/// A URL value as the URL parser gets it: HTML reads a NUL as U+FFFD, XML a tab or line break
/// as a space, and the parser strips the C0 controls and spaces at both ends but not inside.
fn read_url(value: &str) -> String {
    value
        .replace('\0', "\u{FFFD}")
        .replace(['\t', '\n', '\r'], " ")
        .trim_matches(|c: char| c <= ' ')
        .to_ascii_lowercase()
}

fn check_tag(tag: &Tag<'_>) -> Result<(), String> {
    if DANGEROUS_ELEMENTS.contains(&local(tag.name).as_str()) {
        return Err(format!("element {}", tag.name));
    }
    for (name, value) in &tag.attributes {
        let attribute = local(name);
        if attribute.starts_with("on") || attribute == "base" {
            return Err(format!("attribute {name}"));
        }
        if value.contains(['&', '<', '\\', '\'']) {
            return Err(format!("{name} holds a value that decodes or quotes"));
        }
        if matches!(attribute.as_str(), "href" | "src") && !is_inert_url(&read_url(value)) {
            return Err(format!("{name} loads {value}"));
        }
        let target = local(&squash(value));
        if attribute == "attributename"
            && (matches!(target.as_str(), "href" | "src" | "base") || target.starts_with("on"))
        {
            return Err(format!("an animation of {value}"));
        }
        check_css(value).map_err(|err| format!("{name}: {err}"))?;
    }
    Ok(())
}

fn is_inert_url(url: &str) -> bool {
    url.is_empty()
        || url.starts_with('#')
        || ["png", "jpeg", "jpg", "gif", "webp"]
            .iter()
            .any(|kind| url.starts_with(&format!("data:image/{kind};base64,")))
}

/// CSS that can reach nothing: no string, escape or entity, no import or script, and a
/// `url()` only to a fragment.
fn check_css(css: &str) -> Result<(), String> {
    let css = squash(css);
    for bad in [
        "&",
        "\\",
        "'",
        "\"",
        "@import",
        "expression(",
        "javascript:",
        "image-set(",
        "image(",
        "cross-fade(",
        "element(",
        "src(",
    ] {
        if css.contains(bad) {
            return Err(format!("CSS with {bad}: {css}"));
        }
    }
    if css
        .match_indices("url(")
        .any(|(at, _)| !css[at + 4..].starts_with('#'))
    {
        return Err(format!("CSS loading a URL: {css}"));
    }
    Ok(())
}

/// Whether `strict` is `typescript` with parts left out and some `<` written `&lt;`: the only
/// two ways the inert writer may differ from the TypeScript. Each piece of `strict` matches
/// where its match ends first, which never loses an alignment that exists.
pub fn only_drops_or_escapes(strict: &[u8], typescript: &[u8]) -> bool {
    let subsequence_end = |piece: &[u8], mut from: usize| {
        for byte in piece {
            from += typescript.get(from..)?.iter().position(|b| b == byte)? + 1;
        }
        Some(from)
    };
    let (mut s, mut t) = (0, 0);
    while s < strict.len() {
        let next = if strict[s..].starts_with(b"&lt;") {
            let escaped = typescript[t..]
                .iter()
                .position(|b| *b == b'<')
                .map(|at| t + at + 1);
            let literal = subsequence_end(b"&lt;", t);
            s += 4;
            escaped.into_iter().chain(literal).min()
        } else {
            s += 1;
            subsequence_end(&strict[s - 1..s], t)
        };
        let Some(next) = next else {
            return false;
        };
        t = next;
    }
    true
}
