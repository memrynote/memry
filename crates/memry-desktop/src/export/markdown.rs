//! Port of `export-utils.ts` `markdownToHtml`: comments left out, wiki links
//! outside code as spans, footnotes as superscripts and a Notes list, then the
//! markdown rendered with comrak set up as `marked` (`gfm: true`, `breaks: true`).

use std::sync::LazyLock;

use memry_core::markdown::shared::markdown_code::{mask_markdown_code, replace_markdown_comments};
use regex::Regex;

use super::footnotes::scan_footnotes;
use super::js_trim;
use super::marked::render_markdown;

/// Converts note markdown to the HTML of the export's `.note-content`.
pub(super) fn markdown_to_html(markdown: &str) -> String {
    let uncommented = replace_markdown_comments(
        markdown,
        &mut |_, _, block_goes_on| {
            if block_goes_on {
                "<!---->".to_owned()
            } else {
                String::new()
            }
        },
        "&lt;!--",
        "&lt;!--",
    );
    let (body, notes) = render_footnotes(&replace_prose_wiki_links(&uncommented));
    render_markdown(&body) + &notes
}

/// `marked.parseInline`: the text as inline content, each line break a `<br>`.
/// Blank lines end a paragraph in comrak but are only more breaks inline, so
/// each run between them renders on its own. A lone `\r` ends a line in comrak,
/// so it is one here too, where `parseInline` keeps it as text.
fn render_inline(text: &str) -> String {
    let text = text.replace('\r', "\n");
    let mut out = String::new();
    let mut lines = text.split('\n').peekable();
    while lines.peek().is_some() {
        let mut chunk = Vec::new();
        while let Some(line) = lines.next_if(|line| !line.is_empty()) {
            chunk.push(line);
        }
        out.push_str(&render_inline_run(&chunk));
        while lines.next_if(|line| line.is_empty()).is_some() {
            out.push_str("<br>");
        }
        if lines.peek().is_some() {
            out.push_str("<br>");
        }
    }
    out
}

/// The first line of the paragraph [`render_inline_run`] renders, and what it
/// renders to.
const SENTINEL: &str = "x";
const SENTINEL_HTML: &str = "<p>x<br>";

/// One run of non-blank lines as inline content. comrak parses only whole
/// documents, where a line could open a block (`# a`, `- a`, `1. a`, `> a`, a
/// fence, `---`, `===`, `<div>`, `[a]: /url`, a table's delimiter row). So the
/// lines render as the continuation of a paragraph a sentinel line opens, each
/// indented four spaces: such a line continues a paragraph and opens no block,
/// and comrak drops the indent. A line's own leading whitespace goes with it,
/// where `parseInline` keeps it after the `<br>`.
fn render_inline_run(lines: &[&str]) -> String {
    if lines.is_empty() {
        return String::new();
    }
    let mut source = String::from(SENTINEL);
    for line in lines {
        source.push_str("\n    ");
        source.push_str(line);
    }
    let html = render_markdown(&source);
    match html
        .strip_prefix(SENTINEL_HTML)
        .and_then(|rest| rest.strip_suffix("</p>\n"))
    {
        Some(inner) => inner.to_owned(),
        None => {
            tracing::error!("export rendered a footnote outside its paragraph");
            html
        }
    }
}

/// `maskMarkdownCode` with each code character blanked to as many spaces as
/// it has bytes, so byte offsets match the source. The core's mask keeps
/// UTF-16 lengths, as the TypeScript does.
pub(super) fn byte_mask(markdown: &str) -> String {
    let masked: Vec<u16> = mask_markdown_code(markdown).encode_utf16().collect();
    let mut out = String::with_capacity(markdown.len());
    let mut at = 0;
    let mut units = [0u16; 2];
    for c in markdown.chars() {
        let source = c.encode_utf16(&mut units);
        let end = at + source.len();
        if masked.get(at..end) == Some(&*source) {
            out.push(c);
        } else {
            out.extend(std::iter::repeat_n(' ', c.len_utf8()));
        }
        at = end;
    }
    out
}

