//! Stages 2 to 4 of the inline pipeline ([`super::inline`]): the parsed HTML
//! tree's whitespace, ProseMirror's marks and runs, and desktop's repair.

use crate::domain::journal_rules::{is_js_whitespace, js_trim};

use super::code_spans::{SPACE_TOKEN, TAB_TOKEN, restore_code_whitespace};
use super::collapse::collapse_blank_paragraph;
use super::hard_breaks::unmask_hard_breaks;
use super::inline::{Html, Tag};
use super::links::allowed_href;
use super::media::{Media, alt_width};
use super::{SeedInline, SeedMarks};

/// One stage-3 run: styled text, a link holding styled text, or an inline
/// node.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Run {
    Text(String, SeedMarks),
    Link(String, Vec<(String, SeedMarks)>),
    Node(SeedInline),
}

/// A paragraph-like block's runs: stage 2, then ProseMirror's parse with its
/// whitespace preserved, unless the paragraph shows no text
/// ([`collapse_blank_paragraph`]).
pub(super) fn block_content(
    mut html: Vec<Html>,
    breaks: &[String],
    paragraph: bool,
) -> Vec<SeedInline> {
    normalize_whitespace(&mut html);
    if paragraph {
        collapse_blank_paragraph(&mut html);
    }
    let mut nodes = Vec::new();
    flatten(&html, &SeedMarks::default(), false, &mut nodes);
    finish(nodes, breaks)
}

/// A table cell's runs. `parseTableContent` parses the cell without
/// `preserveWhitespace`, so ProseMirror's `addTextNode` collapses every
/// whitespace run to one space, drops a leading space at the start, after a
/// break or after whitespace, and `finish` drops the trailing whitespace.
/// `code_kept`: `maskCellCodeSpans` hid the code spans' whitespace from it
/// and from the repair, behind tokens restored last.
pub(super) fn cell_content(html: Vec<Html>, breaks: &[String], code_kept: bool) -> Vec<SeedInline> {
    let mut flat = Vec::new();
    flatten(&html, &SeedMarks::default(), false, &mut flat);
    let kept = |marks: &SeedMarks| code_kept && marks.code;
    let pm_space = |c: char| matches!(c, ' ' | '\t' | '\r' | '\n' | '\u{000C}');
    let mut nodes: Vec<PmNode> = Vec::new();
    for node in flat {
        let PmNode::Text(text, marks) = node else {
            nodes.push(node);
            continue;
        };
        if kept(&marks) {
            let masked = text.replace(' ', SPACE_TOKEN).replace('\t', TAB_TOKEN);
            nodes.push(PmNode::Text(masked, marks));
            continue;
        }
        let mut value = String::with_capacity(text.len());
        for c in text.chars() {
            if !(pm_space(c) && value.ends_with(' ')) {
                value.push(if pm_space(c) { ' ' } else { c });
            }
        }
        let strip = value.starts_with(' ')
            && match nodes.last() {
                None | Some(PmNode::Break) => true,
                Some(PmNode::Text(before, before_marks)) => {
                    !kept(before_marks) && before.ends_with(pm_space)
                }
                Some(PmNode::Node(_)) => false,
            };
        if strip {
            value.remove(0);
        }
        if !value.is_empty() {
            nodes.push(PmNode::Text(value, marks));
        }
    }
    if let Some(PmNode::Text(last, marks)) = nodes.last_mut()
        && !kept(marks)
    {
        let kept_len = last.trim_end_matches(pm_space).len();
        last.truncate(kept_len);
        if last.is_empty() {
            nodes.pop();
        }
    }
    finish(nodes, breaks)
}

