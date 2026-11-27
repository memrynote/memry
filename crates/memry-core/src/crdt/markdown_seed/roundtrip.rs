//! Desktop's `serializeBlocks` (`blocknote-converter.ts`) for the blocks a
//! callout or quote body proves its claim with: BlockNote 0.54's
//! `htmlToMarkdown` over the blocks' HTML, then `normalizeSerializedMarkdown`
//! (`shared/empty-lines.ts`). Only paragraphs and headings of plain, bold,
//! italic, struck, code and link runs are serialized; anything else is
//! [`Unsupported`], so a claim is never decided on a guess.

use crate::domain::journal_rules::{is_js_whitespace, js_trim};

use super::{SeedBlock, SeedInline, SeedKind, SeedMarks, Unsupported};

const UNSERIALIZED: Unsupported = Unsupported("callout or quote body");

/// The markdown `blocks` serialize to, before the caller's `trim()`.
pub(super) fn serialize(blocks: &[SeedBlock]) -> Result<String, Unsupported> {
    let mut out = String::new();
    for block in blocks {
        if !block.children.is_empty() {
            return Err(UNSERIALIZED);
        }
        match block.kind {
            // `serializeParagraph`: hard breaks at either end dropped.
            SeedKind::Paragraph => {
                let content = inline(&block.content)?;
                let mut trimmed = content.as_str();
                while let Some(rest) = trimmed.strip_prefix("\\\n") {
                    trimmed = rest;
                }
                while let Some(rest) = trimmed.strip_suffix("\\\n") {
                    trimmed = rest;
                }
                out.push_str(trimmed);
            }
            SeedKind::Heading { level } => {
                out.push_str(&"#".repeat(usize::from(level)));
                out.push(' ');
                out.push_str(&inline(&block.content)?);
            }
            _ => return Err(UNSERIALIZED),
        }
        out.push_str("\n\n");
    }
    let markdown = format!("{}\n", js_trim(&out));
    // `normalizeSerializedMarkdown` also reads fences, table rows and list
    // items, which a paragraph's line can look like.
    if markdown.split('\n').any(rewritten_line) {
        return Err(UNSERIALIZED);
    }
    Ok(backslash_breaks(&markdown))
}

/// A fence, a table row (`TABLE_ROW_START`) or a list item
/// (`LIST_ITEM_LINE`, `/^[ \t]*(?:[-*+]|\d+[.)])\s/`).
fn rewritten_line(line: &str) -> bool {
    let rest = line.trim_start_matches([' ', '\t']);
    let marker = match rest.strip_prefix(['-', '*', '+']) {
        Some(after) => Some(after),
        None => {
            let digits = rest.chars().take_while(char::is_ascii_digit).count();
            rest[digits..]
                .strip_prefix(['.', ')'])
                .filter(|_| digits > 0)
        }
    };
    super::prepare::fence_line(line).is_some()
        || js_trim(line).starts_with('|')
        || marker.is_some_and(|after| after.starts_with(is_js_whitespace))
}

/// `serializeInlineContent` over the HTML BlockNote writes for `content`.
/// A run with more than one mark, or a link with a style, is refused: their
/// nesting follows the schema's mark order.
fn inline(content: &[SeedInline]) -> Result<String, Unsupported> {
    let mut out = String::new();
    for piece in content {
        match piece {
            SeedInline::HardBreak => out.push_str("\\\n"),
            SeedInline::InlineImage { .. } | SeedInline::HtmlComment { .. } => {
                return Err(UNSERIALIZED);
            }
            SeedInline::Text { text, marks } => {
                // A backslash would make `normalizeSerializedMarkdown`'s
                // break rewrite ambiguous.
                if text.contains('\\') {
                    return Err(UNSERIALIZED);
                }
                out.push_str(&run(text, marks)?);
            }
        }
    }
    Ok(out)
}

