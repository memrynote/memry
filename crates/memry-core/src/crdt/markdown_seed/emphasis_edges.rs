//! Emphasis edge spaces: `trimEmphasisEdges` of
//! `packages/editor-schema/src/inline/emphasis-runs.ts`.
//!
//! Markdown has no spelling for `** x **`, so the writer puts the whitespace at
//! a bold, italic or strike run's edge outside its delimiters, and the next
//! seed of that note reads it outside the mark. Desktop does that at seed, on
//! every block's runs and every cell's, so `**see ![x](u)** now` holds bold
//! `see` and not `see `.
//!
//! Works on desktop's items, which [`Run`] already is: a text run, a link
//! holding styled text, or an inline node. [`regroup`] is [`expand`] undone.

use crate::domain::journal_rules::is_js_whitespace;

use super::runs::{Run, expand};
use super::{SeedBlock, SeedInline, SeedKind, SeedMarks};

#[derive(Clone, Copy)]
enum Mark {
    Bold,
    Italic,
    Strike,
}

// `MARKS`, in the order desktop trims them.
const MARKS: [Mark; 3] = [Mark::Bold, Mark::Italic, Mark::Strike];

impl Mark {
    fn on(self, marks: &SeedMarks) -> bool {
        match self {
            Self::Bold => marks.bold,
            Self::Italic => marks.italic,
            Self::Strike => marks.strike,
        }
    }

    fn off(self, marks: &SeedMarks) -> SeedMarks {
        let mut marks = marks.clone();
        match self {
            Self::Bold => marks.bold = false,
            Self::Italic => marks.italic = false,
            Self::Strike => marks.strike = false,
        }
        marks
    }
}

/// Every block's runs, and every table cell's, with the whitespace at each
/// bold, italic or strike run's edge outside it. A code block's text is
/// literal and left alone.
pub(super) fn trim_blocks(blocks: &mut [SeedBlock]) {
    for block in blocks {
        match &mut block.kind {
            SeedKind::CodeBlock { .. } | SeedKind::Diagram => {}
            SeedKind::Table { rows } => {
                for cell in rows.iter_mut().flat_map(|row| &mut row.cells) {
                    trim_content(&mut cell.content);
                }
            }
            _ => trim_content(&mut block.content),
        }
        trim_blocks(&mut block.children);
    }
}

fn trim_content(content: &mut Vec<SeedInline>) {
    let marked = content.iter().any(
        |piece| matches!(piece, SeedInline::Text { marks, .. } if marks.bold || marks.italic || marks.strike),
    );
    if !marked {
        return;
    }
    let mut runs = regroup(std::mem::take(content));
    for mark in MARKS {
        runs = trim_mark(runs, mark);
    }
    *content = expand(runs);
}

/// `inlineContentToNodes` undone: a hard break is a `\n` of the text it
/// follows, and a link's texts are one run, as `to_runs` joins them.
fn regroup(content: Vec<SeedInline>) -> Vec<Run> {
    let mut runs: Vec<Run> = Vec::new();
    for piece in content {
        let (text, marks) = match piece {
            SeedInline::Text { text, marks } => (text, marks),
            SeedInline::HardBreak { marks } => ("\n".to_owned(), marks),
            node => {
                runs.push(Run::Node(node));
                continue;
            }
        };
        let mut styles = marks;
        let href = styles.link.take();
        match (runs.last_mut(), href) {
            (Some(Run::Text(run, run_styles)), None) if *run_styles == styles => {
                run.push_str(&text);
            }
            (Some(Run::Link(run_href, children)), Some(href)) if *run_href == href => {
                match children.last_mut() {
                    Some((last, last_styles)) if *last_styles == styles => last.push_str(&text),
                    _ => children.push((text, styles)),
                }
            }
            (_, None) => runs.push(Run::Text(text, styles)),
            (_, Some(href)) => runs.push(Run::Link(href, vec![(text, styles)])),
        }
    }
    runs
}

/// `holds`: the whole item carries the mark, and holds text.
fn holds(run: &Run, mark: Mark) -> bool {
    match run {
        Run::Text(text, marks) => mark.on(marks) && !text.is_empty(),
        Run::Link(_, children) => {
            !children.is_empty()
                && children
                    .iter()
                    .all(|(text, marks)| mark.on(marks) && !text.is_empty())
        }
        Run::Node(_) => false,
    }
}

/// `plainText`: a text run that is not a code span, with no comment beside it.
/// A space against a comment stays: it is how the writer tells a comment inside
/// the run from one beside it.
fn plain_text<'a>(run: &'a Run, beside: Option<&Run>) -> Option<(&'a str, &'a SeedMarks)> {
    let Run::Text(text, marks) = run else {
        return None;
    };
    let comment = matches!(beside, Some(Run::Node(SeedInline::HtmlComment { .. })));
    (!marks.code && !comment).then_some((text.as_str(), marks))
}

/// `[^\S\n]`.
fn is_inline_space(c: char) -> bool {
    c != '\n' && is_js_whitespace(c)
}

