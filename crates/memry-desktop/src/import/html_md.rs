//! The HTML to Markdown converter the HTML, Evernote and Apple Journal importers share:
//! `apps/desktop/src/main/import/_shared/html-to-markdown.ts`.
//!
//! Electron parsed with jsdom (parse5); this parses with html5ever through the Turndown tree
//! sink (`web/extract/markdown/turndown/parse.rs`). Both follow the HTML parsing algorithm, so
//! the trees agree. The input is an untrusted file, so the walk is bounded twice: nesting past
//! [`MAX_DEPTH`] fails the note instead of the thread's stack, and the work (nodes visited plus
//! bytes produced) is capped at a multiple of the input's size, so a list nested hundreds deep
//! around a large text cannot re-indent it hundreds of times. Parsing itself is guarded by a
//! nesting scan ([`nesting`]), since html5ever's time grows with the square of the nesting.

mod nesting;

use std::cell::Cell;

use memry_core::markdown::frontmatter::js_trim;

use super::assets::percent_decode_ref;
use crate::web::extract::dom::{Document, NodeId, NodeKind};
use crate::web::extract::markdown::turndown::parse;

pub use nesting::{MAX_PARSE_DEPTH, nesting_scan_steps};

/// Element nesting the converter follows. Electron recursed until V8's stack ran out.
pub const MAX_DEPTH: usize = 256;
/// Work allowed per byte of input, plus [`BASE_STEPS`]: a byte is charged once for every level
/// that returns it, so ordinary pages stay far below it.
pub const STEPS_PER_INPUT_BYTE: usize = 256;
pub const BASE_STEPS: usize = 4 * 1024 * 1024;

thread_local! {
    static STEPS: Cell<usize> = const { Cell::new(0) };
}

/// Steps this thread's conversions have taken: nodes visited plus bytes produced.
#[doc(hidden)]
pub fn steps_taken() -> usize {
    STEPS.with(Cell::get)
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum HtmlMdError {
    #[error("The HTML is nested more than {MAX_DEPTH} levels deep")]
    TooDeep,
    #[error("The HTML is too complex to convert")]
    TooComplex,
}

/// `HtmlToMarkdownResult`, with the work it took.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HtmlMarkdown {
    pub markdown: String,
    /// Local refs the default anchor and image rules met, in document order, not deduped.
    pub assets: Vec<String>,
    pub steps: usize,
}

/// `HtmlToMarkdownHooks`: an importer's own rule for a link or an image. `None` falls back to
/// the default rule; `assets` is the `collect` callback.
pub trait HtmlHooks {
    fn anchor(&mut self, _href: &str, _text: &str, _assets: &mut Vec<String>) -> Option<String> {
        None
    }
    fn image(&mut self, _src: &str, _alt: &str, _assets: &mut Vec<String>) -> Option<String> {
        None
    }
}

pub struct NoHooks;
impl HtmlHooks for NoHooks {}

/// `new JSDOM(html).window.document`, for a page whose open tags nest at most
/// [`MAX_PARSE_DEPTH`] deep.
pub fn parse_html(html: &str) -> Result<Document, HtmlMdError> {
    nesting::check_nesting(html)?;
    Ok(parse::parse(html).doc)
}

/// `htmlToMarkdown(root, hooks)` for a root whose child nodes are `nodes`: the root's own tag
/// is not rendered. `input_len` is the size of the source the tree came from, for the budget.
pub fn html_to_markdown(
    doc: &Document,
    nodes: &[NodeId],
    input_len: usize,
    hooks: &mut dyn HtmlHooks,
) -> Result<HtmlMarkdown, HtmlMdError> {
    let mut conv = Converter {
        doc,
        hooks,
        assets: Vec::new(),
        depth: 0,
        steps: 0,
        budget: input_len
            .saturating_mul(STEPS_PER_INPUT_BYTE)
            .saturating_add(BASE_STEPS),
    };
    let markdown = js_trim(&conv.blocks(nodes)?).to_owned();
    Ok(HtmlMarkdown {
        markdown,
        assets: conv.assets,
        steps: conv.steps,
    })
}

