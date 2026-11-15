//! The text a reader sees in an HTML block's file (#1872): what search indexes and the link scan
//! reads for the note that embeds it. A port of `apps/desktop/src/main/file-text/html-text.ts`.
//! The file is never changed and its scripts never run.
//!
//! Electron parses with jsdom (parse5); this parses with html5ever. Both follow the HTML parsing
//! algorithm with scripting off, so the trees agree; `html-text.json` holds the cases, generated
//! by running `html-text.ts` in place.
//!
//! The input is untrusted, so four caps bound the work. A file over [`HTML_TEXT_MAX_BYTES`] is
//! refused before it is decoded. The tree builder may create at most [`node_budget`] nodes: the
//! spec's formatting reconstruction clones every open formatting element for each run of text,
//! so a 2 MiB file can otherwise ask for billions of nodes. The tree may nest at most
//! [`MAX_DEPTH`] deep: the tree builder scans its stack of open elements for most tags, so
//! 400,000 nested `div`s cost minutes of CPU. A node's depth is counted from its parent links
//! when it is attached, since the adoption agency moves whole subtrees. And the parse stops after
//! [`PARSE_DEADLINE`]: html5ever compares each attribute of a tag with every earlier one, so one
//! tag with 500,000 attributes costs minutes and builds a single node. The input is fed in chunks
//! and the parse stops at the first chunk past a cap. Electron has none of these caps (parse5
//! builds the whole tree, and stalls on the attribute flood too), so only such a file reads
//! differently: it is unreadable here.
//!
//! Known divergence: text foster-parented out of a table (`<table>loose<tr>...`) reads before
//! the table, where the HTML spec and browsers put it; jsdom reads it after. And an element
//! inside `select` other than an option (`<select><div>a</div>b</select>`) stays an element, as
//! the current spec and browsers keep it, so a block there starts a paragraph; parse5 drops the
//! tag and runs its text into the option's. The words are the same.

use std::borrow::Cow;
use std::cell::{Cell, RefCell};
use std::num::NonZeroU32;
use std::rc::Rc;
use std::time::{Duration, Instant};

use html5ever::tendril::{StrTendril, TendrilSink as _};
use html5ever::tree_builder::{ElementFlags, NodeOrText, QuirksMode, TreeSink};
use html5ever::{Attribute, ParseOpts, QualName, local_name, ns, parse_document};
use memry_core::domain::file_text::normalize_extracted_text;

use crate::vault::paths::is_js_space;

/// The largest HTML block file parsed for text (`HTML_TEXT_MAX_BYTES`, `runner.ts:77`): 4x the
/// agent tool's 512K-character cap, so every block an agent can write fits.
pub const HTML_TEXT_MAX_BYTES: usize = 2 * 1024 * 1024;

/// Input is fed to the parser this many bytes at a time; the caps are checked in between.
#[doc(hidden)]
pub const FEED_CHUNK: usize = 256;

/// The longest a parse may run. One chunk of input costs at most a fraction of a second, so the
/// parse stops soon after.
pub const PARSE_DEADLINE: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum HtmlTextError {
    #[error("Too large to read ({size} bytes, limit {HTML_TEXT_MAX_BYTES})")]
    TooLarge { size: usize },
    #[error("the HTML builds more than {limit} elements and text runs")]
    TooManyNodes { limit: usize },
    #[error("the HTML nests more than {MAX_DEPTH} elements deep")]
    TooDeep,
    #[error("the HTML takes more than {} seconds to parse", PARSE_DEADLINE.as_secs())]
    TooSlow,
}

/// The deepest element the tree builder may nest: Blink's `kMaximumHTMLParserDOMTreeDepth`.
pub const MAX_DEPTH: usize = 512;

/// The most nodes any file builds: 128 MiB of [`Node`]s.
const MAX_NODES: usize = 1 << 22;

/// The most nodes `len` bytes of HTML may build. Each tag, text run or comment takes at least one
/// byte, and the elements the parser adds on its own (`html`, `tbody`, a reconstructed `b`) stay
/// well within a second one per byte in any document a person or an agent writes.
pub fn node_budget(len: usize) -> usize {
    (2 * len + 64).min(MAX_NODES)
}

