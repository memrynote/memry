//! comrak's tree written out the way `marked` 17 (`gfm`, `breaks`) writes it,
//! so the export's bytes match Electron's: void elements without a slash, a
//! line break as `<br>` with no newline after it, a list item's first block
//! and a table body opened on the tag's line, `'` escaped in text and code,
//! and hrefs passed through `encodeURI` and written unescaped.

use std::cell::Cell;
use std::fmt::{self, Write};
use std::sync::LazyLock;

use comrak::Options;
use comrak::html::{ChildRendering, Context, format_document_with_formatter, format_node_default};
use comrak::nodes::{AstNode, NodeValue};
use comrak::options::Plugins;

static OPTIONS: LazyLock<Options<'static>> = LazyLock::new(|| {
    let mut options = Options::default();
    options.extension.table = true;
    options.extension.strikethrough = true;
    options.extension.tasklist = true;
    options.extension.autolink = true;
    // `marked` passes raw HTML through, and the export always has.
    options.render.r#unsafe = true;
    options
});

/// The note's markdown as HTML.
pub(super) fn render_markdown(markdown: &str) -> String {
    let arena = comrak::Arena::new();
    let root = comrak::parse_document(&arena, markdown, &OPTIONS);
    let layout = Layout {
        skip_newline: Cell::new(false),
        lines: markdown.split('\n').collect(),
    };
    let mut out = Output {
        html: String::new(),
        layout: &layout,
    };
    format_document_with_formatter(
        root,
        &OPTIONS,
        &mut out,
        &Plugins::default(),
        format,
        &layout,
    )
    .expect("writing to a String cannot fail");
    out.html
}

/// What the formatter needs beyond comrak's tree.
struct Layout<'s> {
    /// Set when the next write is a newline `marked` does not write.
    skip_newline: Cell<bool>,
    /// The source, for the blank lines `marked` keeps after an HTML block.
    lines: Vec<&'s str>,
}

/// The rendered HTML. comrak opens every block on a new line; `marked` writes a
/// list item's blocks straight after `<li>`, so the formatter asks this writer
/// to drop that one newline.
struct Output<'a> {
    html: String,
    layout: &'a Layout<'a>,
}

impl Write for Output<'_> {
    fn write_str(&mut self, s: &str) -> fmt::Result {
        if s.is_empty() {
            return Ok(());
        }
        if !(self.layout.skip_newline.replace(false) && s == "\n") {
            self.html.push_str(s);
        }
        Ok(())
    }
}

type Ctx<'o, 'c, 's> = Context<'o, 'c, &'s Layout<'s>>;

