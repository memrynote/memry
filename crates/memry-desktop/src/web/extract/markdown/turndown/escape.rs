//! `TurndownService#escape` as `createMarkdownContent` configures it: turndown's
//! `markdownEscapes` followed by Defuddle's tag-like `<` escape (`dist/markdown.js:39-41`).

use std::sync::LazyLock;

use regex::Regex;

use crate::web::extract::utils::js::is_js_whitespace;

/// `markdownEscapes`, applied in order. The `^` anchors are string starts (no `m` flag).
static ESCAPES: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    [
        (r"\\", r"\\"),
        (r"\*", r"\*"),
        (r"^-", r"\-"),
        (r"^\+ ", r"\+ "),
        (r"^(=+)", r"\${1}"),
        (r"^(#{1,6}) ", r"\${1} "),
        (r"`", r"\`"),
        (r"^~~~", r"\~~~"),
        (r"\[", r"\["),
        (r"\]", r"\]"),
        (r"^>", r"\>"),
        (r"_", r"\_"),
        (r"^([0-9]+)\. ", r"${1}\. "),
    ]
    .into_iter()
    .map(|(pattern, replacement)| (Regex::new(pattern).expect("static pattern"), replacement))
    .collect()
});

/// Whether `rest` (the text after a `<`) matches `\/?[A-Za-z][A-Za-z0-9-]*(?:\s|\/?>)`.
fn opens_tag(rest: &str) -> bool {
    let rest = rest.strip_prefix('/').unwrap_or(rest);
    let mut chars = rest.char_indices();
    match chars.next() {
        Some((_, c)) if c.is_ascii_alphabetic() => {}
        _ => return false,
    }
    let after_name = chars
        .find(|&(_, c)| !(c.is_ascii_alphanumeric() || c == '-'))
        .map_or(rest.len(), |(i, _)| i);
    let tail = &rest[after_name..];
    tail.starts_with('>')
        || tail.starts_with("/>")
        || tail.chars().next().is_some_and(is_js_whitespace)
}

pub fn escape(string: &str) -> String {
    let mut text = string.to_string();
    for (pattern, replacement) in ESCAPES.iter() {
        text = pattern.replace_all(&text, *replacement).into_owned();
    }
    let mut out = String::with_capacity(text.len());
    for (i, c) in text.char_indices() {
        if c == '<' && opens_tag(&text[i + 1..]) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::escape;

    // The same inputs sit in `markdown-cases.json`, whose expected values Node produced.
    #[test]
    fn escapes_markdown_and_tag_like_text() {
        assert_eq!(
            escape("a*b_c [x] `y` \\z"),
            "a\\*b\\_c \\[x\\] \\`y\\` \\\\z"
        );
        assert_eq!(escape("# h"), "\\# h");
        assert_eq!(escape("1. one"), "1\\. one");
        assert_eq!(
            escape("Monte<video> a<b <a@b.com> </p> <br/>"),
            "Monte\\<video> a\\<b <a@b.com> \\</p> \\<br/>"
        );
    }
}
