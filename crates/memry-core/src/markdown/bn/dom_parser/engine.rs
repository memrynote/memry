//! `DOMParser.parse` of prosemirror-model 1.25.11 (`from_dom.ts`): the
//! `ParseContext` that places each DOM node into the open ProseMirror node it
//! fits, wrapping, closing and synchronising as `findPlace` decides.
//!
//! Left out because the memry rules never use them: `context` rules, `ignore`
//! and `closeParent` rules, `findPositions`, `from`/`to`, `topMatch`,
//! `ruleFromNode`, and the `needsBlock` path (it only runs with a typeless top
//! context, and `parse` always gets a `topNode`).

use std::sync::OnceLock;

mod place;
mod text;
mod util;

use util::{attrs_to_any, normalize_list};

use super::error::ParseError;
use super::rule::{AttrsResult, ContentElement, StyleRule, StyleTarget, TagRule, Target};
use super::rules;
use crate::markdown::bn::dom::{Dom, NodeData, NodeId};
use crate::markdown::frontmatter::js::is_js_whitespace;
use crate::markdown::pm::content::StateId;
use crate::markdown::pm::{Attrs, Fragment, Mark, Node, NodeTypeId, Schema};

pub struct ParseOptions {
    pub top_node: Option<Node>,
    pub preserve_whitespace: Option<bool>,
    /// `preserveWhitespace: "full"`; wins over `preserve_whitespace`.
    pub preserve_full: bool,
}

pub struct DomParser {
    pub schema: &'static Schema,
    tags: Vec<TagRule>,
    styles: Vec<StyleRule>,
    matched_styles: Vec<&'static str>,
}

const BLOCK_TAGS: &[&str] = &[
    "address",
    "article",
    "aside",
    "blockquote",
    "body",
    "canvas",
    "dd",
    "div",
    "dl",
    "fieldset",
    "figcaption",
    "figure",
    "footer",
    "form",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "header",
    "hgroup",
    "hr",
    "li",
    "noscript",
    "ol",
    "output",
    "p",
    "pre",
    "section",
    "table",
    "tfoot",
    "ul",
];
const IGNORE_TAGS: &[&str] = &["head", "noscript", "object", "script", "style", "title"];

const OPT_PRESERVE_WS: u8 = 1;
const OPT_PRESERVE_WS_FULL: u8 = 2;
const OPT_OPEN_LEFT: u8 = 4;

pub(super) fn is_pm_ws(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\r' | '\n' | '\u{0C}')
}

impl DomParser {
    pub fn new(schema: &'static Schema, tags: Vec<TagRule>, styles: Vec<StyleRule>) -> DomParser {
        let mut matched_styles: Vec<&'static str> = Vec::new();
        for rule in &styles {
            let prop = rule.style.split('=').next().unwrap_or("");
            if !matched_styles.contains(&prop) {
                matched_styles.push(prop);
            }
        }
        DomParser {
            schema,
            tags,
            styles,
            matched_styles,
        }
    }

    /// `DOMParser.fromSchema(memrySchema)`.
    pub fn memry() -> &'static DomParser {
        static PARSER: OnceLock<DomParser> = OnceLock::new();
        PARSER.get_or_init(|| {
            let schema = Schema::memry();
            DomParser::new(schema, rules::tag_rules(schema), rules::style_rules(schema))
        })
    }

    pub fn parse(
        &self,
        dom: &mut Dom,
        root: NodeId,
        options: &ParseOptions,
    ) -> Result<Node, ParseError> {
        let mut cx = ParseContext::new(self, options);
        cx.add_all(dom, root, &[])?;
        cx.finish()
    }

    /// `normalizeLists`: no rule of the schema names `ul`/`ol` as a node rule.
    fn match_tag(
        &self,
        dom: &Dom,
        id: NodeId,
        after: Option<usize>,
    ) -> Option<(usize, Option<Attrs>)> {
        for i in after.map_or(0, |a| a + 1)..self.tags.len() {
            let rule = &self.tags[i];
            if !dom.matches(id, &rule.selector) {
                continue;
            }
            let mut attrs = None;
            if let Some(get) = rule.get_attrs {
                match get(dom, id) {
                    AttrsResult::Reject => continue,
                    AttrsResult::NoAttrs => {}
                    AttrsResult::Attrs(a) => attrs = Some(a),
                }
            }
            return Some((i, attrs));
        }
        None
    }

    fn match_style(
        &self,
        prop: &str,
        value: &str,
        after: Option<usize>,
    ) -> Option<(usize, Option<Attrs>)> {
        for i in after.map_or(0, |a| a + 1)..self.styles.len() {
            let rule = &self.styles[i];
            let style = rule.style;
            if !style.starts_with(prop) {
                continue;
            }
            if style.len() > prop.len()
                && (style.as_bytes()[prop.len()] != b'=' || &style[prop.len() + 1..] != value)
            {
                continue;
            }
            let mut attrs = None;
            if let Some(get) = rule.get_attrs {
                match get(value) {
                    AttrsResult::Reject => continue,
                    AttrsResult::NoAttrs => {}
                    AttrsResult::Attrs(a) => attrs = Some(a),
                }
            }
            return Some((i, attrs));
        }
        None
    }
}

