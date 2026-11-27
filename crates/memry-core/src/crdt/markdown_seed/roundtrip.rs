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
    let mut out = String::new();
    let mut underscored = Vec::new();
    for item in escape_items(items(content)?, heading)? {
        write_item(&item, &mut out, &mut underscored)?;
    }
    resolve_underscores(&mut out, &underscored);
    Ok(out)
}

/// A break is `\` and a newline.
const BREAK: &str = "\\\n";

fn write_item(
    item: &Item,
    out: &mut String,
    underscored: &mut Vec<Delimiters>,
) -> Result<(), Unsupported> {
    let marks = &item.marks;
    if let Some(href) = &marks.link {
        return write_link(&item.text, href, out);
    }
    if marks.code {
        for (index, part) in item.text.split('\n').enumerate() {
            if index > 0 {
                out.push_str(BREAK);
            }
            if !part.is_empty() {
                out.push_str(&code_span(part));
            }
        }
        return Ok(());
    }
    let text = item.text.replace('\n', BREAK);
    let delimiter = if marks.bold {
        "**"
    } else if marks.italic {
        "*"
    } else if marks.strike {
        "~~"
    } else {
        out.push_str(&text);
        return Ok(());
    };
    emphasis(&text, delimiter, out, underscored);
    Ok(())
}

/// Where an underscore pair may stand for one run's stars: the byte offsets
/// of its opening and closing delimiter, which are as long as each other.
struct Delimiters {
    open: usize,
    close: usize,
    len: usize,
}

/// `restoreEmphasisRuns`: a run's leading and trailing whitespace and breaks
/// stay outside its delimiters (`EDGES`), and a run of nothing else has none.
/// A run the parser would misread with stars is an underscore candidate.
fn emphasis(run: &str, delimiter: &str, out: &mut String, underscored: &mut Vec<Delimiters>) {
    let lead = edge_prefix(run, false);
    let trail = run[lead..]
        .char_indices()
        .map(|(at, _)| lead + at)
        .chain([run.len()])
        .find(|&at| edge_prefix(&run[at..], true) == run.len() - at)
        .unwrap_or(run.len());
    if lead >= trail {
        out.push_str(run);
        return;
    }
    let content = &run[lead..trail];
    out.push_str(&run[..lead]);
    let open = out.len();
    out.push_str(delimiter);
    out.push_str(content);
    let close = out.len();
    out.push_str(delimiter);
    out.push_str(&run[trail..]);
    if meets_inner_stars(delimiter, content) && !has_bare_underscore(content) {
        underscored.push(Delimiters {
            open,
            close,
            len: delimiter.len(),
        });
    }
}

/// `meetsInnerStars`, for a run with no run inside it: three stars in a row
/// open bold italic, so an italic run whose content starts or ends with `*`
/// and a bold run whose content ends with one came back as text.
fn meets_inner_stars(delimiter: &str, content: &str) -> bool {
    match delimiter {
        "*" => content.starts_with('*') || content.ends_with('*'),
        "**" => content.ends_with('*'),
        _ => false,
    }
}

/// `hasBareUnderscore`: `parseDelimited` skips an escaped character, so only a
/// bare `_` could close an underscore run early.
fn has_bare_underscore(content: &str) -> bool {
    let mut chars = content.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            chars.next();
        } else if c == '_' {
            return true;
        }
    }
    false
}

/// `resolveUnderscores`: each candidate pair spelled `_` or `__` where the
/// parser reads them (`tryItalic` and `tryBold` refuse an opener between two
/// word characters, and no run closes on an underscore next to another), and
/// with its stars where it would not. Each is judged on the text before any
/// pair changes.
fn resolve_underscores(out: &mut String, pairs: &[Delimiters]) {
    let word = |c: Option<char>| c.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_');
    let readable: Vec<&Delimiters> = pairs
        .iter()
        .filter(|pair| {
            let before = out[..pair.open].chars().next_back();
            let first = out[pair.open + pair.len..].chars().next();
            let after = out[pair.close + pair.len..].chars().next();
            let opens = !(word(before) && word(first)) && before != Some('_');
            opens && after != Some('_')
        })
        .collect();
    for pair in readable {
        let swap = "_".repeat(pair.len);
        out.replace_range(pair.open..pair.open + pair.len, &swap);
        out.replace_range(pair.close..pair.close + pair.len, &swap);
    }
}

/// The length of the longest prefix of `text` matching
/// `/(?:\\\n(?:[^\S\n]*>)*|\s)*/`: a break (with the `>` prefixes a quote
/// carries onto the next line) or whitespace. At a run's end (`trailing`) a
/// `<br>` is one too: the break the escaper spelled for a heading's line.
fn edge_prefix(text: &str, trailing: bool) -> usize {
    let mut at = 0;
    loop {
        let rest = &text[at..];
        if rest.starts_with(BREAK) {
            at += BREAK.len();
            // `(?:[^\S\n]*>)*`
            loop {
                let tail = &text[at..];
                let blanks = tail
                    .find(|c: char| c == '\n' || !is_js_whitespace(c))
                    .unwrap_or(tail.len());
                if tail[blanks..].starts_with('>') {
                    at += blanks + 1;
                } else {
                    break;
                }
            }
        } else if trailing && rest.starts_with("<br>") {
            at += "<br>".len();
        } else if let Some(c) = rest.chars().next().filter(|c| is_js_whitespace(*c)) {
            at += c.len_utf8();
        } else {
            return at;
        }
    }
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

/// BlockNote's code span: a fence longer than any backtick run in it, padded
/// when it starts or ends with a backtick.
fn code_span(text: &str) -> String {
    let longest = text.split(|c| c != '`').map(str::len).max().unwrap_or(0);
    let fence = "`".repeat(longest + 1);
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
    fn a_run_whose_stars_the_parser_would_misread_is_spelled_with_underscores() {
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
        assert_eq!(written(vec![text("a*", italic.clone())]), "_a\\*_\n");
        // An escaped star opens the content with a backslash, not a star.
        assert_eq!(written(vec![text("*a", italic.clone())]), "*\\*a*\n");
        assert_eq!(written(vec![text("a*", bold.clone())]), "__a\\*__\n");
        assert_eq!(written(vec![text("*a", bold)]), "**\\*a**\n");
        // A bare underscore would close the run early, and an opener between
        // two word characters is no opener.
        assert_eq!(written(vec![text("a_b*", italic.clone())]), "*a_b\\**\n");
        assert_eq!(
            written(vec![text("x", plain.clone()), text("a*", italic)]),
            "x*a\\**\n"
        );
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