/// `/[^\S\n]+\n*$/`: the length of the whitespace ending `text` and the breaks
/// after it, which the writer moves past the mark together.
fn tail_len(text: &str) -> usize {
    let body = text.trim_end_matches('\n');
    let spaces = body.len() - body.trim_end_matches(is_inline_space).len();
    if spaces == 0 {
        0
    } else {
        text.len() - (body.len() - spaces)
    }
}

fn trim_mark(runs: Vec<Run>, mark: Mark) -> Vec<Run> {
    let mut trimmed: Vec<Run> = Vec::with_capacity(runs.len());
    let mut at = 0;
    while at < runs.len() {
        let length = runs[at..].iter().take_while(|run| holds(run, mark)).count();
        if length == 0 {
            trimmed.push(runs[at].clone());
            at += 1;
            continue;
        }
        let mut run: Vec<Run> = runs[at..at + length].to_vec();
        let before = at.checked_sub(1).map(|index| &runs[index]);
        let lead = plain_text(&run[0], before).map_or(0, |(text, _)| {
            text.len() - text.trim_start_matches(is_inline_space).len()
        });
        let mut lead_run = None;
        if lead > 0
            && let Run::Text(text, marks) = &mut run[0]
        {
            lead_run = Some(Run::Text(text[..lead].to_owned(), mark.off(marks)));
            text.drain(..lead);
        }
        let after = runs.get(at + length);
        let tail = run
            .last()
            .and_then(|last| plain_text(last, after))
            .map_or(0, |(text, _)| tail_len(text));
        let mut tail_run = None;
        if tail > 0
            && let Some(Run::Text(text, marks)) = run.last_mut()
        {
            let kept = text.len() - tail;
            tail_run = Some(Run::Text(text[kept..].to_owned(), mark.off(marks)));
            text.truncate(kept);
        }
        trimmed.extend(lead_run);
        trimmed.extend(
            run.into_iter()
                .filter(|run| !matches!(run, Run::Text(text, _) if text.is_empty())),
        );
        trimmed.extend(tail_run);
        at += length;
    }
    join_texts(trimmed)
}

/// `joinTexts`: adjacent text runs of equal marks are one run.
fn join_texts(runs: Vec<Run>) -> Vec<Run> {
    let mut out: Vec<Run> = Vec::with_capacity(runs.len());
    for run in runs {
        match (out.last_mut(), run) {
            (Some(Run::Text(last, last_marks)), Run::Text(text, marks)) if *last_marks == marks => {
                last.push_str(&text);
            }
            (_, run) => out.push(run),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(value: &str, bold: bool, code: bool) -> SeedInline {
        SeedInline::Text {
            text: value.to_owned(),
            marks: SeedMarks {
                bold,
                code,
                ..SeedMarks::default()
            },
        }
    }

    fn trimmed(mut content: Vec<SeedInline>) -> Vec<SeedInline> {
        trim_content(&mut content);
        content
    }

    #[test]
    fn a_runs_edge_spaces_leave_the_mark() {
        assert_eq!(
            trimmed(vec![
                text("a", false, true),
                text(" x ", true, false),
                text("c", false, true)
            ]),
            vec![
                text("a", false, true),
                text(" ", false, false),
                text("x", true, false),
                text(" ", false, false),
                text("c", false, true)
            ]
        );
        assert_eq!(
            trimmed(vec![text("see ", true, false), text(" now", false, false)]),
            vec![text("see", true, false), text("  now", false, false)]
        );
    }

    #[test]
    fn the_breaks_after_a_trailing_space_leave_the_mark_with_it() {
        assert_eq!(tail_len("a \n\n"), 3);
        assert_eq!(tail_len("a\n"), 0);
        assert_eq!(tail_len("a \nb"), 0);
        assert_eq!(tail_len("a \n \n"), 2);
        let italic = SeedMarks {
            italic: true,
            ..SeedMarks::default()
        };
        let plain = SeedMarks::default();
        let broken = |marks: &SeedMarks| SeedInline::HardBreak {
            marks: marks.clone(),
        };
        let run = |text: &str, marks: &SeedMarks| SeedInline::Text {
            text: text.to_owned(),
            marks: marks.clone(),
        };
        assert_eq!(
            trimmed(vec![run("a ", &italic), broken(&italic), run("b", &plain)]),
            vec![
                run("a", &italic),
                run(" ", &plain),
                broken(&plain),
                run("b", &plain)
            ]
        );
    }

    #[test]
    fn a_space_against_a_comment_stays_and_a_break_is_no_space() {
        let comment = SeedInline::HtmlComment {
            source: "%%c%%".to_owned(),
        };
        let kept = vec![text("a ", true, false), comment, text(" b", true, false)];
        assert_eq!(trimmed(kept.clone()), kept);
        let broken = vec![
            text("a", true, false),
            SeedInline::HardBreak {
                marks: SeedMarks {
                    bold: true,
                    ..SeedMarks::default()
                },
            },
        ];
        assert_eq!(trimmed(broken.clone()), broken);
    }
}
