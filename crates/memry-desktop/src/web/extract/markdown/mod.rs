//! `createMarkdownContent` of `dist/markdown.js`: content HTML to markdown through turndown,
//! then Defuddle's clean-up of the result.
//!
//! `toMarkdown(result, { markdown: true })` assigns this to `result.content`; the pipeline that
//! calls it arrives with the `Defuddle` class. The rules are in `rules`, the turndown port in
//! `turndown`.

pub mod rules;
pub mod turndown;

use std::sync::LazyLock;

use regex::Regex;

use crate::web::extract::utils::js::{WS, trim};

static WBR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"(?i-u:<wbr){}*/?>", WS)).expect("static pattern"));
/// `/^# .+\n+/`: a title heading on the first line. `.` stops at any line terminator.
static LEADING_TITLE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^# [^\n\r\u{2028}\u{2029}]+\n+").expect("static pattern"));
static EXTRA_NEWLINES: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\n{3,}").expect("static pattern"));

/// `markdown.replace(/\n*(?<!!)\[]\([^)]+\)\n*/g, '')`: an empty link and the newlines around
/// it. The lookbehind only bites when no newline precedes the `[`, so a `![](x)` image stays.
fn remove_empty_links(markdown: &str) -> String {
    let chars: Vec<char> = markdown.chars().collect();
    let mut out = String::with_capacity(markdown.len());
    let mut i = 0;
    while i < chars.len() {
        let mut bracket = i;
        while chars.get(bracket) == Some(&'\n') {
            bracket += 1;
        }
        let preceded_by_bang = bracket == i && i > 0 && chars[i - 1] == '!';
        if chars.get(bracket) == Some(&'[')
            && !preceded_by_bang
            && let Some(end) = empty_link_end(&chars, bracket)
        {
            i = end;
            continue;
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// The index after `[](url)` and its trailing newlines, when `chars[at..]` starts one.
fn empty_link_end(chars: &[char], at: usize) -> Option<usize> {
    if chars.get(at + 1) != Some(&']') || chars.get(at + 2) != Some(&'(') {
        return None;
    }
    let url_start = at + 3;
    let url_len = chars[url_start..].iter().take_while(|&&c| c != ')').count();
    if url_len == 0 || chars.get(url_start + url_len) != Some(&')') {
        return None;
    }
    let mut end = url_start + url_len + 1;
    while chars.get(end) == Some(&'\n') {
        end += 1;
    }
    Some(end)
}

/// `markdown.replace(/!(?=!\[|\[!\[)/g, '! ')`: a space between `!` and image syntax.
fn space_before_images(markdown: &str) -> String {
    let mut out = String::with_capacity(markdown.len());
    for (i, c) in markdown.char_indices() {
        out.push(c);
        let rest = &markdown[i + c.len_utf8()..];
        if c == '!' && (rest.starts_with("![") || rest.starts_with("[![")) {
            out.push(' ');
        }
    }
    out
}

pub fn create_markdown_content(content: &str) -> String {
    // <wbr> hints are invisible in browsers but would insert spaces during conversion.
    let content = WBR.replace_all(content, "");
    let mut markdown = match turndown::turndown(&content) {
        Ok(markdown) => markdown,
        // JS logs the error and returns the HTML under a notice.
        Err(error) => {
            tracing::error!(%error, "Error converting HTML to Markdown");
            return format!(
                "Partial conversion completed with errors. Original HTML:\n\n{content}"
            );
        }
    };
    // The title heading at the start goes.
    if let Some(title) = LEADING_TITLE.find(&markdown) {
        markdown = markdown[title.end()..].to_string();
    }
    let markdown = remove_empty_links(&markdown);
    let markdown = space_before_images(&markdown);
    let markdown = EXTRA_NEWLINES.replace_all(&markdown, "\n\n");
    trim(&markdown).to_string()
}