fn format<'a>(
    context: &mut Ctx<'_, '_, '_>,
    node: &'a AstNode<'a>,
    entering: bool,
) -> Result<ChildRendering, fmt::Error> {
    let value = &node.data().value;
    if entering
        && value.block()
        && node.parent().is_some_and(|parent| {
            matches!(
                parent.data().value,
                NodeValue::Item(_) | NodeValue::TaskItem(_)
            )
        })
    {
        context.user.skip_newline.set(true);
    }
    match value {
        NodeValue::Text(literal) => {
            if entering {
                escape(context, literal)?;
            }
        }
        NodeValue::Code(code) => {
            if entering {
                context.write_str("<code>")?;
                escape(context, &code.literal)?;
                context.write_str("</code>")?;
            }
        }
        NodeValue::CodeBlock(block) => {
            if entering {
                context.cr()?;
                let lang = block.info.split_ascii_whitespace().next().unwrap_or("");
                if lang.is_empty() {
                    context.write_str("<pre><code>")?;
                } else {
                    context.write_str("<pre><code class=\"language-")?;
                    escape(context, lang)?;
                    context.write_str("\">")?;
                }
                escape(
                    context,
                    block.literal.strip_suffix('\n').unwrap_or(&block.literal),
                )?;
                context.write_str("\n</code></pre>\n")?;
            }
        }
        NodeValue::HtmlBlock(block)
            if entering
                && node
                    .parent()
                    .is_some_and(|parent| matches!(parent.data().value, NodeValue::Document)) =>
        {
            context.cr()?;
            write_html_block(context, &block.literal, node.data().sourcepos.end.line)?;
        }
        NodeValue::SoftBreak | NodeValue::LineBreak => {
            if entering {
                context.write_str("<br>")?;
            }
        }
        NodeValue::ThematicBreak => {
            if entering {
                context.cr()?;
                context.write_str("<hr>\n")?;
            }
        }
        NodeValue::TaskItem(task) => {
            if !entering {
                return format_node_default(context, node, entering);
            }
            context.cr()?;
            if node
                .parent()
                .is_some_and(|parent| matches!(parent.data().value, NodeValue::List(_)))
            {
                context.write_str("<li>")?;
            }
            if checkbox_paragraph(node).is_none() {
                write_checkbox(context, task.symbol.is_some())?;
            }
        }
        NodeValue::Paragraph if entering => {
            let task = node
                .parent()
                .filter(|item| checkbox_paragraph(item).is_some_and(|p| p.same_node(node)));
            let checked = task.and_then(|item| match item.data().value {
                NodeValue::TaskItem(task) => Some(task.symbol.is_some()),
                _ => None,
            });
            let rendering = format_node_default(context, node, entering)?;
            if let Some(checked) = checked {
                write_checkbox(context, checked)?;
            }
            return Ok(rendering);
        }
        NodeValue::Link(link) => {
            if entering {
                context.write_str("<a href=\"")?;
                context.write_str(&encode_uri(&link.url))?;
                write_title(context, &link.title)?;
                context.write_str("\">")?;
            } else {
                context.write_str("</a>")?;
            }
        }
        NodeValue::Image(link) => {
            if entering {
                context.write_str("<img src=\"")?;
                context.write_str(&encode_uri(&link.url))?;
                context.write_str("\" alt=\"")?;
                return Ok(ChildRendering::Plain);
            }
            write_title(context, &link.title)?;
            context.write_str("\">")?;
        }
        NodeValue::TableRow(header) => {
            if entering {
                context.cr()?;
                if *header {
                    context.write_str("<thead>\n")?;
                } else if node
                    .previous_sibling()
                    .is_some_and(|row| matches!(row.data().value, NodeValue::TableRow(true)))
                {
                    context.write_str("<tbody>")?;
                }
                context.write_str("<tr>")?;
            } else {
                context.cr()?;
                context.write_str("</tr>")?;
                if *header {
                    context.cr()?;
                    context.write_str("</thead>")?;
                }
            }
        }
        NodeValue::Table(_) if !entering => {
            context.cr()?;
            if node
                .last_child()
                .is_some_and(|row| !matches!(row.data().value, NodeValue::TableRow(true)))
            {
                context.write_str("</tbody>")?;
            }
            context.write_str("</table>\n")?;
        }
        _ => return format_node_default(context, node, entering),
    }
    Ok(ChildRendering::HTML)
}

/// The paragraph a loose task item opens with: `marked` writes the checkbox
/// inside it, comrak before it.
fn checkbox_paragraph<'a>(item: &'a AstNode<'a>) -> Option<&'a AstNode<'a>> {
    let loose = item
        .parent()
        .is_some_and(|list| matches!(list.data().value, NodeValue::List(list) if !list.tight));
    let first = item.first_child()?;
    (loose && matches!(first.data().value, NodeValue::Paragraph)).then_some(first)
}

fn write_checkbox(context: &mut Ctx<'_, '_, '_>, checked: bool) -> fmt::Result {
    context.write_str(if checked {
        "<input checked=\"\" disabled=\"\" type=\"checkbox\"> "
    } else {
        "<input disabled=\"\" type=\"checkbox\"> "
    })
}

/// A top-level HTML block as `marked` writes it: its source lines with the
/// blank lines after them, and no newline after the last line of a note that
/// ends without one.
fn write_html_block(context: &mut Ctx<'_, '_, '_>, literal: &str, end_line: usize) -> fmt::Result {
    let following = context.user.lines.get(end_line..).unwrap_or_default();
    let Some((last, between)) = following.split_last() else {
        return context.write_str(literal.strip_suffix('\n').unwrap_or(literal));
    };
    let blank = |line: &str| line.trim_matches([' ', '\t']).is_empty();
    let mut text = literal.to_owned();
    for line in between {
        if !blank(line) {
            return context.write_str(&text);
        }
        text.push_str(line);
        text.push('\n');
    }
    if blank(last) {
        text.push_str(last);
    }
    context.write_str(&text)
}

/// ` title="…"` when the link has one; the caller closes the attribute list.
fn write_title(context: &mut Ctx<'_, '_, '_>, title: &str) -> fmt::Result {
    if title.is_empty() {
        return Ok(());
    }
    context.write_str("\" title=\"")?;
    escape(context, title)
}

/// `marked`'s `escape(text, true)`. comrak has already turned every entity in
/// the source into its character, so each `&` here is a literal one.
fn escape(context: &mut Ctx<'_, '_, '_>, text: &str) -> fmt::Result {
    let mut last = 0;
    for (at, c) in text.char_indices() {
        let entity = match c {
            '&' => "&amp;",
            '<' => "&lt;",
            '>' => "&gt;",
            '"' => "&quot;",
            '\'' => "&#39;",
            _ => continue,
        };
        context.write_str(&text[last..at])?;
        context.write_str(entity)?;
        last = at + 1;
    }
    context.write_str(&text[last..])
}

