//! Port of `packages/shared/src/empty-lines.ts`: blank-line gaps, image lines,
//! Obsidian image embeds, indented code and the serializer's house style.

mod normalize;
mod regions;

use std::sync::LazyLock;

use regex::{Captures, Regex};
use serde::{Deserialize, Serialize};

use crate::markdown::frontmatter::js::js_trim;

pub(crate) use normalize::is_table_row_line;
pub use normalize::{escape_wiki_link_pipes_in_table_rows, normalize_serialized_markdown};
pub use regions::{TextRegion, split_by_code_fences};

/// The body of a JS `\s` as a regex class: `[{JS_WS}]` is `\s`, `[^{JS_WS}]` is `\S`.
pub(crate) const JS_WS: &str = r"\t\n\x0B\x0C\r \u{A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum MarkdownSegment {
    Content {
        text: String,
    },
    Gap {
        #[serde(rename = "extraLines")]
        extra_lines: u64,
    },
}

/// `text.replace(/\n{3,}/g, …)`: every run of three or more newlines becomes
/// `\n\n` + sentinel + `\n\n`, the sentinel carrying the extra blank lines.
fn mark_gaps(text: &str, out: &mut String) {
    let mut rest = text;
    while let Some(at) = rest.find('\n') {
        let run = rest[at..].bytes().take_while(|b| *b == b'\n').count();
        out.push_str(&rest[..at]);
        if run >= 3 {
            out.push_str(&format!("\n\n\0GAP:{}\0\n\n", run - 2));
        } else {
            out.push_str(&rest[at..at + run]);
        }
        rest = &rest[at + run..];
    }
    out.push_str(rest);
}

/// `assembled.split(/\x00GAP:(\d+)\x00/)`: the parts between sentinels and the
/// digits each sentinel held.
fn split_gap_sentinels(text: &str) -> (Vec<&str>, Vec<&str>) {
    let mut parts = Vec::new();
    let mut digits = Vec::new();
    let mut last = 0;
    let mut from = 0;
    while let Some(n) = text[from..].find("\0GAP:") {
        let start = from + n;
        let number = &text[start + 5..];
        let len = number.bytes().take_while(u8::is_ascii_digit).count();
        if len > 0 && number[len..].starts_with('\0') {
            parts.push(&text[last..start]);
            digits.push(&number[..len]);
            last = start + 5 + len + 1;
            from = last;
        } else {
            from = start + 1;
        }
    }
    parts.push(&text[last..]);
    (parts, digits)
}

/// Split markdown into content segments and gap descriptors. Runs of 3+
/// newlines outside code fences become `gap` segments holding the blank lines
/// beyond the standard paragraph break.
pub fn split_markdown_preserving_blanks(markdown: &str) -> Vec<MarkdownSegment> {
    if js_trim(markdown).is_empty() {
        return Vec::new();
    }
    let mut assembled = String::new();
    for region in split_by_code_fences(markdown) {
        if region.is_code {
            assembled.push_str(&region.text);
        } else {
            mark_gaps(&region.text, &mut assembled);
        }
    }

    let (parts, digits) = split_gap_sentinels(&assembled);
    let mut segments = Vec::new();
    for (i, part) in parts.iter().enumerate() {
        let text = part.trim_matches('\n');
        if !text.is_empty() {
            segments.push(MarkdownSegment::Content {
                text: text.to_owned(),
            });
        }
        if let Some(number) = digits.get(i) {
            segments.push(MarkdownSegment::Gap {
                extra_lines: number.parse().unwrap_or(u64::MAX),
            });
        }
    }
    segments
}

/// Assemble markdown segments back into a single string.
pub fn assemble_markdown_with_blanks(segments: &[MarkdownSegment]) -> String {
    let mut result = String::new();
    let mut prev_was_content = false;
    for segment in segments {
        match segment {
            MarkdownSegment::Content { text } => {
                if prev_was_content {
                    result.push_str("\n\n");
                }
                result.push_str(text);
                prev_was_content = true;
            }
            MarkdownSegment::Gap { extra_lines } => {
                result.push_str("\n\n");
                result.push_str(&"\n".repeat(usize::try_from(*extra_lines).unwrap_or(usize::MAX)));
                prev_was_content = false;
            }
        }
    }
    result
}

static STANDALONE_IMAGE_LINE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"^[{JS_WS}]*!\[[^\]]*\]\([^)]+\)[{JS_WS}]*$")).expect("static pattern")
});

/// A standalone image line (`![alt](url)` alone on its line) must be a
/// block-level element for BlockNote to create an image block: a blank line is
/// inserted before and after each such line. Code fences are left as-is.
pub fn separate_block_images(markdown: &str) -> String {
    if !markdown.contains("![") {
        return markdown.to_owned();
    }
    let mut out = String::new();
    for region in split_by_code_fences(markdown) {
        if region.is_code {
            out.push_str(&region.text);
            continue;
        }
        let lines: Vec<&str> = region.text.split('\n').collect();
        let mut result: Vec<&str> = Vec::new();
        for (i, line) in lines.iter().enumerate() {
            if STANDALONE_IMAGE_LINE.is_match(line) {
                if result.last().is_some_and(|last| !js_trim(last).is_empty()) {
                    result.push("");
                }
                result.push(line);
                if lines
                    .get(i + 1)
                    .is_some_and(|next| !js_trim(next).is_empty())
                {
                    result.push("");
                }
                continue;
            }
            result.push(line);
        }
        out.push_str(&result.join("\n"));
    }
    out
}