fn ws_options_for(schema: &Schema, ty: Option<NodeTypeId>, preserve: Option<bool>, base: u8) -> u8 {
    if let Some(p) = preserve {
        return if p { OPT_PRESERVE_WS } else { 0 };
    }
    match ty {
        Some(t) if schema.node_ty(t).preserves_whitespace() => {
            OPT_PRESERVE_WS | OPT_PRESERVE_WS_FULL
        }
        _ => base & !OPT_OPEN_LEFT,
    }
}

struct NodeContext {
    uid: u64,
    ty: NodeTypeId,
    attrs: Option<Attrs>,
    marks: Vec<Mark>,
    solid: bool,
    matched: Option<StateId>,
    options: u8,
    content: Vec<Node>,
}

struct ParseContext<'p> {
    parser: &'p DomParser,
    schema: &'static Schema,
    nodes: Vec<NodeContext>,
    open: usize,
    local_preserve_ws: bool,
    next_uid: u64,
}

fn attrs_to_given(attrs: &Option<Attrs>) -> Attrs {
    attrs.clone().unwrap_or_default()
}

impl<'p> ParseContext<'p> {
    fn new(parser: &'p DomParser, options: &ParseOptions) -> Self {
        let schema = parser.schema;
        let top = options
            .top_node
            .as_ref()
            .expect("the memry parse always has a topNode");
        let top_options = if options.preserve_full {
            OPT_PRESERVE_WS | OPT_PRESERVE_WS_FULL
        } else {
            ws_options_for(schema, None, options.preserve_whitespace, 0)
        };
        let ctx = NodeContext {
            uid: 0,
            ty: top.ty,
            attrs: Some(top.attrs.clone()),
            marks: Vec::new(),
            solid: true,
            matched: Some(schema.node_ty(top.ty).content_match),
            options: top_options,
            content: Vec::new(),
        };
        ParseContext {
            parser,
            schema,
            nodes: vec![ctx],
            open: 0,
            local_preserve_ws: false,
            next_uid: 1,
        }
    }

    fn top(&self) -> &NodeContext {
        &self.nodes[self.open]
    }

    fn new_context(
        &mut self,
        ty: NodeTypeId,
        attrs: Option<Attrs>,
        marks: Vec<Mark>,
        solid: bool,
        options: u8,
    ) -> NodeContext {
        self.next_uid += 1;
        NodeContext {
            uid: self.next_uid,
            ty,
            attrs,
            marks,
            solid,
            matched: if options & OPT_OPEN_LEFT != 0 {
                None
            } else {
                Some(self.schema.node_ty(ty).content_match)
            },
            options,
            content: Vec::new(),
        }
    }

    /// `NodeContext.findWrapping`.
    fn context_find_wrapping(&mut self, depth: usize, node: &Node) -> Option<Vec<NodeTypeId>> {
        let schema = self.schema;
        let cx = &mut self.nodes[depth];
        if cx.matched.is_none() {
            let start = schema.content_match(cx.ty);
            if let Some(fill) = start.fill_before(std::slice::from_ref(node), false, 0) {
                cx.matched = start.match_fragment(&fill, 0).map(|m| m.id());
            } else {
                let wrap = start.find_wrapping(node.ty)?;
                cx.matched = Some(start.id());
                return Some(wrap);
            }
        }
        schema.content_match_at(cx.matched?).find_wrapping(node.ty)
    }

