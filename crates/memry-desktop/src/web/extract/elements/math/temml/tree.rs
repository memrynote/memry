//! `mathMLTree.js`, `tree.js` and `domTree.js`: the output tree and its markup.

use super::val::{R, jserr};

/// `utils.escape`.
pub fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '>' => out.push_str("&gt;"),
            '<' => out.push_str("&lt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#x27;"),
            _ => out.push(c),
        }
    }
    out
}

/// `utils.hyphenate`.
pub fn hyphenate(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        if c.is_ascii_uppercase() {
            out.push('-');
        }
        out.push(c);
    }
    out.to_lowercase()
}

pub type Pairs = Vec<(String, String)>;

fn set_pair(pairs: &mut Pairs, key: &str, value: String) {
    match pairs.iter_mut().find(|(k, _)| k == key) {
        Some(p) => p.1 = value,
        None => pairs.push((key.to_string(), value)),
    }
}

#[derive(Clone, Debug)]
pub struct MathNode {
    pub ty: String,
    pub attributes: Pairs,
    pub children: Vec<Tree>,
    pub classes: Vec<String>,
    pub style: Pairs,
    pub label: String,
}

#[derive(Clone, Debug)]
pub struct Fragment {
    pub children: Vec<Tree>,
    pub classes: Vec<String>,
    pub style: Pairs,
}

#[derive(Clone, Debug)]
pub struct Anchor {
    pub href: String,
    pub classes: Vec<String>,
    pub children: Vec<Tree>,
}

#[derive(Clone, Debug)]
pub struct Span {
    pub classes: Vec<String>,
    pub children: Vec<Tree>,
    pub style: Pairs,
}

#[derive(Clone, Debug)]
pub enum Tree {
    Math(MathNode),
    Text(String),
    Frag(Fragment),
    Anchor(Anchor),
    Span(Span),
}

impl MathNode {
    pub fn new(ty: &str, children: Vec<Tree>) -> MathNode {
        MathNode {
            ty: ty.to_string(),
            attributes: Vec::new(),
            children,
            classes: Vec::new(),
            style: Vec::new(),
            label: String::new(),
        }
    }

    pub fn with_classes(ty: &str, children: Vec<Tree>, classes: &[&str]) -> MathNode {
        let mut n = MathNode::new(ty, children);
        n.classes = classes.iter().map(|c| c.to_string()).collect();
        n
    }

    pub fn set_attribute(&mut self, name: &str, value: impl Into<String>) {
        set_pair(&mut self.attributes, name, value.into());
    }

    pub fn get_attribute(&self, name: &str) -> Option<&str> {
        self.attributes
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }

    pub fn set_style(&mut self, name: &str, value: impl Into<String>) {
        set_pair(&mut self.style, name, value.into());
    }

    pub fn into_tree(self) -> Tree {
        Tree::Math(self)
    }

    fn markup(&self) -> String {
        let mut out = format!("<{}", self.ty);
        for (k, v) in &self.attributes {
            out.push_str(&format!(" {k}=\"{}\"", escape(v)));
        }
        let class = create_class(&self.classes);
        if !self.classes.is_empty() {
            out.push_str(&format!(" class=\"{}\"", escape(&class)));
        }
        let styles = styles_markup(&self.style);
        if !styles.is_empty() {
            out.push_str(&format!(" style=\"{styles}\""));
        }
        out.push('>');
        for c in &self.children {
            out.push_str(&c.to_markup());
        }
        out.push_str(&format!("</{}>", self.ty));
        out
    }
}

fn styles_markup(style: &Pairs) -> String {
    style
        .iter()
        .map(|(k, v)| format!("{}:{v};", hyphenate(k)))
        .collect()
}

/// `createClass`: the non-empty classes joined by a space.
pub fn create_class(classes: &[String]) -> String {
    classes
        .iter()
        .filter(|c| !c.is_empty())
        .cloned()
        .collect::<Vec<_>>()
        .join(" ")
}

impl Tree {
    pub fn text(s: impl Into<String>) -> Tree {
        Tree::Text(s.into())
    }

    pub fn frag(children: Vec<Tree>) -> Tree {
        Tree::Frag(Fragment {
            children,
            classes: Vec::new(),
            style: Vec::new(),
        })
    }

