//! A port of turndown 7.2.4 (`lib/turndown.cjs.js`) configured as `createMarkdownContent`
//! configures it (`dist/markdown.js:63-71`): ATX headings, `---` rules, `-` bullets, fenced code
//! blocks, `*` emphasis, `preformattedCode`, inlined links, and Defuddle's rules ahead of
//! turndown's defaults.
//!
//! The option values are constants here because nothing else sets them. Turndown's own rules for
//! lists, list items, images, links, code blocks and reference links are not ported: Defuddle's
//! `list`, `listItem`, `image`, `link` and `preformattedCode` rules match everything they would,
//! and `linkStyle` is always `inlined`.

mod collapse;
mod defaults;
mod escape;
mod node;
pub mod parse;
pub mod serialize;

use crate::web::extract::dom::NodeId;
use crate::web::extract::dom::node::node_type;
use crate::web::extract::error::ExtractError;
pub use node::NodeInfo;
use parse::Dom;

/// How a rule recognizes a node (`filterValue`).
pub enum Filter {
    /// `filter` is a tag name or a list of them: compared with `nodeName.toLowerCase()`.
    Tags(&'static [&'static str]),
    Predicate(fn(&Dom, NodeId) -> bool),
}

pub type Replacement = fn(&mut Dom, NodeId, &str, &NodeInfo) -> String;

pub struct Rule {
    pub filter: Filter,
    pub replacement: Replacement,
}

impl Rule {
    fn matches(&self, dom: &Dom, node: NodeId) -> bool {
        match &self.filter {
            Filter::Tags(tags) => tags.contains(&dom.lower_name(node).as_str()),
            Filter::Predicate(test) => test(dom, node),
        }
    }
}

/// The nodes `keep` leaves as HTML.
const KEEP: &[&str] = &["iframe", "video", "audio", "sup", "sub", "svg", "math"];
/// The nodes `remove` drops with their content.
const REMOVE: &[&str] = &["style", "script"];

/// `rules.forNode(node)`.
fn replacement_for(dom: &Dom, node: NodeId, info: &NodeInfo) -> Replacement {
    if info.is_blank {
        return defaults::blank;
    }
    let ordered = crate::web::extract::markdown::rules::RULES
        .iter()
        .chain(defaults::RULES.iter());
    for rule in ordered {
        if rule.matches(dom, node) {
            return rule.replacement;
        }
    }
    let name = dom.lower_name(node);
    if KEEP.contains(&name.as_str()) {
        return defaults::keep;
    }
    if REMOVE.contains(&name.as_str()) {
        return defaults::remove;
    }
    defaults::fallback
}

/// `trimTrailingNewlines` and `trimLeadingNewlines` as counts of removed newlines.
fn trailing_newlines(s: &str) -> usize {
    s.len() - s.trim_end_matches('\n').len()
}

fn leading_newlines(s: &str) -> usize {
    s.len() - s.trim_start_matches('\n').len()
}

/// `output = join(output, replacement)`: at most two newlines between the pieces, the larger of
/// what `output` ends with and `replacement` starts with. Appends in place, so reducing a long
/// run of siblings stays linear.
fn join(output: &mut String, replacement: &str) {
    let newlines = trailing_newlines(output)
        .max(leading_newlines(replacement))
        .min(2);
    output.truncate(output.trim_end_matches('\n').len());
    output.push_str(&"\n\n"[..newlines]);
    output.push_str(replacement.trim_start_matches('\n'));
}

/// `process(parentNode)`: reduces the child nodes to markdown.
fn process(dom: &mut Dom, parent: NodeId, root: NodeId) -> Result<String, ExtractError> {
    let mut output = String::new();
    for child in dom.doc.child_nodes(parent) {
        let replacement = match dom.doc.node_type(child) {
            node_type::TEXT => {
                let value = dom.doc.node_value(child).unwrap_or_default().to_string();
                if dom.is_code(child, root) {
                    value
                } else {
                    escape::escape(&value)
                }
            }
            node_type::ELEMENT => replacement_for_node(dom, child, root)?,
            _ => String::new(),
        };
        join(&mut output, &replacement);
    }
    Ok(output)
}

/// `replacementForNode(node)`.
fn replacement_for_node(dom: &mut Dom, node: NodeId, root: NodeId) -> Result<String, ExtractError> {
    let info = dom.node_info(node, root);
    let replace = replacement_for(dom, node, &info);
    let mut content = process(dom, node, root)?;
    if !info.leading.is_empty() || !info.trailing.is_empty() {
        content = crate::web::extract::utils::js::trim(&content).to_string();
    }
    let replacement = replace(dom, node, &content, &info);
    if let Some(failure) = dom.failure.take() {
        return Err(failure);
    }
    Ok(format!("{}{replacement}{}", info.leading, info.trailing))
}

/// `turndown(input)` for a string input. Fails where the JS throws: the wrapper element is
/// missing when the input holds a `frameset`, which replaces the body.
pub fn turndown(input: &str) -> Result<String, ExtractError> {
    if input.is_empty() {
        return Ok(String::new());
    }
    let mut dom = parse::parse(&format!(
        "<x-turndown id=\"turndown-root\">{input}</x-turndown>"
    ));
    let root = dom
        .doc
        .get_element_by_id(dom.doc.root(), "turndown-root")
        .ok_or_else(|| {
            ExtractError::Dom("Cannot read properties of null (reading 'firstChild')".into())
        })?;
    collapse::collapse_whitespace(&mut dom, root);
    let output = process(&mut dom, root, root)?;
    Ok(post_process(&output))
}

impl Dom {
    /// `turndownService.turndown(html)` from inside a rule. An error is kept on the document and
    /// raised by the node whose rule made the call.
    pub fn turndown(&mut self, html: &str) -> String {
        match turndown(html) {
            Ok(markdown) => markdown,
            Err(failure) => {
                self.failure = Some(failure);
                String::new()
            }
        }
    }
}

/// `postProcess(output)`: no rule here has an `append`, so only the trimming remains.
fn post_process(output: &str) -> String {
    let start = output.trim_start_matches(['\t', '\r', '\n']);
    start
        .trim_end_matches(crate::web::extract::utils::js::is_js_whitespace)
        .to_string()
}