/// Lower-case local name of an element.
pub fn tag(doc: &Document, id: NodeId) -> Option<String> {
    doc.element(id).map(|e| e.name.to_ascii_lowercase())
}

/// `classList.contains(name)`: tokens split at ASCII whitespace.
pub fn has_class(doc: &Document, id: NodeId, name: &str) -> bool {
    doc.get_attribute(id, "class").is_some_and(|class| {
        class
            .split([' ', '\t', '\n', '\u{c}', '\r'])
            .any(|token| token == name)
    })
}

/// Pre-order walk of the descendants of `root`, not entering a node `skip` accepts. Stops when
/// `visit` returns true. Iterative, so depth costs no stack.
pub fn walk(
    doc: &Document,
    root: NodeId,
    skip: &mut dyn FnMut(NodeId) -> bool,
    visit: &mut dyn FnMut(NodeId) -> bool,
) {
    let mut current = doc.first_child(root);
    while let Some(node) = current {
        let skipped = skip(node);
        if !skipped && visit(node) {
            return;
        }
        current = match doc.first_child(node) {
            Some(child) if !skipped => Some(child),
            _ => next_in_order(doc, node, root),
        };
    }
}

fn next_in_order(doc: &Document, mut node: NodeId, root: NodeId) -> Option<NodeId> {
    loop {
        if let Some(next) = doc.next_sibling(node) {
            return Some(next);
        }
        node = doc.parent_node(node)?;
        if node == root {
            return None;
        }
    }
}

/// `querySelectorAll` for a predicate: matching descendants in document order.
pub fn select(doc: &Document, root: NodeId, mut test: impl FnMut(NodeId) -> bool) -> Vec<NodeId> {
    let mut found = Vec::new();
    walk(doc, root, &mut |_| false, &mut |n| {
        if test(n) {
            found.push(n);
        }
        false
    });
    found
}

/// `textContent` of an element or a text node.
pub fn text_content(doc: &Document, id: NodeId) -> String {
    doc.text_content(id).unwrap_or_default()
}

/// `INLINE_TAGS`: grouped into an implicit paragraph inside a block container.
const INLINE_TAGS: [&str; 24] = [
    "br", "strong", "b", "em", "i", "del", "s", "strike", "mark", "code", "a", "time", "span",
    "sub", "sup", "u", "small", "font", "big", "abbr", "q", "cite", "label", "input",
];

fn starts_with_ci(text: &str, prefix: &str) -> bool {
    text.get(..prefix.len())
        .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
}

/// `decodeRef`: leading `../` segments dropped, then percent-decoded.
fn decode_ref(reference: &str) -> String {
    let mut rest = reference;
    while let Some(stripped) = rest.strip_prefix("../") {
        rest = stripped;
    }
    percent_decode_ref(rest)
}