    /// `NodeContext.finish`.
    fn finish_context(&self, cx: NodeContext, open_end: bool) -> Result<Node, ParseError> {
        let schema = self.schema;
        let mut content = cx.content;
        if cx.options & OPT_PRESERVE_WS == 0
            && let Some(last) = content.last_mut()
            && let Some(text) = &last.text
        {
            let trimmed = text.trim_end_matches(is_pm_ws);
            if trimmed.is_empty() {
                content.pop();
            } else if trimmed.len() != text.len() {
                last.text = Some(trimmed.to_owned());
            }
        }
        let mut fragment = Fragment::from_array(content);
        if !open_end && let Some(m) = cx.matched {
            let fill = schema
                .content_match_at(m)
                .fill_before(&[], true, 0)
                .ok_or(ParseError::Js("fillBefore found no end"))?;
            fragment = schema.append_fragment(&fragment, &Fragment::from_array(fill));
        }
        Ok(schema.create(cx.ty, &attrs_to_given(&cx.attrs), fragment, cx.marks)?)
    }

    fn finish(&mut self) -> Result<Node, ParseError> {
        self.open = 0;
        self.close_extra(false)?;
        let cx = self.nodes.remove(0);
        self.finish_context(cx, false)
    }

    fn close_extra(&mut self, open_end: bool) -> Result<(), ParseError> {
        let mut i = self.nodes.len() - 1;
        while i > self.open {
            let cx = self.nodes.pop().expect("a node above the open one");
            let node = self.finish_context(cx, open_end)?;
            self.nodes[i - 1].content.push(node);
            i -= 1;
        }
        Ok(())
    }

    fn sync(&mut self, to: u64) -> bool {
        for i in (0..=self.open).rev() {
            if self.nodes[i].uid == to {
                self.open = i;
                return true;
            } else if self.local_preserve_ws {
                self.nodes[i].options |= OPT_PRESERVE_WS;
            }
        }
        false
    }

    fn add_all(&mut self, dom: &mut Dom, parent: NodeId, marks: &[Mark]) -> Result<(), ParseError> {
        let mut current = dom.first_child(parent);
        while let Some(child) = current {
            self.add_dom(dom, child, marks)?;
            current = dom.next_sibling(child);
        }
        Ok(())
    }

    fn add_dom(&mut self, dom: &mut Dom, id: NodeId, marks: &[Mark]) -> Result<(), ParseError> {
        match dom.data(id) {
            NodeData::Text(_) => self.add_text_node(dom, id, marks),
            NodeData::Element(_) => self.add_element(dom, id, marks, None),
            _ => Ok(()),
        }
    }

    fn add_text_node(&mut self, dom: &Dom, id: NodeId, marks: &[Mark]) -> Result<(), ParseError> {
        let value = dom.text_value(id).unwrap_or_default().to_owned();
        let prev_is_br = dom
            .previous_sibling(id)
            .is_some_and(|p| dom.node_name(p) == "BR");
        self.add_text(marks, &value, prev_is_br)
    }

    fn linebreak_replacement(&self) -> Option<NodeTypeId> {
        self.schema
            .node_types()
            .find(|(_, t)| t.spec.linebreak_replacement)
            .map(|(id, _)| id)
    }

    fn create_plain(&self, ty: NodeTypeId) -> Result<Node, ParseError> {
        Ok(self
            .schema
            .create(ty, &[], Fragment::default(), Vec::new())?)
    }