/// `marked`'s `cleanUrl`: `encodeURI` with `%` kept as written. Every byte it
/// would escape for HTML is percent-encoded, so the result goes into the
/// attribute as it is, except an `&` that starts a character reference.
/// `marked` writes the source as spelled, so `?a&amp;quot;b` reaches the page
/// as `?a&quot;b`; comrak has decoded it to `?a&quot;b`, which written as it is
/// would reach the page as `?a"b`. Such an `&` is written `&amp;`, which gives
/// `marked`'s bytes back; any other `&` stays as `marked` writes it.
///
/// comrak decodes `&amp;not` and leaves `&not` alike, as `&not`. The page
/// always gets the link comrak read; `marked`'s differs where the source spells
/// a legacy name raw (`?x&not&y`, `?x&copy`), which the page reads as `¬` and
/// `©`, and where a decoded entity is written percent-encoded (`&quot;` as
/// `%22`, the same link).
fn encode_uri(url: &str) -> String {
    const KEPT: &[u8] = b";,/?:@&=+$-_.!~*'()#%";
    let mut out = String::with_capacity(url.len());
    for (at, byte) in url.bytes().enumerate() {
        if byte == b'&' && starts_reference(&url.as_bytes()[at + 1..]) {
            out.push_str("&amp;");
        } else if byte.is_ascii_alphanumeric() || KEPT.contains(&byte) {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// Whether the text after an `&` reads as a character reference in an
/// attribute: `#`, a name closed by `;`, or one of HTML's legacy names, which
/// need no `;` unless an `=` follows.
fn starts_reference(rest: &[u8]) -> bool {
    match rest.first() {
        Some(b'#') => true,
        Some(first) if first.is_ascii_alphabetic() => {
            let len = rest
                .iter()
                .take_while(|b| b.is_ascii_alphanumeric())
                .count();
            match rest.get(len) {
                Some(b';') => true,
                Some(b'=') => false,
                _ => LEGACY_NAMES.contains(&&rest[..len]),
            }
        }
        _ => false,
    }
}

/// The HTML standard's named character references that parse without a `;`.
const LEGACY_NAMES: &[&[u8]] = &[
    b"AElig", b"AMP", b"Aacute", b"Acirc", b"Agrave", b"Aring", b"Atilde", b"Auml", b"COPY",
    b"Ccedil", b"ETH", b"Eacute", b"Ecirc", b"Egrave", b"Euml", b"GT", b"Iacute", b"Icirc",
    b"Igrave", b"Iuml", b"LT", b"Ntilde", b"Oacute", b"Ocirc", b"Ograve", b"Oslash", b"Otilde",
    b"Ouml", b"QUOT", b"REG", b"THORN", b"Uacute", b"Ucirc", b"Ugrave", b"Uuml", b"Yacute",
    b"aacute", b"acirc", b"acute", b"aelig", b"agrave", b"amp", b"aring", b"atilde", b"auml",
    b"brvbar", b"ccedil", b"cedil", b"cent", b"copy", b"curren", b"deg", b"divide", b"eacute",
    b"ecirc", b"egrave", b"eth", b"euml", b"frac12", b"frac14", b"frac34", b"gt", b"iacute",
    b"icirc", b"iexcl", b"igrave", b"iquest", b"iuml", b"laquo", b"lt", b"macr", b"micro",
    b"middot", b"nbsp", b"not", b"ntilde", b"oacute", b"ocirc", b"ograve", b"ordf", b"ordm",
    b"oslash", b"otilde", b"ouml", b"para", b"plusmn", b"pound", b"quot", b"raquo", b"reg",
    b"sect", b"shy", b"sup1", b"sup2", b"sup3", b"szlig", b"thorn", b"times", b"uacute", b"ucirc",
    b"ugrave", b"uml", b"uuml", b"yacute", b"yen", b"yuml",
];

#[cfg(test)]
mod tests {
    use super::encode_uri;

    /// The legacy-entity-name departure: comrak hands over `&not` for both
    /// `&amp;not` and a raw `&not`, so the port writes the link comrak read,
    /// where Electron writes a raw `?x&not&y` as spelled and the page reads
    /// `?x¬&y`. A decoded `&quot;` is written `%22`, the same link.
    #[test]
    fn a_legacy_entity_name_in_a_url_is_written_as_the_link_comrak_read() {
        assert_eq!(encode_uri("?x&not&y"), "?x&amp;not&y");
        assert_eq!(encode_uri("?x&copy"), "?x&amp;copy");
        assert_eq!(encode_uri("?x&copy=1"), "?x&copy=1");
        assert_eq!(encode_uri("?a\"b"), "?a%22b");
    }
}