fn quote_lines(inner: &str) -> String {
    inner
        .split('\n')
        .map(|line| {
            if line.is_empty() {
                ">".to_owned()
            } else {
                format!("> {line}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

struct Converter<'a> {
    doc: &'a Document,
    hooks: &'a mut dyn HtmlHooks,
    assets: Vec<String>,
    depth: usize,
    steps: usize,
    budget: usize,
}

type Out = Result<String, HtmlMdError>;

impl Converter<'_> {
    fn charge(&mut self, steps: usize) -> Result<(), HtmlMdError> {
        self.steps = self.steps.saturating_add(steps);
        STEPS.with(|count| count.set(count.get().saturating_add(steps)));
        if self.steps > self.budget {
            return Err(HtmlMdError::TooComplex);
        }
        Ok(())
    }

    /// Returns `out`, charged by its length.
    fn emit(&mut self, out: String) -> Out {
        self.charge(out.len())?;
        Ok(out)
    }

    /// One element level deeper for `f`.
    fn nest(&mut self, f: impl FnOnce(&mut Self) -> Out) -> Out {
        if self.depth >= MAX_DEPTH {
            return Err(HtmlMdError::TooDeep);
        }
        self.depth += 1;
        let out = f(self)?;
        self.depth -= 1;
        Ok(out)
    }

    fn text_of(&mut self, id: NodeId) -> Out {
        let text = text_content(self.doc, id);
        self.emit(text)
    }

    /// Descendants matching `test`, each visit charged.
    fn select(
        &mut self,
        root: NodeId,
        test: impl Fn(NodeId) -> bool,
    ) -> Result<Vec<NodeId>, HtmlMdError> {
        let mut visited = 0;
        let found = select(self.doc, root, |n| {
            visited += 1;
            test(n)
        });
        self.charge(visited)?;
        Ok(found)
    }

    fn is_inline_node(&self, node: NodeId) -> bool {
        match &self.doc.node(node).kind {
            NodeKind::Text(_) => true,
            NodeKind::Element(e) => INLINE_TAGS.contains(&e.name.to_ascii_lowercase().as_str()),
            _ => false,
        }
    }

    /// `renderBlocks` over `nodes`.
    fn blocks(&mut self, nodes: &[NodeId]) -> Out {
        let mut parts: Vec<String> = Vec::new();
        let mut inline = String::new();
        let flush = |parts: &mut Vec<String>, inline: &mut String| {
            let trimmed = js_trim(inline);
            if !trimmed.is_empty() {
                parts.push(trimmed.to_owned());
            }
            inline.clear();
        };
        for &node in nodes {
            self.charge(1)?;
            if self.is_inline_node(node) {
                let md = self.inline_node(node)?;
                inline.push_str(&md);
                continue;
            }
            if !self.doc.is_element(node) {
                continue;
            }
            flush(&mut parts, &mut inline);
            let md = self.block(node)?;
            let trimmed = js_trim(&md);
            if !trimmed.is_empty() {
                parts.push(trimmed.to_owned());
            }
        }
        flush(&mut parts, &mut inline);
        self.emit(parts.join("\n\n"))
    }

    fn child_blocks(&mut self, el: NodeId) -> Out {
        let children = self.doc.child_nodes(el);
        self.blocks(&children)
    }

    /// `renderBlock`.
    fn block(&mut self, el: NodeId) -> Out {
        self.nest(|c| {
            let name = tag(c.doc, el).unwrap_or_default();
            let out = match name.as_str() {
                "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                    let level = usize::from(name.as_bytes()[1] - b'0');
                    format!("{} {}", "#".repeat(level), c.inline(el)?)
                }
                "ul" | "ol" => c.list(el, name == "ol")?,
                "blockquote" => c.blockquote(el)?,
                "pre" => c.code(el)?,
                "hr" => "---".to_owned(),
                "figure" => c.figure(el)?,
                "table" => c.table(el)?,
                "img" => c.image(el)?,
                "header" | "div" | "article" | "section" | "main" => c.child_blocks(el)?,
                _ => js_trim(&c.inline(el)?).to_owned(),
            };
            c.emit(out)
        })
    }

    fn element_children(&self, el: NodeId, names: &[&str]) -> Vec<NodeId> {
        self.doc
            .children(el)
            .into_iter()
            .filter(|&c| tag(self.doc, c).is_some_and(|t| names.contains(&t.as_str())))
            .collect()
    }

    /// `renderList`: nested lists become indented sub-lists.
    fn list(&mut self, list: NodeId, ordered: bool) -> Out {
        self.nest(|c| {
            let mut lines = Vec::new();
            for (i, li) in c.element_children(list, &["li"]).into_iter().enumerate() {
                let nested = c.element_children(li, &["ul", "ol"]);
                let text = js_trim(&c.inline_except(li, &nested)?).to_owned();
                let todo = c.todo(li, &nested)?;
                let marker = match todo {
                    Some(true) => "- [x]".to_owned(),
                    Some(false) => "- [ ]".to_owned(),
                    None if ordered => format!("{}.", i + 1),
                    None => "-".to_owned(),
                };
                lines.push(format!("{marker} {text}"));
                let width = if todo.is_some() { 2 } else { marker.len() };
                let indent = " ".repeat(width + 1);
                for sub in nested {
                    let sub_ordered = tag(c.doc, sub).as_deref() == Some("ol");
                    let md = c.list(sub, sub_ordered)?;
                    for line in md.split('\n').filter(|line| !line.is_empty()) {
                        lines.push(format!("{indent}{line}"));
                    }
                }
            }
            c.emit(lines.join("\n"))
        })
    }

    /// `parseTodo`: `Some(checked)` for a checkbox item. A match inside one of the item's own
    /// sub-lists belongs to the child item.
    fn todo(&mut self, li: NodeId, nested: &[NodeId]) -> Result<Option<bool>, HtmlMdError> {
        let doc = self.doc;
        let (mut input, mut boxed, mut visited) = (None, None, 0);
        walk(doc, li, &mut |n| nested.contains(&n), &mut |n| {
            visited += 1;
            if input.is_none()
                && tag(doc, n).as_deref() == Some("input")
                && doc
                    .get_attribute(n, "type")
                    .is_some_and(|t| t.eq_ignore_ascii_case("checkbox"))
            {
                input = Some(n);
            }
            if boxed.is_none() && has_class(doc, n, "checkbox") {
                boxed = Some(n);
            }
            input.is_some() && boxed.is_some()
        });
        self.charge(visited)?;
        let is_todo = input.is_some()
            || boxed.is_some()
            || has_class(doc, li, "to-do")
            || doc
                .parent_element(li)
                .is_some_and(|parent| has_class(doc, parent, "to-do-list"));
        if !is_todo {
            return Ok(None);
        }
        Ok(Some(match (input, boxed) {
            (Some(input), _) => doc.has_attribute(input, "checked"),
            (None, Some(boxed)) => has_class(doc, boxed, "checkbox-on"),
            (None, None) => false,
        }))
    }

    fn blocks_or_inline(&mut self, el: NodeId) -> Out {
        let blocks = self.child_blocks(el)?;
        if blocks.is_empty() {
            return self.inline(el);
        }
        Ok(blocks)
    }

    fn blockquote(&mut self, el: NodeId) -> Out {
        let inner = self.blocks_or_inline(el)?;
        self.emit(quote_lines(&inner))
    }

    /// `renderCode`: a fenced block, its language from a `language-*` class.
    fn code(&mut self, pre: NodeId) -> Out {
        let doc = self.doc;
        let code = self
            .select(pre, |n| tag(doc, n).as_deref() == Some("code"))?
            .first()
            .copied()
            .unwrap_or(pre);
        let text = self.text_of(code)?;
        let text = text.strip_suffix('\n').unwrap_or(&text);
        let class = doc
            .get_attribute(code, "class")
            .filter(|class| !class.is_empty())
            .or_else(|| doc.get_attribute(pre, "class"))
            .unwrap_or_default();
        let lang = class
            .match_indices("language-")
            .find_map(|(at, prefix)| {
                let rest = &class[at + prefix.len()..];
                let end = rest
                    .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '-'))
                    .unwrap_or(rest.len());
                (end > 0).then(|| rest[..end].to_ascii_lowercase())
            })
            .unwrap_or_default();
        self.emit(format!("```{lang}\n{text}\n```"))
    }

    /// `renderFigure`: a Notion callout becomes a quote, any other figure its image.
    fn figure(&mut self, fig: NodeId) -> Out {
        let doc = self.doc;
        if has_class(doc, fig, "callout") {
            let content = doc.children(fig).last().copied().unwrap_or(fig);
            let inner = self.blocks_or_inline(content)?;
            return self.emit(quote_lines(&inner));
        }
        if let Some(&img) = self
            .select(fig, |n| tag(doc, n).as_deref() == Some("img"))?
            .first()
        {
            return self.image(img);
        }
        self.child_blocks(fig)
    }

    /// `renderTable`: every `tr` below the table, the first as the header.
    fn table(&mut self, table: NodeId) -> Out {
        let doc = self.doc;
        let rows = self.select(table, |n| tag(doc, n).as_deref() == Some("tr"))?;
        let mut matrix = Vec::with_capacity(rows.len());
        for row in rows {
            let cells =
                self.select(row, |n| matches!(tag(doc, n).as_deref(), Some("th" | "td")))?;
            let mut line = Vec::with_capacity(cells.len());
            for cell in cells {
                line.push(js_trim(&self.inline(cell)?.replace('\n', " ")).to_owned());
            }
            matrix.push(line);
        }
        if matrix.is_empty() {
            return Ok(String::new());
        }
        let cols = matrix.iter().map(Vec::len).max().unwrap_or(0);
        let to_line = |row: &[String]| {
            let mut cells = row.to_vec();
            cells.resize(cols, String::new());
            format!("| {} |", cells.join(" | "))
        };
        let mut lines = vec![to_line(&matrix[0]), to_line(&vec!["---".to_owned(); cols])];
        lines.extend(matrix[1..].iter().map(|row| to_line(row)));
        self.emit(lines.join("\n"))
    }

    fn inline(&mut self, el: NodeId) -> Out {
        self.inline_except(el, &[])
    }

    /// `renderInlineExcept`: the children of `el` inline, without those in `skip`.
    fn inline_except(&mut self, el: NodeId, skip: &[NodeId]) -> Out {
        let mut out = String::new();
        for node in self.doc.child_nodes(el) {
            self.charge(1)?;
            if skip.contains(&node) {
                continue;
            }
            out.push_str(&self.inline_node(node)?);
        }
        self.emit(out)
    }

    /// `renderInlineNode`.
    fn inline_node(&mut self, node: NodeId) -> Out {
        let doc = self.doc;
        match &doc.node(node).kind {
            NodeKind::Text(text) => return self.emit(text.clone()),
            NodeKind::Element(_) => {}
            _ => return Ok(String::new()),
        }
        self.nest(|c| {
            let name = tag(doc, node).unwrap_or_default();
            let out = match name.as_str() {
                "br" => "\n".to_owned(),
                "strong" | "b" => format!("**{}**", c.inline(node)?),
                "em" | "i" => format!("*{}*", c.inline(node)?),
                "del" | "s" | "strike" => format!("~~{}~~", c.inline(node)?),
                "mark" => format!("=={}==", c.inline(node)?),
                "code" => format!("`{}`", c.text_of(node)?),
                "a" => c.anchor(node)?,
                "img" => c.image(node)?,
                "input" => String::new(),
                "time" => c.text_of(node)?.replace('@', ""),
                _ if has_class(doc, node, "checkbox") => String::new(),
                _ => c.inline(node)?,
            };
            c.emit(out)
        })
    }

    /// `renderAnchor`, then `defaultAnchor`: a URL or `mailto:` stays a link, a local ref is
    /// collected.
    fn anchor(&mut self, a: NodeId) -> Out {
        let href = self
            .doc
            .get_attribute(a, "href")
            .unwrap_or_default()
            .into_owned();
        let mut text = js_trim(&self.inline(a)?).to_owned();
        if text.is_empty() {
            text = js_trim(&self.text_of(a)?).to_owned();
        }
        if let Some(md) = self.hooks.anchor(&href, &text, &mut self.assets) {
            return self.emit(md);
        }
        if href.is_empty() {
            return Ok(text);
        }
        if ["http://", "https://", "mailto:"]
            .iter()
            .any(|prefix| starts_with_ci(&href, prefix))
        {
            return self.emit(format!("[{text}]({href})"));
        }
        let decoded = decode_ref(&href);
        self.assets.push(decoded.clone());
        let label = if text.is_empty() { &decoded } else { &text };
        self.emit(format!("[{label}]({decoded})"))
    }

    /// `renderImage`, then `defaultImage`.
    fn image(&mut self, img: NodeId) -> Out {
        let src = self
            .doc
            .get_attribute(img, "src")
            .unwrap_or_default()
            .into_owned();
        let alt = js_trim(&self.doc.get_attribute(img, "alt").unwrap_or_default()).to_owned();
        if let Some(md) = self.hooks.image(&src, &alt, &mut self.assets) {
            return self.emit(md);
        }
        if src.is_empty() {
            return Ok(String::new());
        }
        if ["http://", "https://", "data:"]
            .iter()
            .any(|prefix| starts_with_ci(&src, prefix))
        {
            return self.emit(format!("![{alt}]({src})"));
        }
        let decoded = decode_ref(&src);
        self.assets.push(decoded.clone());
        self.emit(format!("![{alt}]({decoded})"))
    }
}