thread_local! {
    static STEPS: Cell<usize> = const { Cell::new(0) };
}

fn step() {
    STEPS.with(|steps| steps.set(steps.get() + 1));
}

/// Nodes created, parent links followed and nodes visited on this thread, for the complexity
/// tests.
#[doc(hidden)]
pub fn html_steps() -> usize {
    STEPS.with(Cell::get)
}

/// `readHtmlText`: the visible text, inline code as markdown code spans and `pre` as fenced
/// blocks, so the link scan skips links inside code. Invalid UTF-8 reads as U+FFFD, as Electron's
/// `Buffer#toString('utf8')` does.
pub fn read_html_text(bytes: &[u8]) -> Result<String, HtmlTextError> {
    if bytes.len() > HTML_TEXT_MAX_BYTES {
        return Err(HtmlTextError::TooLarge { size: bytes.len() });
    }
    let html = String::from_utf8_lossy(bytes);
    let tree = parse(&html, node_budget(bytes.len()), PARSE_DEADLINE)?;
    let mut out = String::new();
    let mut stack = vec![Item::Node(tree.document_element())];
    while let Some(item) = stack.pop() {
        let id = match item {
            Item::Break => {
                out.push_str("\n\n");
                continue;
            }
            Item::Node(Some(id)) => id,
            Item::Node(None) => continue,
        };
        step();
        let tag = match tree.node(id).kind {
            Kind::Text { start, end } => {
                out.push_str(tree.text(start, end));
                continue;
            }
            Kind::Element(tag) => tag,
            Kind::Contents(_) | Kind::Other => continue,
        };
        match tag {
            Tag::Hidden => {}
            Tag::Pre => out.push_str(&code_block(&tree.code_text(id))),
            Tag::InlineCode => out.push_str(&code_span(&tree.code_text(id))),
            Tag::Br => out.push('\n'),
            Tag::Block | Tag::Inline => {
                let block = tag == Tag::Block;
                if block {
                    stack.push(Item::Break);
                }
                stack.extend(
                    tree.children_reversed(id)
                        .map(|child| Item::Node(Some(child))),
                );
                if block {
                    out.push_str("\n\n");
                }
            }
        }
    }
    Ok(normalize_extracted_text(&out))
}

enum Item {
    Node(Option<Id>),
    Break,
}

/// How the walk treats an element. Only HTML elements are in the sets: jsdom's `tagName` of an
/// SVG or MathML element is its lower-case local name, which none of the upper-case sets hold.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Tag {
    /// `HIDDEN_ELEMENTS`: never rendered as text.
    Hidden,
    Pre,
    /// `INLINE_CODE_ELEMENTS`.
    InlineCode,
    Br,
    /// `BLOCK_ELEMENTS`: starts a new paragraph.
    Block,
    Inline,
}

fn classify(name: &QualName) -> Tag {
    if name.ns != ns!(html) {
        return Tag::Inline;
    }
    match &*name.local {
        "script" | "style" | "noscript" | "template" | "head" => Tag::Hidden,
        "pre" => Tag::Pre,
        "code" | "kbd" | "samp" => Tag::InlineCode,
        "br" => Tag::Br,
        "address" | "article" | "aside" | "blockquote" | "caption" | "dd" | "details"
        | "dialog" | "div" | "dl" | "dt" | "fieldset" | "figcaption" | "figure" | "footer"
        | "form" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "header" | "hr" | "li" | "main"
        | "nav" | "ol" | "p" | "section" | "summary" | "table" | "td" | "th" | "tr" | "ul" => {
            Tag::Block
        }
        _ => Tag::Inline,
    }
}

fn longest_backtick_run(text: &str) -> usize {
    text.split(|c| c != '`').map(str::len).max().unwrap_or(0)
}

/// `codeSpan`: one line of inline code, its whitespace collapsed as an HTML renderer does.
fn code_span(text: &str) -> String {
    let content = text
        .split(is_js_space)
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if content.is_empty() {
        return String::new();
    }
    let ticks = "`".repeat(longest_backtick_run(&content) + 1);
    let pad = if content.starts_with('`') || content.ends_with('`') {
        " "
    } else {
        ""
    };
    format!("{ticks}{pad}{content}{pad}{ticks}")
}