thread_local! {
    static STEPS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Bytes the footnote and wiki-link passes have written on this thread, for the
/// linear-time test.
#[cfg(feature = "test-hooks")]
pub fn steps() -> usize {
    STEPS.with(std::cell::Cell::get)
}

fn count_steps(bytes: usize) {
    STEPS.with(|steps| steps.set(steps.get() + bytes));
}

static WIKI_LINK_RUN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[\[([^\]|]+)(?:\|([^\]]+))?\]\]").expect("valid regex"));

/// `wikiLinkLabel`: the alias when it has text, else the note half, else the
/// heading half.
fn wiki_link_label(target: &str, alias: Option<&str>) -> String {
    let chosen = alias.map(js_trim).unwrap_or("");
    if !chosen.is_empty() {
        return chosen.to_owned();
    }
    let raw = js_trim(target);
    let Some(hash) = raw.find('#') else {
        return raw.to_owned();
    };
    let note = js_trim(&raw[..hash]);
    if !note.is_empty() {
        return note.to_owned();
    }
    js_trim(raw[hash + 1..].rsplit('#').next().unwrap_or("")).to_owned()
}

/// Wiki links outside code as spans. The label goes in as written, unescaped,
/// as `replaceWikiLinks` does.
fn replace_prose_wiki_links(markdown: &str) -> String {
    let masked = byte_mask(markdown);
    let (source, mask) = (markdown.as_bytes(), masked.as_bytes());
    let mut out = String::with_capacity(markdown.len());
    let mut start = 0;
    while start < source.len() {
        let prose = source[start] == mask[start];
        let mut end = start;
        while end < source.len() && (source[end] == mask[end]) == prose {
            end += 1;
        }
        let run = &markdown[start..end];
        if prose {
            out.push_str(
                &WIKI_LINK_RUN.replace_all(run, |found: &regex::Captures<'_>| {
                    let label = wiki_link_label(&found[1], found.get(2).map(|m| m.as_str()));
                    format!("<span class=\"wiki-link\">{label}</span>")
                }),
            );
        } else {
            out.push_str(run);
        }
        start = end;
    }
    count_steps(out.len());
    out
}

/// Footnotes as numbered superscripts and a Notes list at the end with
/// back-links (BBF-24). Every definition line leaves the body.
fn render_footnotes(markdown: &str) -> (String, String) {
    let masked = byte_mask(markdown);
    let (references, definitions) = scan_footnotes(markdown, &masked);
    if definitions.is_empty() {
        return (markdown.to_owned(), String::new());
    }

    let mut uses = std::collections::HashMap::<usize, usize>::new();
    let mut edits: Vec<(usize, usize, String)> = references
        .iter()
        .map(|reference| {
            let number = reference.number;
            let use_count = uses.entry(number).or_insert(0);
            *use_count += 1;
            let id = if *use_count == 1 {
                format!("fnref-{number}")
            } else {
                format!("fnref-{number}-{use_count}")
            };
            let text = format!(
                "<sup class=\"footnote-ref\"><a href=\"#fn-{number}\" id=\"{id}\">{number}</a></sup>"
            );
            (reference.start, reference.end, text)
        })
        .chain(definitions.iter().map(|d| (d.start, d.end, String::new())))
        .collect();
    edits.sort_by_key(|edit| edit.0);

    // One forward pass: an edit in place moves the rest of the note each time.
    let mut body = String::with_capacity(markdown.len());
    let mut copied = 0;
    for (start, end, text) in edits {
        body.push_str(&markdown[copied..start]);
        body.push_str(&text);
        count_steps(start - copied + text.len());
        copied = end;
    }
    body.push_str(&markdown[copied..]);

    let mut numbered: Vec<_> = definitions
        .iter()
        .filter_map(|d| d.number.map(|number| (number, &d.text)))
        .collect();
    numbered.sort_by_key(|(number, _)| *number);
    let items: Vec<String> = numbered
        .into_iter()
        .map(|(number, text)| {
            format!(
                "<li id=\"fn-{number}\">{} <a href=\"#fnref-{number}\" class=\"footnote-backref\" aria-label=\"Back to reference {number}\">\u{21a9}</a></li>",
                render_inline(text)
            )
        })
        .collect();
    let notes = if items.is_empty() {
        String::new()
    } else {
        format!(
            "<section class=\"footnotes\">\n<h2>Notes</h2>\n<ol>\n{}\n</ol>\n</section>\n",
            items.join("\n")
        )
    };
    (body, notes)
}