/// Stage 4 and the end of `maskCellCodeSpans`: the placeholders come back
/// after the repair, which never sees the whitespace they hide.
fn finish(nodes: Vec<PmNode>, breaks: &[String]) -> Vec<SeedInline> {
    let mut runs = to_runs(nodes);
    repair(&mut runs, breaks);
    let mut content = expand(runs);
    for piece in &mut content {
        if let SeedInline::Text { text, .. } = piece
            && text.contains("MEMRYCSP")
        {
            *text = restore_code_whitespace(text);
        }
    }
    content
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

/// A ProseMirror inline node: marked text, a hard break (which carries no
/// mark: BlockNote rebuilds it with `createChecked()`), or an inline node.
enum PmNode {
    Text(String, SeedMarks),
    Break,
    Node(SeedInline),
}

/// The CommonMark code span for `code`: a fence no backtick run in it
/// matches, padded when needed (`link-code-spans.ts` `codeSpan`).
fn code_span(code: &str) -> String {
    let mut fence = "`".to_owned();
    while code.split(|c| c != '`').any(|run| run.len() == fence.len()) {
        fence.push('`');
    }
    let pad = code.chars().any(|c| c != ' ')
        && ((code.starts_with(' ') && code.ends_with(' '))
            || code.starts_with('`')
            || code.ends_with('`'));
    if pad {
        format!("{fence} {code} {fence}")
    } else {
        format!("{fence}{code}{fence}")
    }
}

/// Stage 3a: ProseMirror's marks. A code mark excludes every other mark, the
/// way tiptap's `Code` declares `excludes: "_"`, so a code span inside a link
/// is the link's own text with its backticks (desktop's `linkCodeAsText`).
fn flatten(nodes: &[Html], marks: &SeedMarks, in_link: bool, out: &mut Vec<PmNode>) {
    for node in nodes {
        match node {
            Html::Text(text) if !text.is_empty() => {
                out.push(PmNode::Text(text.clone(), marks.clone()))
            }
            Html::Text(_) => {}
            Html::Br => out.push(PmNode::Break),
            Html::Code(code) if in_link => out.push(PmNode::Text(code_span(code), marks.clone())),
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
                flatten(children, &inner, in_link, out);
            }
            Html::Link { href, children } => {
                let mut inner = marks.clone();
                if !href.is_empty() && allowed_href(href) && !inner.code {
                    inner.link = Some(href.clone());
                }
                flatten(children, &inner, true, out);
            }
            // An `<img>` that reaches a text block's content sits in a table
            // cell: `inlineImage`'s parse (`inline/inline-image.ts`). The
            // callers keep every other image out of here.
            Html::Media(Media::Image { url, alt }) => {
                let (alt, width) = alt_width(alt);
                out.push(PmNode::Node(SeedInline::InlineImage {
                    src: js_trim(url).to_owned(),
                    alt: alt.to_owned(),
                    width: width.unwrap_or(0),
                }));
            }
            Html::Media(Media::Video { .. }) => {}
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
                    // A node is never the open run: it is pushed whole.
                    None | Some(Run::Node(_)) => {
                        current = Some(Run::Text("\n".to_owned(), SeedMarks::default()));
                    }
                }
                continue;
            }
            PmNode::Text(text, marks) => (text, marks),
            PmNode::Node(node) => {
                runs.extend(current.take());
                runs.push(Run::Node(node));
                continue;
            }
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

impl Run {
    /// `endsLine`: the run, or a link's last text, ends in a soft break.
    fn ends_line(&self) -> bool {
        match self {
            Run::Text(text, _) => text.ends_with('\n'),
            Run::Link(_, content) => content.last().is_some_and(|(text, _)| text.ends_with('\n')),
            Run::Node(_) => false,
        }
    }
}

/// Stage 4: `repairRuns` for prose. A text run opens a line when it is the
/// block's first, or when the run before it ends in a soft break and it is
/// not a code span; a run the strip empties is removed.
fn repair(runs: &mut Vec<Run>, breaks: &[String]) {
    let mut first = true;
    let mut previous_ends_line = false;
    runs.retain_mut(|run| {
        let keep = match run {
            Run::Text(text, marks) => {
                let opens_line = !marks.code && (first || previous_ends_line);
                !repair_text(text, opens_line, breaks)
            }
            Run::Link(_, content) => {
                repair_link_text(content, breaks);
                true
            }
            Run::Node(_) => true,
        };
        first = false;
        previous_ends_line = run.ends_line();
        keep
    });
}

/// `repairRuns` over a link's text, which never opens its block's first
/// line: a leading space there is the author's (BBF-103, BBF-104).
fn repair_link_text(content: &mut Vec<(String, SeedMarks)>, breaks: &[String]) {
    let mut previous_ends_line = false;
    content.retain_mut(|(text, marks)| {
        let emptied = repair_text(text, !marks.code && previous_ends_line, breaks);
        previous_ends_line = text.ends_with('\n');
        !emptied
    });
}

/// `BREAK_ARTIFACT` and, on a run that opens a line,
/// `LEADING_BREAK_ARTIFACT` stripped, then the hard-break tokens unmasked.
/// Returns whether the strip emptied the run.
fn repair_text(text: &mut String, opens_line: bool, breaks: &[String]) -> bool {
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
    if opens_line
        && let Some(first) = stripped.chars().next()
        && first != '\n'
        && is_js_whitespace(first)
    {
        stripped.remove(0);
    }
    let emptied = stripped.is_empty() && !text.is_empty();
    *text = if breaks.is_empty() {
        stripped
    } else {
        unmask_hard_breaks(&stripped)
    };
    emptied
}

/// `inlineContentToNodes`: text split on `\n` into hard breaks, empty pieces
/// dropped, a link's mark added to its text.
pub(super) fn expand(runs: Vec<Run>) -> Vec<SeedInline> {
    let mut out = Vec::new();
    let split = |out: &mut Vec<SeedInline>, text: &str, marks: &SeedMarks| {
        for (index, piece) in text.split('\n').enumerate() {
            if index > 0 {
                out.push(SeedInline::HardBreak {
                    marks: marks.clone(),
                });
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
            Run::Text(text, marks) => split(&mut out, &text, &marks),
            Run::Link(href, content) => {
                for (text, marks) in content {
                    let marks = SeedMarks {
                        link: Some(href.clone()),
                        ..marks
                    };
                    split(&mut out, &text, &marks);
                }
            }
            Run::Node(node) => out.push(node),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_code_span_at_a_blocks_start_keeps_its_leading_space() {
        let content = block_content(
            vec![Html::Code(" *a".to_owned()), Html::Text(" b".to_owned())],
            &[],
            true,
        );
        let code = SeedMarks {
            code: true,
            ..SeedMarks::default()
        };
        assert_eq!(
            content,
            vec![
                SeedInline::Text {
                    text: " *a".to_owned(),
                    marks: code
                },
                SeedInline::Text {
                    text: " b".to_owned(),
                    marks: SeedMarks::default()
                }
            ]
        );
    }
}
