//! A masked comment's token back to what desktop's repair makes of it
//! (`editor-schema/src/parse-markdown.ts` `withHtmlCommentNodes`).
//!
//! Text holds an `htmlComment` node, so each token in a run of text becomes
//! one, keeping the run's marks on the text around it. Literal text cannot
//! hold a node, and neither can a link's label, so a token in a code span, a
//! link label or a code block becomes the comment's own bytes again.

use crate::domain::journal_rules::js_trim;

use super::comments::TOKEN_PREFIX;
use super::{SeedBlock, SeedInline, SeedKind};

pub(super) fn has_token(text: &str) -> bool {
    text.contains(TOKEN_PREFIX)
}

/// One piece of text cut at its tokens.
enum Part<'a> {
    Text(&'a str),
    Comment(String),
}

/// `TOKEN_REGEX`, ``MEMRYCMT([0-9a-f]*)X``, over `text`.
fn split(text: &str) -> Vec<Part<'_>> {
    let mut parts = Vec::new();
    let mut last = 0;
    let mut from = 0;
    while let Some(found) = text[from..].find(TOKEN_PREFIX) {
        let start = from + found;
        let digits = start + TOKEN_PREFIX.len();
        let hex_len = text[digits..]
            .bytes()
            .take_while(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
            .count();
        let end = digits + hex_len;
        let decoded = text[end..]
            .starts_with('X')
            .then(|| hex::decode(&text[digits..end]).ok())
            .flatten()
            .and_then(|bytes| String::from_utf8(bytes).ok());
        let Some(source) = decoded else {
            from = digits;
            continue;
        };
        if start > last {
            parts.push(Part::Text(&text[last..start]));
        }
        parts.push(Part::Comment(source));
        last = end + 1;
        from = last;
    }
    if last < text.len() {
        parts.push(Part::Text(&text[last..]));
    }
    parts
}

/// `decodeHtmlCommentTokens`.
pub(super) fn decode(text: &str) -> String {
    if !has_token(text) {
        return text.to_owned();
    }
    split(text)
        .into_iter()
        .map(|part| match part {
            Part::Text(text) => text.to_owned(),
            Part::Comment(source) => source,
        })
        .collect()
}

/// The source lines of a masked line: a comment that crossed lines is
/// several again, each trimmed, the blank ones dropped.
pub(super) fn source_lines(line: &str) -> Vec<String> {
    decode(line)
        .split('\n')
        .map(|part| js_trim(part).to_owned())
        .filter(|part| !part.is_empty())
        .collect()
}

/// Every token in `blocks` made a node or decoded.
pub(super) fn into_nodes(blocks: &mut [SeedBlock]) {
    for block in blocks {
        let literal = matches!(block.kind, SeedKind::CodeBlock { .. } | SeedKind::Diagram);
        if let SeedKind::Table { rows } = &mut block.kind {
            for cell in rows.iter_mut().flat_map(|row| row.cells.iter_mut()) {
                cell.content = nodes_in(std::mem::take(&mut cell.content), false);
            }
        }
        block.content = nodes_in(std::mem::take(&mut block.content), literal);
        into_nodes(&mut block.children);
    }
}

fn nodes_in(content: Vec<SeedInline>, literal: bool) -> Vec<SeedInline> {
    let mut out = Vec::with_capacity(content.len());
    for piece in content {
        let SeedInline::Text { text, marks } = piece else {
            out.push(piece);
            continue;
        };
        if !has_token(&text) {
            out.push(SeedInline::Text { text, marks });
        } else if literal || marks.code || marks.link.is_some() {
            out.push(SeedInline::Text {
                text: decode(&text),
                marks,
            });
        } else {
            for part in split(&text) {
                out.push(match part {
                    Part::Text(text) => SeedInline::Text {
                        text: text.to_owned(),
                        marks: marks.clone(),
                    },
                    Part::Comment(source) => SeedInline::HtmlComment { source },
                });
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::super::SeedMarks;
    use super::super::comments::encode;
    use super::*;

    fn text(value: &str, marks: SeedMarks) -> SeedInline {
        SeedInline::Text {
            text: value.to_owned(),
            marks,
        }
    }

    #[test]
    fn a_token_is_a_node_between_runs_that_keep_their_marks() {
        let bold = SeedMarks {
            bold: true,
            ..SeedMarks::default()
        };
        let run = format!("a {} b", encode("%% c %%"));
        assert_eq!(
            nodes_in(vec![text(&run, bold.clone())], false),
            vec![
                text("a ", bold.clone()),
                SeedInline::HtmlComment {
                    source: "%% c %%".to_owned()
                },
                text(" b", bold)
            ]
        );
    }

    #[test]
    fn a_token_in_code_or_a_link_label_is_its_bytes() {
        let code = SeedMarks {
            code: true,
            ..SeedMarks::default()
        };
        let run = format!("x{}", encode("%%y%%"));
        assert_eq!(
            nodes_in(vec![text(&run, code.clone())], false),
            vec![text("x%%y%%", code)]
        );
        assert_eq!(source_lines(&encode("%%a\nb%%")), vec!["%%a", "b%%"]);
    }
}
