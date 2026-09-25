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

use crate::domain::journal_rules::is_js_whitespace;

use super::links::{allowed_href, link};
use super::prepare::unmask_hard_breaks;
use super::{SeedInline, SeedMarks, Unsupported};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Tag {
    Strong,
    Em,
    Del,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Html {
    Text(String),
    Br,
    Wrap(Tag, Vec<Html>),
    Code(String),
    Link { href: String, children: Vec<Html> },
}

/// One stage-3 run: styled text, or a link holding styled text.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Run {
    Text(String, SeedMarks),
    Link(String, Vec<(String, SeedMarks)>),
}

/// The inline content of one text block. `breaks` are the hard-break
/// spellings `mask_hard_breaks` took, which decides whether tokens unmask.
pub(super) fn inline_content(
    text: &str,
    breaks: &[String],
) -> Result<Vec<SeedInline>, Unsupported> {
    let chars: Vec<char> = text.chars().collect();
    let mut html = parse_inline(&chars)?;
    normalize_whitespace(&mut html);
    let mut nodes = Vec::new();
    flatten(&html, &SeedMarks::default(), &mut nodes);
    let mut runs = to_runs(nodes);
    repair(&mut runs, breaks);
    Ok(expand(runs))
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
    if text[i] == '!' && at(1) == Some('[') {
        // Line-level fallback catches `![` first; this is the backstop.
        return Err(Unsupported("image or embed"));
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

/// Stage 2: a text node holding a newline has each whitespace run collapsed.
fn normalize_whitespace(nodes: &mut [Html]) {
    for node in nodes {
        match node {
            Html::Text(text) if text.contains('\n') => {
                let mut out = String::with_capacity(text.len());
                let mut in_run = false;
                for c in text.chars() {
                    if matches!(c, ' ' | '\t' | '\r' | '\n' | '\u{000C}') {
                        if !in_run {
                            out.push(' ');
                        }
                        in_run = true;
                    } else {
                        out.push(c);
                        in_run = false;
                    }
                }
                *text = out;
            }
            Html::Wrap(_, children) | Html::Link { children, .. } => normalize_whitespace(children),
            _ => {}
        }
    }
}

/// A ProseMirror inline node: marked text, or a hard break (which carries no
/// mark: BlockNote rebuilds it with `createChecked()`).
enum PmNode {
    Text(String, SeedMarks),
    Break,
}

/// Stage 3a: ProseMirror's marks. A code mark excludes every other mark, the
/// way tiptap's `Code` declares `excludes: "_"`.
fn flatten(nodes: &[Html], marks: &SeedMarks, out: &mut Vec<PmNode>) {
    for node in nodes {
        match node {
            Html::Text(text) if !text.is_empty() => {
                out.push(PmNode::Text(text.clone(), marks.clone()))
            }
            Html::Text(_) => {}
            Html::Br => out.push(PmNode::Break),
            Html::Code(code) => {
                if !code.is_empty() {
                    let code_only = SeedMarks {
                        code: true,
                        ..SeedMarks::default()
                    };
                    out.push(PmNode::Text(code.clone(), code_only));
                }
            }
            Html::Wrap(tag, children) => {
                let mut inner = marks.clone();
                if !inner.code {
                    match tag {
                        Tag::Strong => inner.bold = true,
                        Tag::Em => inner.italic = true,
                        Tag::Del => inner.strike = true,
                    }
                }
                flatten(children, &inner, out);
            }
            Html::Link { href, children } => {
                let mut inner = marks.clone();
                if !href.is_empty() && allowed_href(href) && !inner.code {
                    inner.link = Some(href.clone());
                }
                flatten(children, &inner, out);
            }
        }
    }
}

/// Stage 3b: `contentNodeToInlineContent`.
fn to_runs(nodes: Vec<PmNode>) -> Vec<Run> {
    let mut runs = Vec::new();
    let mut current: Option<Run> = None;
    for node in nodes {
        let (text, marks) = match node {
            PmNode::Break => {
                match &mut current {
                    Some(Run::Text(text, _)) => text.push('\n'),
                    Some(Run::Link(_, content)) => {
                        if let Some((text, _)) = content.last_mut() {
                            text.push('\n');
                        }
                    }
                    None => current = Some(Run::Text("\n".to_owned(), SeedMarks::default())),
                }
                continue;
            }
            PmNode::Text(text, marks) => (text, marks),
        };
        let mut styles = marks.clone();
        let href = styles.link.take();
        current = Some(match (current.take(), href) {
            (Some(Run::Text(mut run, run_styles)), None) if run_styles == styles => {
                run.push_str(&text);
                Run::Text(run, run_styles)
            }
            (Some(Run::Link(run_href, mut content)), Some(href)) if run_href == href => {
                match content.last_mut() {
                    Some((last, last_styles)) if *last_styles == styles => last.push_str(&text),
                    _ => content.push((text, styles)),
                }
                Run::Link(run_href, content)
            }
            (previous, href) => {
                runs.extend(previous);
                match href {
                    Some(href) => Run::Link(href, vec![(text, styles)]),
                    None => Run::Text(text, styles),
                }
            }
        });
    }
    runs.extend(current);
    runs
}

/// Stage 4: `repairRuns` for prose.
fn repair(runs: &mut [Run], breaks: &[String]) {
    for (index, run) in runs.iter_mut().enumerate() {
        let Run::Text(text, _) = run else {
            continue;
        };
        let mut stripped = String::with_capacity(text.len());
        let mut chars = text.chars().peekable();
        while let Some(c) = chars.next() {
            stripped.push(c);
            if c == '\n'
                && chars
                    .peek()
                    .is_some_and(|next| *next != '\n' && is_js_whitespace(*next))
            {
                chars.next();
            }
        }
        if index == 0
            && let Some(first) = stripped.chars().next()
            && first != '\n'
            && is_js_whitespace(first)
        {
            stripped.remove(0);
        }
        *text = if breaks.is_empty() {
            stripped
        } else {
            unmask_hard_breaks(&stripped)
        };
    }
}

/// `inlineContentToNodes`: text split on `\n` into hard breaks, empty pieces
/// dropped, a link's mark added to its text.
fn expand(runs: Vec<Run>) -> Vec<SeedInline> {
    let mut out = Vec::new();
    let mut split = |text: &str, marks: &SeedMarks| {
        for (index, piece) in text.split('\n').enumerate() {
            if index > 0 {
                out.push(SeedInline::HardBreak);
            }
            if !piece.is_empty() {
                out.push(SeedInline::Text {
                    text: piece.to_owned(),
                    marks: marks.clone(),
                });
            }
        }
    };
    for run in runs {
        match run {
            Run::Text(text, marks) => split(&text, &marks),
            Run::Link(href, content) => {
                for (text, marks) in content {
                    let marks = SeedMarks {
                        link: Some(href.clone()),
                        ..marks
                    };
                    split(&text, &marks);
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
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