    fn add_element(
        &mut self,
        dom: &mut Dom,
        id: NodeId,
        marks: &[Mark],
        match_after: Option<usize>,
    ) -> Result<(), ParseError> {
        let outer_ws = self.local_preserve_ws;
        let mut top_uid = self.top().uid;
        let is_pre = dom.node_name(id) == "PRE" || dom.style(id).get("white-space").contains("pre");
        if is_pre {
            self.local_preserve_ws = true;
        }
        let name = dom.node_name_lower(id);
        if (name == "ul" || name == "ol") && self.normalize_lists() {
            normalize_list(dom, id);
        }
        let rule = self.parser.match_tag(dom, id, match_after);
        if rule.is_none() && IGNORE_TAGS.contains(&name.as_str()) {
            // `ignoreFallback` only acts on a BR, which no ignored tag is.
        } else if rule.as_ref().is_none_or(|(i, _)| self.parser.tags[*i].skip) {
            let skip = rule.is_some();
            let mut sync = false;
            if BLOCK_TAGS.contains(&name.as_str()) {
                let top = self.top();
                if !top.content.is_empty()
                    && self.schema.node_ty(top.content[0].ty).is_inline
                    && self.open > 0
                {
                    self.open -= 1;
                    top_uid = self.top().uid;
                }
                sync = true;
            } else if dom.first_child(id).is_none() {
                self.leaf_fallback(dom, id, marks)?;
                self.local_preserve_ws = outer_ws;
                return Ok(());
            }
            let inner = if skip {
                Some(marks.to_vec())
            } else {
                self.read_styles(dom, id, marks)?
            };
            if let Some(inner) = inner {
                self.add_all(dom, id, &inner)?;
            }
            if sync {
                self.sync(top_uid);
            }
        } else if let Some((index, attrs)) = rule
            && let Some(inner) = self.read_styles(dom, id, marks)?
        {
            let consuming = self.parser.tags[index].consuming;
            self.add_element_by_rule(dom, id, index, attrs, &inner, (!consuming).then_some(index))?;
        }
        self.local_preserve_ws = outer_ws;
        Ok(())
    }

    /// `this.parser.normalizeLists`: true when no node rule matches `ul`/`ol`;
    /// the memry rule table has none.
    fn normalize_lists(&self) -> bool {
        true
    }

    fn leaf_fallback(&mut self, dom: &Dom, id: NodeId, marks: &[Mark]) -> Result<(), ParseError> {
        if dom.node_name(id) == "BR" && self.schema.node_ty(self.top().ty).inline_content {
            self.add_text(marks, "\n", false)?;
        }
        Ok(())
    }

    fn add_element_by_rule(
        &mut self,
        dom: &mut Dom,
        id: NodeId,
        index: usize,
        attrs: Option<Attrs>,
        marks: &[Mark],
        continue_after: Option<usize>,
    ) -> Result<(), ParseError> {
        let parser = self.parser;
        let rule = &parser.tags[index];
        let mut marks = marks.to_vec();
        let mut sync = false;
        let mut leaf = false;
        match rule.target {
            Target::Node(ty) => {
                if !self.schema.node_ty(ty).is_leaf {
                    if let Some(inner) =
                        self.enter(ty, attrs.clone(), &marks, rule.preserve_whitespace)?
                    {
                        sync = true;
                        marks = inner;
                    }
                } else {
                    leaf = true;
                    let node = self.schema.create(
                        ty,
                        &attrs_to_given(&attrs),
                        Fragment::default(),
                        Vec::new(),
                    )?;
                    if !self.insert_node(node, &marks, dom.node_name(id) == "BR")? {
                        self.leaf_fallback(dom, id, &marks)?;
                    }
                }
            }
            Target::Mark(ty) => {
                let mark = self.schema.create_mark(ty, &attrs_to_any(attrs.as_ref()))?;
                marks.push(mark);
            }
        }
        let start_in = self.top().uid;
        if leaf {
            // nothing to read inside a leaf
        } else if let Some(after) = continue_after {
            self.add_element(dom, id, &marks, Some(after))?;
        } else if let Some(get_content) = rule.get_content {
            let content = get_content(dom, parser, id)?;
            for node in content.nodes() {
                self.insert_node(node.clone(), &marks, false)?;
            }
        } else {
            let content_dom = match &rule.content_element {
                ContentElement::Itself => id,
                ContentElement::Selector(sel) => dom
                    .query_selector(id, sel)
                    .ok_or(ParseError::Js("contentElement matched nothing"))?,
                ContentElement::Func(f) => f(dom, id),
            };
            self.add_all(dom, content_dom, &marks)?;
        }
        if sync && self.sync(start_in) {
            self.open -= 1;
        }
        Ok(())
    }
}