    pub fn to_markup(&self) -> String {
        match self {
            Tree::Math(m) => m.markup(),
            Tree::Text(t) => escape(t),
            Tree::Frag(f) => f.children.iter().map(Tree::to_markup).collect(),
            Tree::Anchor(a) => {
                let mut out = format!("<a href='{}'", escape(&a.href));
                if !a.classes.is_empty() {
                    out.push_str(&format!(" class=\"{}\"", escape(&create_class(&a.classes))));
                }
                out.push('>');
                for c in &a.children {
                    out.push_str(&c.to_markup());
                }
                out.push_str("</a>");
                out
            }
            Tree::Span(s) => {
                let mut out = "<span".to_string();
                if !s.classes.is_empty() {
                    out.push_str(&format!(" class=\"{}\"", escape(&create_class(&s.classes))));
                }
                let styles = styles_markup(&s.style);
                if !styles.is_empty() {
                    out.push_str(&format!(" style=\"{styles}\""));
                }
                out.push('>');
                for c in &s.children {
                    out.push_str(&c.to_markup());
                }
                out.push_str("</span>");
                out
            }
        }
    }

    /// `node.type` (`undefined` for everything but a MathNode).
    pub fn ty(&self) -> &str {
        match self {
            Tree::Math(m) => &m.ty,
            _ => "",
        }
    }

    pub fn is_ty(&self, ty: &str) -> bool {
        matches!(self, Tree::Math(m) if m.ty == ty)
    }

    pub fn as_math(&self) -> Option<&MathNode> {
        match self {
            Tree::Math(m) => Some(m),
            _ => None,
        }
    }

    pub fn as_math_mut(&mut self) -> Option<&mut MathNode> {
        match self {
            Tree::Math(m) => Some(m),
            _ => None,
        }
    }

    pub fn children_mut(&mut self) -> Option<&mut Vec<Tree>> {
        match self {
            Tree::Math(m) => Some(&mut m.children),
            Tree::Frag(f) => Some(&mut f.children),
            Tree::Anchor(a) => Some(&mut a.children),
            Tree::Span(s) => Some(&mut s.children),
            Tree::Text(_) => None,
        }
    }

    pub fn classes_mut(&mut self) -> R<&mut Vec<String>> {
        match self {
            Tree::Math(m) => Ok(&mut m.classes),
            Tree::Frag(f) => Ok(&mut f.classes),
            Tree::Anchor(a) => Ok(&mut a.classes),
            Tree::Span(s) => Ok(&mut s.classes),
            Tree::Text(_) => jserr("Cannot read properties of undefined (reading 'push')"),
        }
    }

    /// `node.style[key] = value`.
    pub fn set_style(&mut self, key: &str, value: impl Into<String>) -> R<()> {
        match self {
            Tree::Math(m) => m.set_style(key, value),
            Tree::Frag(f) => set_pair(&mut f.style, key, value.into()),
            Tree::Span(s) => set_pair(&mut s.style, key, value.into()),
            _ => return jserr("Cannot set properties of undefined"),
        }
        Ok(())
    }
}

/// `${undefined}` / `${string}` for a style value that may be unset.
pub fn style_value(color: &Option<String>) -> String {
    color.clone().unwrap_or_else(|| "undefined".to_string())
}

/// `wrapWithMstyle(expression)`.
pub fn wrap_with_mstyle(mut expression: Vec<Tree>) -> Tree {
    if expression.len() == 1 && expression[0].is_ty("mrow") {
        let mut node = expression.pop().expect("one");
        if let Tree::Math(m) = &mut node {
            m.ty = "mstyle".to_string();
        }
        node
    } else {
        Tree::Math(MathNode::new("mstyle", expression))
    }
}

impl Tree {
    /// `node.toText()`.
    pub fn to_text(&self) -> String {
        match self {
            Tree::Text(t) => t.clone(),
            Tree::Math(m) => m.children.iter().map(Tree::to_text).collect(),
            Tree::Frag(f) => f.children.iter().map(Tree::to_text).collect(),
            Tree::Anchor(a) => a.children.iter().map(Tree::to_text).collect(),
            Tree::Span(s) => s.children.iter().map(Tree::to_text).collect(),
        }
    }
}
