//! A paragraph with no visible text, parsed as ProseMirror's default does.
//!
//! BlockNote's paragraph rule (`Paragraph/block.ts` `parse`) declines a `<p>`
//! whose `textContent.trim()` is empty, so the generic rule reads it with
//! whitespace collapsed, not preserved: a run of blanks is one space, a space
//! that starts the block, follows a break or follows a space is dropped, and
//! the block's last text loses its trailing space. `` `\n`\n`\n` `` (two code
//! spans of one space, a break between) is a paragraph of the break alone. Any
//! paragraph with a visible character keeps every blank, which is why the
//! same breaks around an `x` stay.
//!
//! The rule is ProseMirror's `addTextNode` and `NodeContext.finish` with
//! `preserveWhitespace` off.

use crate::domain::journal_rules::js_trim;

use super::inline::Html;

/// What ProseMirror has built so far, as far as the strip reads it.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Last {
    Nothing,
    /// A hard break or an inline node.
    Node,
    Text {
        ends_blank: bool,
    },
}

/// `nodes` collapsed when they hold no visible text, left alone otherwise.
pub(super) fn collapse_blank_paragraph(nodes: &mut [Html]) {
    let mut text = String::new();
    text_content(nodes, &mut text);
    if !js_trim(&text).is_empty() {
        return;
    }
    collapse(nodes, &mut Last::Nothing);
    trim_last(nodes);
}

/// Whether a paragraph's nodes are whitespace and nothing else, no break and
/// no media: its `<p>` is declined and the whitespace goes into the block
/// group, where ProseMirror keeps an empty paragraph or none by what is beside
/// it (a paragraph above or below drops it, a math block keeps it). Not built.
/// A paragraph of a break alone keeps the break, and one of nothing never
/// reaches here.
pub(super) fn is_blank_paragraph(nodes: &[Html]) -> bool {
    fn holds_node(nodes: &[Html]) -> bool {
        nodes.iter().any(|node| match node {
            Html::Br | Html::Media(_) => true,
            Html::Wrap(_, children) | Html::Link { children, .. } => holds_node(children),
            Html::Text(_) | Html::Code(_) => false,
        })
    }
    let mut text = String::new();
    text_content(nodes, &mut text);
    !text.is_empty() && js_trim(&text).is_empty() && !holds_node(nodes)
}

fn text_content(nodes: &[Html], out: &mut String) {
    for node in nodes {
        match node {
            Html::Text(text) | Html::Code(text) => out.push_str(text),
            Html::Wrap(_, children) | Html::Link { children, .. } => text_content(children, out),
            Html::Br | Html::Media(_) => {}
        }
    }
}

fn collapse(nodes: &mut [Html], last: &mut Last) {
    for index in 0..nodes.len() {
        let after_break = index > 0 && matches!(nodes[index - 1], Html::Br);
        match &mut nodes[index] {
            Html::Text(text) => *text = collapse_text(text, after_break, last),
            // The text of a code span has no sibling before it.
            Html::Code(text) => *text = collapse_text(text, false, last),
            Html::Wrap(_, children) | Html::Link { children, .. } => collapse(children, last),
            Html::Br | Html::Media(_) => *last = Last::Node,
        }
    }
}

/// `addTextNode` without `preserveWhitespace`.
fn collapse_text(text: &str, after_break: bool, last: &mut Last) -> String {
    let mut value = String::with_capacity(text.len());
    let mut in_run = false;
    for c in text.chars() {
        if matches!(c, ' ' | '\t' | '\r' | '\n' | '\u{000C}') {
            if !in_run {
                value.push(' ');
            }
            in_run = true;
        } else {
            value.push(c);
            in_run = false;
        }
    }
    let strip = matches!(
        (*last, after_break),
        (Last::Nothing | Last::Text { ends_blank: true }, _) | (_, true)
    );
    if strip && value.starts_with(' ') {
        value.remove(0);
    }
    if !value.is_empty() {
        *last = Last::Text {
            ends_blank: value.ends_with(' '),
        };
    }
    value
}

/// `NodeContext.finish`: the block's last node loses its trailing blanks, when
/// it is text.
fn trim_last(nodes: &mut [Html]) -> bool {
    for node in nodes.iter_mut().rev() {
        match node {
            Html::Text(text) | Html::Code(text) if !text.is_empty() => {
                text.truncate(text.trim_end_matches(' ').len());
                return true;
            }
            Html::Text(_) | Html::Code(_) => {}
            Html::Br | Html::Media(_) => return true,
            Html::Wrap(_, children) | Html::Link { children, .. } => {
                if trim_last(children) {
                    return true;
                }
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::super::Unsupported;
    use super::*;

    fn collapsed(markdown: &str) -> Result<Vec<Html>, Unsupported> {
        let mut html = super::super::inline::parse(markdown)?;
        collapse_blank_paragraph(&mut html);
        Ok(html)
    }

    #[test]
    fn a_blank_paragraph_keeps_its_breaks_and_loses_its_blanks() {
        let html = collapsed("`\n`\n`\n`").expect("parsed");
        let blanks = html
            .iter()
            .filter(|node| matches!(node, Html::Text(t) | Html::Code(t) if !t.is_empty()))
            .count();
        assert_eq!(blanks, 0);
        assert!(html.iter().any(|node| matches!(node, Html::Br)));
    }

    #[test]
    fn a_paragraph_with_a_visible_character_is_left_alone() {
        let before = super::super::inline::parse("`\n`\nx\n`\n`").expect("parsed");
        assert_eq!(collapsed("`\n`\nx\n`\n`").expect("parsed"), before);
    }

    #[test]
    fn a_paragraph_of_only_whitespace_is_told_from_one_that_holds_a_break() {
        let blank = |markdown: &str| {
            is_blank_paragraph(&super::super::inline::parse(markdown).expect("parsed"))
        };
        assert!(blank("`  `"));
        assert!(blank("` ` `  `"));
        assert!(blank("`\n`"));
        assert!(!blank("`\n`\n`\n`"));
        assert!(!blank("` x`"));
        assert!(!blank("![](u)"));
    }
}