/// `codeBlock`: a fenced block, its fence longer than any backtick run inside it.
fn code_block(text: &str) -> String {
    let content = text.trim_matches('\n');
    if content.trim_matches(is_js_space).is_empty() {
        return String::new();
    }
    let fence = "`".repeat((longest_backtick_run(content) + 1).max(3));
    format!("\n\n{fence}\n{content}\n{fence}\n\n")
}

/// A node's index in the arena plus one, so an optional link takes four bytes.
type Id = NonZeroU32;

const DOCUMENT: Id = NonZeroU32::MIN;

enum Kind {
    Element(Tag),
    /// A byte range of [`Tree::text`].
    Text {
        start: u32,
        end: u32,
    },
    /// A template's content fragment, which nests one level below its template.
    Contents(Id),
    /// The document or a comment.
    Other,
}

/// An arena node with sibling links, so every insert and removal the tree builder asks for is
/// O(1) (a foster-parented run before a table would otherwise shift a sibling list each time).
/// It takes 32 bytes, so the largest tree fits in 128 MiB.
struct Node {
    kind: Kind,
    parent: Option<Id>,
    first_child: Option<Id>,
    last_child: Option<Id>,
    prev: Option<Id>,
    next: Option<Id>,
}

struct Tree {
    nodes: Vec<Node>,
    /// Every text node's characters, in the order the parser created them. At most the decoded
    /// input, so the offsets fit `u32`.
    text: String,
}

impl Tree {
    fn node(&self, id: Id) -> &Node {
        &self.nodes[id.get() as usize - 1]
    }

    fn node_mut(&mut self, id: Id) -> &mut Node {
        &mut self.nodes[id.get() as usize - 1]
    }

    fn text(&self, start: u32, end: u32) -> &str {
        &self.text[start as usize..end as usize]
    }

    /// `document.documentElement`.
    fn document_element(&self) -> Option<Id> {
        self.children(DOCUMENT)
            .find(|&id| matches!(self.node(id).kind, Kind::Element(_)))
    }

    fn children(&self, id: Id) -> impl Iterator<Item = Id> + '_ {
        std::iter::successors(self.node(id).first_child, |&child| self.node(child).next)
    }

    fn children_reversed(&self, id: Id) -> impl Iterator<Item = Id> + '_ {
        std::iter::successors(self.node(id).last_child, |&child| self.node(child).prev)
    }

    /// The levels above `id` (a template's contents count as a child of the template), counted
    /// from the parent links as they are now, up to one past [`MAX_DEPTH`].
    fn depth(&self, mut id: Id) -> usize {
        let mut depth = 0;
        while depth <= MAX_DEPTH {
            step();
            let node = self.node(id);
            let up = match node.kind {
                Kind::Contents(template) => Some(template),
                _ => node.parent,
            };
            let Some(up) = up else {
                break;
            };
            id = up;
            depth += 1;
        }
        depth
    }

    /// `codeText`: the text of a code element, line breaks kept, hidden elements left out.
    fn code_text(&self, id: Id) -> String {
        let mut text = String::new();
        let mut stack = vec![id];
        while let Some(id) = stack.pop() {
            step();
            match self.node(id).kind {
                Kind::Text { start, end } => text.push_str(self.text(start, end)),
                Kind::Element(Tag::Hidden) | Kind::Contents(_) | Kind::Other => {}
                Kind::Element(tag) => {
                    if tag == Tag::Br {
                        text.push('\n');
                    }
                    stack.extend(self.children_reversed(id));
                }
            }
        }
        text
    }

    fn detach(&mut self, id: Id) {
        let Node {
            parent, prev, next, ..
        } = *self.node(id);
        let Some(parent) = parent else {
            return;
        };
        match prev {
            Some(prev) => self.node_mut(prev).next = next,
            None => self.node_mut(parent).first_child = next,
        }
        match next {
            Some(next) => self.node_mut(next).prev = prev,
            None => self.node_mut(parent).last_child = prev,
        }
        let node = self.node_mut(id);
        node.parent = None;
        node.prev = None;
        node.next = None;
    }

    /// Moves `id` under `parent`, before `before` or last.
    fn insert(&mut self, parent: Id, id: Id, before: Option<Id>) {
        self.detach(id);
        let prev = match before {
            Some(before) => self.node(before).prev,
            None => self.node(parent).last_child,
        };
        match prev {
            Some(prev) => self.node_mut(prev).next = Some(id),
            None => self.node_mut(parent).first_child = Some(id),
        }
        match before {
            Some(before) => self.node_mut(before).prev = Some(id),
            None => self.node_mut(parent).last_child = Some(id),
        }
        let node = self.node_mut(id);
        node.parent = Some(parent);
        node.prev = prev;
        node.next = before;
    }
}