static WIKI_IMAGE_EMBED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"!\[\[([^\]\[|#]+)(?:\|([^\]\[]*))?\]\]").expect("static pattern")
});

/// Only real image extensions are treated as embedded images.
static IMAGE_EMBED_EXT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i-u:\.(?:png|jpe?g|gif|webp|svg|avif|bmp))$").expect("static pattern")
});

/// Every distinct image target embedded with Obsidian syntax, in first-seen order.
pub fn extract_wiki_image_embed_refs(markdown: &str) -> Vec<String> {
    if !markdown.contains("![[") {
        return Vec::new();
    }
    let mut seen: Vec<String> = Vec::new();
    for region in split_by_code_fences(markdown) {
        if region.is_code {
            continue;
        }
        for caps in WIKI_IMAGE_EMBED.captures_iter(&region.text) {
            let reference = js_trim(&caps[1]);
            if reference.is_empty() || !IMAGE_EMBED_EXT.is_match(reference) {
                continue;
            }
            if !seen.iter().any(|s| s == reference) {
                seen.push(reference.to_owned());
            }
        }
    }
    seen
}

/// Rewrite `![[photo.png]]` into the CommonMark `![photo.png](url)` form.
/// `resolve` maps the embed target to a URL; `None` or an empty URL leaves the
/// embed as it was.
pub fn rewrite_wiki_image_embeds(
    markdown: &str,
    resolve: &mut dyn FnMut(&str) -> Option<String>,
) -> String {
    if !markdown.contains("![[") {
        return markdown.to_owned();
    }
    let mut out = String::new();
    for region in split_by_code_fences(markdown) {
        if region.is_code {
            out.push_str(&region.text);
            continue;
        }
        out.push_str(
            &WIKI_IMAGE_EMBED.replace_all(&region.text, |caps: &Captures| {
                let whole = caps[0].to_owned();
                let reference = js_trim(&caps[1]);
                if reference.is_empty() || !IMAGE_EMBED_EXT.is_match(reference) {
                    return whole;
                }
                let Some(url) = resolve(reference).filter(|url| !url.is_empty()) else {
                    return whole;
                };
                let name = reference.rsplit('/').next().unwrap_or(reference);
                let alt: String = name.chars().filter(|c| *c != '[' && *c != ']').collect();
                format!("![{alt}]({url})")
            }),
        );
    }
    out
}

static LIST_ITEM_LINE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"^[ \t]*(?:[-*+]|[0-9]+[.)])[{JS_WS}]")).expect("static pattern")
});

pub(crate) fn is_list_item_line(line: &str) -> bool {
    LIST_ITEM_LINE.is_match(line)
}

/// `INDENTED_CODE_LINE` (`^(?: {4}|\t)(.*)$`): the line without its indent, or
/// `None` when it is not an indented code line. `.` stops at a line terminator.
fn indented_code_body(line: &str) -> Option<&str> {
    let body = line
        .strip_prefix("    ")
        .or_else(|| line.strip_prefix('\t'))?;
    (!body.contains(['\n', '\r', '\u{2028}', '\u{2029}'])).then_some(body)
}

/// Rewrite CommonMark's indented code blocks as fenced ones, before the parse.
pub fn fence_indented_code_blocks(markdown: &str) -> String {
    if !markdown.contains("\n ")
        && !markdown.contains("\n\t")
        && indented_code_body(markdown).is_none()
    {
        return markdown.to_owned();
    }
    let mut out = String::new();
    for region in split_by_code_fences(markdown) {
        if region.is_code {
            out.push_str(&region.text);
        } else {
            out.push_str(&fence_prose_indented_code(&region.text));
        }
    }
    out
}

fn fence_prose_indented_code(text: &str) -> String {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut out: Vec<&str> = Vec::new();
    let mut previous_non_blank: Option<&str> = None;

    let mut index = 0;
    while index < lines.len() {
        let line = lines[index];
        let opens = !js_trim(line).is_empty()
            && indented_code_body(line).is_some()
            && (previous_non_blank.is_none()
                || (index > 0 && js_trim(lines[index - 1]).is_empty()))
            && !previous_non_blank.is_some_and(is_list_item_line);

        if !opens {
            out.push(line);
            if !js_trim(line).is_empty() {
                previous_non_blank = Some(line);
            }
            index += 1;
            continue;
        }

        let end = indented_run_end(&lines, index);
        out.push("```");
        for body in &lines[index..end] {
            out.push(indented_code_body(body).unwrap_or(body));
        }
        out.push("```");
        previous_non_blank = Some("```");
        index = end;
    }
    out.join("\n")
}

/// End index (exclusive) of the indented run at `start`, trailing blanks excluded.
fn indented_run_end(lines: &[&str], start: usize) -> usize {
    let mut end = start + 1;
    let mut last_content = end;
    while end < lines.len() {
        let line = lines[end];
        if indented_code_body(line).is_some() {
            end += 1;
            last_content = end;
            continue;
        }
        // A blank line only continues the run when indented content follows it.
        if js_trim(line).is_empty() {
            end += 1;
            continue;
        }
        break;
    }
    last_content
}
