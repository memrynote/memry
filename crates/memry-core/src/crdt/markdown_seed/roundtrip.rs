//! Desktop's `serializeBlocks` (`blocknote-converter.ts`) for the blocks a
//! callout or quote body proves its claim with: BlockNote 0.54's
//! `htmlToMarkdown` over the blocks' HTML, then `normalizeSerializedMarkdown`
//! (`shared/empty-lines.ts`), over the text `writeHtmlCommentTokens` escapes
//! ([`super::escapes`]). Only paragraphs and headings of plain, bold, italic,
//! struck, code and link runs are serialized; anything else is
//! [`Unsupported`], so a claim is never decided on a guess.

use crate::domain::journal_rules::{is_js_whitespace, js_trim};

use super::escapes::escape_items;
use super::items::{Item, items};
use super::run_writer::{RunWriter, delimiter};
use super::{SeedBlock, SeedInline, SeedKind, Unsupported};

pub(super) const UNSERIALIZED: Unsupported = Unsupported("callout or quote body");

/// The markdown `blocks` serialize to, before the caller's `trim()`.
pub(super) fn serialize(blocks: &[SeedBlock]) -> Result<String, Unsupported> {
    let mut out = String::new();
    for block in blocks {
        if !block.children.is_empty() {
            return Err(UNSERIALIZED);
        }
        match block.kind {
            SeedKind::Paragraph => out.push_str(&inline(&block.content, false)?),
            SeedKind::Heading { level } => {
                out.push_str(&"#".repeat(usize::from(level)));
                let text = inline(&block.content, true)?;
                // An empty heading keeps no space after its `#`.
                if !text.chars().all(is_js_whitespace) {
                    out.push(' ');
                    out.push_str(&text);
                }
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
        || marker.is_some_and(|after| after.is_empty() || after.starts_with(is_js_whitespace))
}

/// One paragraph's or heading's content as the writer spells it:
/// `escapeMarkdownText`, then `tokenizeEmphasisRuns` and BlockNote's export,
/// with `restoreEmphasisRuns` putting each mark's delimiters back.
fn inline(content: &[SeedInline], heading: bool) -> Result<String, Unsupported> {
    let mut writer = RunWriter::default();
    for item in escape_items(items(content)?, heading)? {
        write_item(&item, &mut writer)?;
    }
    Ok(writer.finish())
}

/// A break is `\` and a newline.
pub(super) const BREAK: &str = "\\\n";

fn write_item(item: &Item, writer: &mut RunWriter) -> Result<(), Unsupported> {
    let marks = &item.marks;
    if let Some(href) = &marks.link {
        return write_link(&item.text, href, &mut writer.out);
    }
    if marks.code {
        for (index, part) in item.text.split('\n').enumerate() {
            if index > 0 {
                writer.out.push_str(BREAK);
            }
            if !part.is_empty() {
                writer.out.push_str(&code_span(part));
            }
        }
        return Ok(());
    }
    let text = item.text.replace('\n', BREAK);
    match delimiter(item) {
        Some(delimiter) => writer.emphasis(&text, delimiter),
        None => writer.out.push_str(&text),
    }
    Ok(())
}

/// A link's text, one link per line (`splitLinksAtBreaks`), its breaks
/// outside the links.
fn write_link(text: &str, href: &str, out: &mut String) -> Result<(), Unsupported> {
    let mut rest = text;
    while !rest.is_empty() {
        let breaks = rest.starts_with('\n');
        let end = rest.find(|c| (c == '\n') != breaks).unwrap_or(rest.len());
        let (part, tail) = rest.split_at(end);
        rest = tail;
        if breaks {
            for _ in part.chars() {
                out.push_str(BREAK);
            }
        } else if part == href {
            // A link whose text is its address travels as one token, so the
            // address is written as it is (`hrefParenTokens`).
            out.push_str(&format!("[{part}]({href})"));
        } else {
            out.push_str(&format!("[{part}]({})", address(href)?));
        }
    }
    Ok(())
}

/// A link address as the writer leaves it: parentheses that balance travel as
/// written (`hrefParenTokens`). Anything else the serializer escapes or the
/// tokens keep (a backslash, an angle bracket, whitespace) is
/// [`Unsupported`].
fn address(href: &str) -> Result<&str, Unsupported> {
    let mut depth = 0usize;
    for c in href.chars() {
        match c {
            '(' => depth += 1,
            ')' => depth = depth.checked_sub(1).ok_or(UNSERIALIZED)?,
            '\\' | '<' | '>' => return Err(UNSERIALIZED),
            c if is_js_whitespace(c) => return Err(UNSERIALIZED),
            _ => {}
        }
    }
    if depth == 0 {
        Ok(href)
    } else {
        Err(UNSERIALIZED)
    }
}

/// A code span, fenced with the fewest backticks no backtick run inside it
/// has (`shortFencedCode`, which keeps BlockNote's longest run plus one only
/// where that is the smallest), padded when it starts or ends with a
/// backtick.
fn code_span(text: &str) -> String {
    let runs: Vec<usize> = text.split(|c| c != '`').map(str::len).collect();
    let fence = "`".repeat((1..).find(|n| !runs.contains(n)).unwrap_or(1));
    if text.starts_with('`') || text.ends_with('`') {
        format!("{fence} {text} {fence}")
    } else {
        format!("{fence}{text}{fence}")
    }
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
    use crate::crdt::markdown_seed::SeedMarks;

    fn paragraph(content: Vec<SeedInline>) -> SeedBlock {
        SeedBlock::new(SeedKind::Paragraph, content)
    }

    fn hard_break() -> SeedInline {
        SeedInline::HardBreak {
            marks: SeedMarks::default(),
        }
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
            hard_break(),
            text("b", plain.clone()),
        ]);
        assert_eq!(serialize(&[soft]).expect("serialized"), "a\nb\n");
        let hard = paragraph(vec![
            text("a", plain.clone()),
            hard_break(),
            hard_break(),
            text("b", plain),
        ]);
        assert_eq!(serialize(&[hard]).expect("serialized"), "a  \nb\n");
    }

    #[test]
    fn text_that_reads_as_markup_is_escaped_as_desktop_writes_it() {
        let plain = SeedMarks::default();
        let body = paragraph(vec![text("a *b* c `d`", plain.clone())]);
        assert_eq!(
            serialize(&[body]).expect("serialized"),
            "a \\*b\\* c \\`d\\`\n"
        );
        let kept = paragraph(vec![text("5 * 3 and a_b_c", plain.clone())]);
        assert_eq!(serialize(&[kept]).expect("serialized"), "5 * 3 and a_b_c\n");
        let heading = SeedBlock::new(
            SeedKind::Heading { level: 2 },
            vec![text("a", plain.clone()), hard_break(), text("b", plain)],
        );
        assert_eq!(serialize(&[heading]).expect("serialized"), "## a<br>b\n");
    }

    #[test]
    fn a_break_is_spelled_inside_the_marks_of_its_run() {
        let bold = SeedMarks {
            bold: true,
            ..SeedMarks::default()
        };
        let inside = paragraph(vec![
            text("a", bold.clone()),
            SeedInline::HardBreak {
                marks: bold.clone(),
            },
            text("b", bold.clone()),
        ]);
        assert_eq!(serialize(&[inside]).expect("serialized"), "**a\nb**\n");
        let after = paragraph(vec![
            text("a", bold),
            hard_break(),
            text("b", SeedMarks::default()),
        ]);
        assert_eq!(serialize(&[after]).expect("serialized"), "**a**\nb\n");
    }

    #[test]
    fn a_link_keeps_its_brackets_and_a_spaced_code_span_gains_a_space() {
        let marks = SeedMarks {
            link: Some("https://e.com/a(1".to_owned()),
            ..SeedMarks::default()
        };
        let link = paragraph(vec![text("https://e.com/a(1", marks)]);
        assert_eq!(
            serialize(&[link]).expect("serialized"),
            "[https://e.com/a(1](https://e.com/a(1)\n"
        );
        let code = SeedMarks {
            code: true,
            ..SeedMarks::default()
        };
        let spaced = paragraph(vec![text(" b ", code)]);
        assert_eq!(serialize(&[spaced]).expect("serialized"), "`  b  `\n");
        let empty = SeedBlock::new(SeedKind::Heading { level: 2 }, Vec::new());
        assert_eq!(serialize(&[empty]).expect("serialized"), "##\n");
    }

    #[test]
    fn a_link_address_that_needs_escaping_is_not_decided() {
        let link = |href: &str| {
            let marks = SeedMarks {
                link: Some(href.to_owned()),
                ..SeedMarks::default()
            };
            paragraph(vec![text("y", marks)])
        };
        assert!(serialize(&[link("https://e.com/a(1")]).is_err());
        assert!(serialize(&[link("https://e.com/a b")]).is_err());
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
            "**x** and [y](https://e.com/a(1))\n"
        );
    }

    #[test]
    fn a_run_against_another_runs_stars_is_spelled_with_underscores() {
        let italic = SeedMarks {
            italic: true,
            ..SeedMarks::default()
        };
        let bold = SeedMarks {
            bold: true,
            ..SeedMarks::default()
        };
        let plain = SeedMarks::default();
        let written = |content: Vec<SeedInline>| serialize(&[paragraph(content)]).expect("written");
        // An escaped star meets no delimiter, and the stars of the run before
        // open bold italic with a run's own.
        assert_eq!(written(vec![text("a*", italic.clone())]), "*a\\**\n");
        assert_eq!(written(vec![text("a*", bold.clone())]), "**a\\***\n");
        assert_eq!(written(vec![text("*a", italic.clone())]), "*\\*a*\n");
        assert_eq!(
            written(vec![text("a", italic.clone()), text("b", bold.clone())]),
            "*a*__b__\n"
        );
        assert_eq!(
            written(vec![text("a", bold.clone()), text("b", italic.clone())]),
            "**a**_b_\n"
        );
        // A run after text, or after a run spelled with underscores, meets no stars.
        assert_eq!(
            written(vec![
                text("a", italic.clone()),
                text(" ", plain.clone()),
                text("b", bold.clone())
            ]),
            "*a* **b**\n"
        );
        // A bare underscore before the run could open one that the
        // underscore delimiters would close.
        let code = SeedMarks {
            code: true,
            ..SeedMarks::default()
        };
        assert_eq!(
            written(vec![
                text("a_", code),
                text("b", italic.clone()),
                text("c", bold)
            ]),
            "`a_`*b***c**\n"
        );
    }

    #[test]
    fn a_block_whose_runs_use_underscores_escapes_every_underscore_in_its_text() {
        let italic = SeedMarks {
            italic: true,
            ..SeedMarks::default()
        };
        let bold = SeedMarks {
            bold: true,
            ..SeedMarks::default()
        };
        let body = paragraph(vec![
            text("snake_case ", SeedMarks::default()),
            text("a", italic),
            text("b", bold),
        ]);
        assert_eq!(
            serialize(&[body]).expect("written"),
            "snake\\_case *a*__b__\n"
        );
    }

    #[test]
    fn a_code_span_gets_the_fewest_backticks_its_runs_allow() {
        let code = SeedMarks {
            code: true,
            ..SeedMarks::default()
        };
        let written = |value: &str| {
            serialize(&[paragraph(vec![text(value, code.clone())])]).expect("written")
        };
        assert_eq!(written("c``c"), "`c``c`\n");
        assert_eq!(written("a`b```c"), "``a`b```c``\n");
        assert_eq!(written("`a```b"), "`` `a```b ``\n");
        assert_eq!(written("a`b"), "``a`b``\n");
        assert_eq!(written("a"), "`a`\n");
    }

    #[test]
    fn a_heading_break_closing_a_marked_run_is_written_after_the_run() {
        let bold = SeedMarks {
            bold: true,
            ..SeedMarks::default()
        };
        let heading = SeedBlock::new(
            SeedKind::Heading { level: 2 },
            vec![
                text("a", bold.clone()),
                SeedInline::HardBreak { marks: bold },
            ],
        );
        assert_eq!(serialize(&[heading]).expect("written"), "## **a**<br>\n");
    }
}