/// A tree-builder handle. `id` is `None` for a node created past the budget: the parse is
/// abandoned at the end of the chunk, so it is never attached.
struct Handle {
    id: Option<Id>,
    name: QualName,
    integration_point: bool,
    template: Option<Id>,
}

type Ref = Rc<Handle>;

struct Sink {
    tree: RefCell<Tree>,
    budget: usize,
    over: Cell<Option<HtmlTextError>>,
}

fn unnamed() -> QualName {
    QualName::new(None, ns!(), local_name!(""))
}

impl Sink {
    fn create(&self, kind: Kind) -> Option<Id> {
        step();
        let mut tree = self.tree.borrow_mut();
        let len = tree.nodes.len();
        if len >= self.budget {
            self.over
                .set(Some(HtmlTextError::TooManyNodes { limit: self.budget }));
            return None;
        }
        // Grow by doubling, but never past the budget.
        if len == tree.nodes.capacity() {
            tree.nodes.reserve_exact(len.max(64).min(self.budget - len));
        }
        tree.nodes.push(Node {
            kind,
            parent: None,
            first_child: None,
            last_child: None,
            prev: None,
            next: None,
        });
        // `len < budget <= MAX_NODES`, so the id fits.
        Id::new(len as u32 + 1)
    }

    fn create_text(&self, text: &str) -> Option<Id> {
        let start = self.tree.borrow().text.len();
        let id = self.create(Kind::Text {
            start: start as u32,
            end: (start + text.len()) as u32,
        })?;
        self.tree.borrow_mut().text.push_str(text);
        Some(id)
    }

    fn handle(&self, id: Option<Id>, name: QualName) -> Ref {
        Rc::new(Handle {
            id,
            name,
            integration_point: false,
            template: None,
        })
    }

    /// Fails the parse when a child of `parent` would nest past [`MAX_DEPTH`].
    fn check_depth(&self, tree: &Tree, parent: Id) {
        if tree.depth(parent) + 1 > MAX_DEPTH {
            self.over.set(Some(HtmlTextError::TooDeep));
        }
    }

    fn attach(&self, parent: Option<Id>, child: NodeOrText<Ref>, before: Option<Id>) {
        let Some(parent) = parent else {
            return;
        };
        let id = match child {
            NodeOrText::AppendNode(node) => node.id,
            NodeOrText::AppendText(text) => self.create_text(&text),
        };
        if let Some(id) = id {
            let mut tree = self.tree.borrow_mut();
            tree.insert(parent, id, before);
            self.check_depth(&tree, parent);
        }
    }
}

impl TreeSink for Sink {
    type Handle = Ref;
    type Output = Result<Tree, HtmlTextError>;
    type ElemName<'a> = &'a QualName;

    fn finish(self) -> Result<Tree, HtmlTextError> {
        match self.over.into_inner() {
            Some(error) => Err(error),
            None => Ok(self.tree.into_inner()),
        }
    }