fn run(text: &str, marks: &SeedMarks) -> Result<String, Unsupported> {
    let styles = [marks.bold, marks.italic, marks.strike, marks.code];
    let count = styles.iter().filter(|on| **on).count();
    if count > 1 || (count == 1 && marks.link.is_some()) {
        return Err(UNSERIALIZED);
    }
    if let Some(href) = &marks.link {
        // `formatLink`.
        if text == href {
            return Ok(href.clone());
        }
        let escaped: String = href
            .chars()
            .flat_map(|c| {
                let escape = matches!(c, '\\' | '(' | ')');
                escape.then_some('\\').into_iter().chain([c])
            })
            .collect();
        return Ok(format!("[{text}]({escaped})"));
    }
    let emphasis = |delimiter: &str| {
        // `extractTrailingWhitespace`: `/^(.*?)(\s*)$/`, whose `.` stops at
        // a newline.
        let body = text.trim_end_matches(is_js_whitespace);
        let (body, trailing) = if body.contains('\n') {
            (text, "")
        } else {
            (body, &text[body.len()..])
        };
        if body.is_empty() {
            trailing.to_owned()
        } else {
            format!("{delimiter}{body}{delimiter}{trailing}")
        }
    };
    Ok(if marks.bold {
        emphasis("**")
    } else if marks.italic {
        emphasis("*")
    } else if marks.strike {
        format!("~~{text}~~")
    } else if marks.code {
        let longest = text.split(|c| c != '`').map(str::len).max().unwrap_or(0);
        let fence = "`".repeat(longest + 1);
        if text.starts_with('`') || text.ends_with('`') {
            format!("{fence} {text} {fence}")
        } else {
            format!("{fence}{text}{fence}")
        }
    } else {
        text.to_owned()
    })
}

/// `BACKSLASH_BREAK_RUN`, `/(?:\\\n([^\S\n]*(?:>[^\S\n]?)*))+/g`: one break
/// is a newline, two a hard break (`"  \n"`), more one newline each, every
/// one followed by the last line's prefix.
fn backslash_breaks(markdown: &str) -> String {
    let blank = |c: char| c != '\n' && is_js_whitespace(c);
    let mut out = String::with_capacity(markdown.len());
    let mut rest = markdown;
    while let Some(at) = rest.find("\\\n") {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let mut count = 0;
        let mut prefix = "";
        while let Some(after) = rest.strip_prefix("\\\n") {
            count += 1;
            let mut end = after.len() - after.trim_start_matches(blank).len();
            while let Some(level) = after[end..].strip_prefix('>') {
                end = after.len() - level.len();
                if let Some(c) = level.chars().next().filter(|c| blank(*c)) {
                    end += c.len_utf8();
                }
            }
            prefix = &after[..end];
            rest = &after[end..];
        }
        if count == 2 {
            out.push_str("  \n");
            out.push_str(prefix);
        } else {
            for _ in 0..count {
                out.push('\n');
                out.push_str(prefix);
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paragraph(content: Vec<SeedInline>) -> SeedBlock {
        SeedBlock::new(SeedKind::Paragraph, content)
    }

    fn text(value: &str, marks: SeedMarks) -> SeedInline {
        SeedInline::Text {
            text: value.to_owned(),
            marks,
        }
    }

    #[test]
    fn breaks_serialize_as_the_source_spelled_them() {
        let plain = SeedMarks::default();
        let soft = paragraph(vec![
            text("a", plain.clone()),
            SeedInline::HardBreak,
            text("b", plain.clone()),
        ]);
        assert_eq!(serialize(&[soft]).expect("serialized"), "a\nb\n");
        let hard = paragraph(vec![
            text("a", plain.clone()),
            SeedInline::HardBreak,
            SeedInline::HardBreak,
            text("b", plain),
        ]);
        assert_eq!(serialize(&[hard]).expect("serialized"), "a  \nb\n");
    }

    #[test]
    fn marks_serialize_with_their_canonical_delimiters() {
        let bold = SeedMarks {
            bold: true,
            ..SeedMarks::default()
        };
        let link = SeedMarks {
            link: Some("https://e.com/a(1)".to_owned()),
            ..SeedMarks::default()
        };
        let block = paragraph(vec![
            text("x", bold),
            text(" and ", SeedMarks::default()),
            text("y", link),
        ]);
        assert_eq!(
            serialize(&[block]).expect("serialized"),
            "**x** and [y](https://e.com/a\\(1\\))\n"
        );
    }
}
