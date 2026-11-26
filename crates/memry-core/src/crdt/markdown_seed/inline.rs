//! Inline markdown to the runs BlockNote writes.
//!
//! Four stages, each mirroring one layer desktop's text passes through:
//!
//! 1. BlockNote's `parseInline` (`markdownToHtml.ts`), ported to build the
//!    HTML tree it would print instead of the string;
//! 2. `preprocessHTMLWhitespace` (`normalizeWhitespace.ts`): a DOM text node
//!    holding a newline has every whitespace run collapsed to one space;
//! 3. ProseMirror's parse and `contentNodeToInlineContent`
//!    (`nodeToBlock.ts`): marks from the tags (a code mark excludes every
//!    other mark), a hard break appended to the run before it as `\n`;
//! 4. desktop's repair (`@memry/editor-schema/parse-markdown`): the break
//!    artifact after a newline, the first run's leading blank, the hard-break
//!    tokens — on plain text runs only, never inside a link.

use crate::domain::journal_rules::js_trim;

use super::links::{closing, destination_and_title, link};
use super::media::{self, Media};
use super::runs;
use super::{SeedInline, Unsupported};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Tag {
    Strong,
    Em,
    Del,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Html {
    Text(String),
    Br,
    Wrap(Tag, Vec<Html>),
    Code(String),
    Link {
        href: String,
        children: Vec<Html>,
    },
    /// An `<img>` or a `<video>`.
    Media(Media),
}

/// The inline content of a text block nested in a list or a quote, where an
/// image has no block to become. `breaks` are the hard-break spellings
/// `mask_hard_breaks` took, which decides whether tokens unmask.
pub(super) fn inline_content(
    text: &str,
    breaks: &[String],
) -> Result<Vec<SeedInline>, Unsupported> {
    let html = parse(text)?;
    if holds_media(&html) {
        // Desktop's parse drops it, or makes it a child block of a list item.
        return Err(Unsupported("image in a list or quote"));
    }
    Ok(runs::block_content(html, breaks))
}

/// `parseInline` on one block's text.
pub(super) fn parse(text: &str) -> Result<Vec<Html>, Unsupported> {
    let chars: Vec<char> = text.chars().collect();
    parse_inline(&chars)
}

pub(super) fn holds_media(nodes: &[Html]) -> bool {
    holds(nodes, &|_| true)
}

fn holds(nodes: &[Html], test: &dyn Fn(&Media) -> bool) -> bool {
    nodes.iter().any(|node| match node {
        Html::Media(media) => test(media),
        Html::Wrap(_, children) | Html::Link { children, .. } => holds(children, test),
        _ => false,
    })
}

/// The inline content of one table cell (`Table/block.ts`
/// `parseTableContent`). `code_kept` is whether `maskCellCodeSpaces` masked
/// the whitespace of the cell's row, which keeps its code spans' spaces.
pub(super) fn cell_content(
    text: &str,
    breaks: &[String],
    code_kept: bool,
) -> Result<Vec<SeedInline>, Unsupported> {
    let html = parse(text)?;
    if holds(&html, &|media| match media {
        Media::Image { url, .. } => js_trim(url).is_empty(),
        Media::Video { .. } => true,
    }) {
        // `inlineImage` claims an `<img>` with a `src` only.
        return Err(Unsupported("video or empty image in a table cell"));
    }
    Ok(runs::cell_content(html, breaks, code_kept))
}

fn push_text(nodes: &mut Vec<Html>, text: &str) {
    if let Some(Html::Text(last)) = nodes.last_mut() {
        last.push_str(text);
    } else {
        nodes.push(Html::Text(text.to_owned()));
    }
}

pub(super) fn collect(chars: &[char]) -> String {
    chars.iter().collect()
}

const SPECIAL: &[char] = &['\\', '`', '!', '[', '~', '*', '_', '\n', '<'];
const ESCAPABLE: &str = "\\`*_{}[]()#+-.!~|>";

/// `parseInline`.
fn parse_inline(text: &[char]) -> Result<Vec<Html>, Unsupported> {
    let mut nodes = Vec::new();
    let mut i = 0;
    while i < text.len() {
        if text[i] == '\n' && i >= 2 && text[i - 1] == ' ' && text[i - 2] == ' ' {
            if let Some(Html::Text(last)) = nodes.last_mut() {
                let kept = last.trim_end_matches(' ').len();
                last.truncate(kept);
            }
            nodes.push(Html::Br);
            push_text(&mut nodes, "\n");
            i += 1;
            continue;
        }
        if SPECIAL.contains(&text[i])
            && let Some(end) = inline_token(text, i, &mut nodes)?
        {
            i = end;
            continue;
        }
        let start = i;
        i += 1;
        while i < text.len() && !SPECIAL.contains(&text[i]) {
            i += 1;
        }
        push_text(&mut nodes, &collect(&text[start..i]));
    }
    Ok(nodes)
}

/// The tokenizers of `parseInline`, in priority order. Pushes what matched
/// and returns where it ends.
fn inline_token(
    text: &[char],
    i: usize,
    nodes: &mut Vec<Html>,
) -> Result<Option<usize>, Unsupported> {
    let at = |offset: usize| text.get(i + offset).copied();

    if text[i] == '\\' && i + 1 < text.len() {
        let next = text[i + 1];
        if next == '\n' {
            nodes.push(Html::Br);
            push_text(nodes, "\n");
            return Ok(Some(i + 2));
        }
        if ESCAPABLE.contains(next) {
            push_text(nodes, &next.to_string());
            return Ok(Some(i + 2));
        }
    }
    if text[i] == '`'
        && let Some((code, end)) = inline_code(text, i)
    {
        nodes.push(Html::Code(code));
        return Ok(Some(end));
    }
    if text[i] == '!'
        && at(1) == Some('[')
        && let Some((found, end)) = image(text, i)?
    {
        nodes.push(Html::Media(found));
        return Ok(Some(end));
    }
    if text[i] == '['
        && let Some((href, inner, end)) = link(text, i)
    {
        let children = parse_inline(inner)?;
        if contains_link(&children) {
            return Err(Unsupported("nested link"));
        }
        nodes.push(Html::Link { href, children });
        return Ok(Some(end));
    }
    if text[i] == '~'
        && at(1) == Some('~')
        && let Some(end) = delimited(text, i, 2, Tag::Del, nodes)?
    {
        return Ok(Some(end));
    }
    let run3 = |c: char| at(0) == Some(c) && at(1) == Some(c) && at(2) == Some(c);
    if (run3('*') || (run3('_') && !intraword(text, i, 3)))
        && let Some(end) = delimited_with(text, i, 3, nodes, |children| {
            Html::Wrap(Tag::Strong, vec![Html::Wrap(Tag::Em, children)])
        })?
    {
        return Ok(Some(end));
    }
    let run2 = |c: char| at(0) == Some(c) && at(1) == Some(c);
    if (run2('*') || (run2('_') && !intraword(text, i, 2)))
        && let Some(end) = delimited(text, i, 2, Tag::Strong, nodes)?
    {
        return Ok(Some(end));
    }
    if (text[i] == '*' || (text[i] == '_' && !intraword(text, i, 1)))
        && let Some(end) = delimited(text, i, 1, Tag::Em, nodes)?
    {
        return Ok(Some(end));
    }
    if text[i] == '<'
        && at(1).is_some_and(|c| c.is_ascii_alphabetic() || matches!(c, '/' | '!' | '?'))
    {
        return Err(Unsupported("HTML"));
    }
    if text[i] == '\n' {
        nodes.push(Html::Br);
        push_text(nodes, "\n");
        return Ok(Some(i + 1));
    }
    Ok(None)
}

/// `parseImage`: `![alt](url "title")`, the alt as written.
fn image(text: &[char], start: usize) -> Result<Option<(Media, usize)>, Unsupported> {
    let Some(alt_end) = closing(text, start + 1, '[', ']') else {
        return Ok(None);
    };
    if text.get(alt_end + 1) != Some(&'(') {
        return Ok(None);
    }
    let Some(paren_end) = closing(text, alt_end + 1, '(', ')') else {
        return Ok(None);
    };
    let (url, title) = destination_and_title(&text[alt_end + 2..paren_end]);
    let alt = collect(&text[start + 2..alt_end]);
    Ok(Some((media::media(url, alt, title)?, paren_end + 1)))
}

fn contains_link(nodes: &[Html]) -> bool {
    nodes.iter().any(|node| match node {
        Html::Link { .. } => true,
        Html::Wrap(_, children) => contains_link(children),
        _ => false,
    })
}

/// `/\w/` on the characters either side of a delimiter run.
fn intraword(text: &[char], i: usize, len: usize) -> bool {
    let word = |c: Option<&char>| c.is_some_and(|c| c.is_ascii_alphanumeric() || *c == '_');
    word(i.checked_sub(1).and_then(|before| text.get(before))) && word(text.get(i + len))
}

/// `parseInlineCode`.
fn inline_code(text: &[char], start: usize) -> Option<(String, usize)> {
    let open = text[start..].iter().take_while(|c| **c == '`').count();
    let from = start + open;
    let mut j = from;
    while j < text.len() {
        if text[j] != '`' {
            j += 1;
            continue;
        }
        let close_start = j;
        while j < text.len() && text[j] == '`' {
            j += 1;
        }
        if j - close_start == open {
            let mut code: Vec<char> = text[from..close_start]
                .iter()
                .map(|c| if *c == '\n' { ' ' } else { *c })
                .collect();
            if code.len() >= 2
                && code[0] == ' '
                && code[code.len() - 1] == ' '
                && code.iter().any(|c| *c != ' ')
            {
                code = code[1..code.len() - 1].to_vec();
            }
            return Some((collect(&code), j));
        }
    }
    None
}

fn delimited(
    text: &[char],
    start: usize,
    len: usize,
    tag: Tag,
    nodes: &mut Vec<Html>,
) -> Result<Option<usize>, Unsupported> {
    delimited_with(text, start, len, nodes, |children| {
        Html::Wrap(tag, children)
    })
}

/// `parseDelimited`.
fn delimited_with(
    text: &[char],
    start: usize,
    len: usize,
    nodes: &mut Vec<Html>,
    wrap: impl FnOnce(Vec<Html>) -> Html,
) -> Result<Option<usize>, Unsupported> {
    let delimiter = &text[start..start + len];
    let after_open = start + len;
    if after_open >= text.len() || matches!(text[after_open], ' ' | '\t') {
        return Ok(None);
    }
    let mut j = after_open;
    while j < text.len() {
        if text[j] == '\\' && j + 1 < text.len() {
            j += 2;
            continue;
        }
        if text.get(j..j + len) == Some(delimiter) {
            let before = text[j - 1];
            let single_in_run = len == 1
                && ((before == delimiter[0] && !(j >= 2 && text[j - 2] == '\\'))
                    || text.get(j + len) == Some(&delimiter[0]));
            if matches!(before, ' ' | '\t') || single_in_run || j == after_open {
                j += 1;
                continue;
            }
            let children = parse_inline(&text[after_open..j])?;
            nodes.push(wrap(children));
            return Ok(Some(j + len));
        }
        j += 1;
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::super::SeedMarks;
    use super::super::links::allowed_href;
    use super::*;

    fn plain(text: &str) -> SeedInline {
        SeedInline::Text {
            text: text.to_owned(),
            marks: SeedMarks::default(),
        }
    }

    #[test]
    fn a_soft_break_is_one_hard_break_and_loses_the_next_lines_indent() {
        let content = inline_content("a\n b  c", &[]).expect("supported");
        assert_eq!(
            content,
            vec![plain("a"), SeedInline::HardBreak, plain("b c")]
        );
    }

    #[test]
    fn a_code_span_drops_every_other_mark() {
        let content = inline_content("**`x`**", &[]).expect("supported");
        let code = SeedMarks {
            code: true,
            ..SeedMarks::default()
        };
        assert_eq!(
            content,
            vec![SeedInline::Text {
                text: "x".to_owned(),
                marks: code
            }]
        );
    }

    #[test]
    fn a_script_link_is_plain_text() {
        assert!(!allowed_href("javascript:alert(1)"));
        assert!(allowed_href("https://example.com"));
        assert!(allowed_href("u"));
        assert!(allowed_href("#frag"));
        assert!(allowed_href("mailto:a@b.c"));
        let content = inline_content("[a](javascript:x)", &[]).expect("supported");
        assert_eq!(content, vec![plain("a")]);
    }
}