    fn parse_error(&self, _msg: Cow<'static, str>) {}

    fn get_document(&self) -> Ref {
        self.handle(Some(DOCUMENT), unnamed())
    }

    fn elem_name<'a>(&'a self, target: &'a Ref) -> &'a QualName {
        &target.name
    }

    fn create_element(&self, name: QualName, _: Vec<Attribute>, flags: ElementFlags) -> Ref {
        let id = self.create(Kind::Element(classify(&name)));
        let template = match id {
            Some(id) if flags.template => self.create(Kind::Contents(id)),
            _ => None,
        };
        Rc::new(Handle {
            id,
            name,
            integration_point: flags.mathml_annotation_xml_integration_point,
            template,
        })
    }

    fn create_comment(&self, _: StrTendril) -> Ref {
        self.handle(self.create(Kind::Other), unnamed())
    }

    fn create_pi(&self, _: StrTendril, _: StrTendril) -> Ref {
        self.handle(self.create(Kind::Other), unnamed())
    }

    fn append(&self, parent: &Ref, child: NodeOrText<Ref>) {
        self.attach(parent.id, child, None);
    }

    fn append_based_on_parent_node(&self, element: &Ref, prev: &Ref, child: NodeOrText<Ref>) {
        let has_parent = element
            .id
            .is_some_and(|id| self.tree.borrow().node(id).parent.is_some());
        if has_parent {
            self.append_before_sibling(element, child);
        } else {
            self.append(prev, child);
        }
    }

    fn append_doctype_to_document(&self, _: StrTendril, _: StrTendril, _: StrTendril) {}

    fn get_template_contents(&self, target: &Ref) -> Ref {
        self.handle(target.template, unnamed())
    }

    fn is_mathml_annotation_xml_integration_point(&self, handle: &Ref) -> bool {
        handle.integration_point
    }

    fn same_node(&self, x: &Ref, y: &Ref) -> bool {
        Rc::ptr_eq(x, y) || (x.id.is_some() && x.id == y.id)
    }

    fn set_quirks_mode(&self, _: QuirksMode) {}

    fn append_before_sibling(&self, sibling: &Ref, child: NodeOrText<Ref>) {
        let Some(sibling) = sibling.id else {
            return;
        };
        let parent = self.tree.borrow().node(sibling).parent;
        self.attach(parent, child, Some(sibling));
    }

    fn add_attrs_if_missing(&self, _: &Ref, _: Vec<Attribute>) {}

    fn remove_from_parent(&self, target: &Ref) {
        if let Some(id) = target.id {
            self.tree.borrow_mut().detach(id);
        }
    }

    fn reparent_children(&self, node: &Ref, new_parent: &Ref) {
        let (Some(node), Some(new_parent)) = (node.id, new_parent.id) else {
            return;
        };
        let mut tree = self.tree.borrow_mut();
        if tree.node(node).first_child.is_none() {
            return;
        }
        while let Some(child) = tree.node(node).first_child {
            tree.insert(new_parent, child, None);
        }
        self.check_depth(&tree, new_parent);
    }
}

/// `new JSDOM(html)`: the document tree, scripting off as jsdom parses it. The byte order mark
/// stays, as `Buffer#toString('utf8')` keeps it: as text before `<html>` it starts `body` early.
fn parse(html: &str, budget: usize, deadline: Duration) -> Result<Tree, HtmlTextError> {
    let started = Instant::now();
    let sink = Sink {
        tree: RefCell::new(Tree {
            nodes: Vec::new(),
            text: String::new(),
        }),
        budget,
        over: Cell::new(None),
    };
    sink.create(Kind::Other);
    let mut opts = ParseOpts::default();
    opts.tree_builder.scripting_enabled = false;
    opts.tokenizer.discard_bom = false;
    let mut parser = parse_document(sink, opts);
    let mut rest = html;
    while !rest.is_empty() {
        let mut cut = rest.len().min(FEED_CHUNK);
        while !rest.is_char_boundary(cut) {
            cut += 1;
        }
        let (chunk, tail) = rest.split_at(cut);
        parser.process(StrTendril::from_slice(chunk));
        if let Some(error) = parser.tokenizer.sink.sink.over.take() {
            return Err(error);
        }
        if started.elapsed() > deadline {
            return Err(HtmlTextError::TooSlow);
        }
        rest = tail;
    }
    parser.finish()
}

#[cfg(test)]
#[path = "html_tests.rs"]
mod tests;
