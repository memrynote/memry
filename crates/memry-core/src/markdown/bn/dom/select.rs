//! The CSS selector subset the parse rules and tree edits use: type, `*`,
//! `.class`, `[attr]`, `[attr=value]`, `:scope`, the descendant, child and
//! adjacent-sibling combinators, and selector lists.

use super::{Dom, NodeId};

#[derive(Debug, Clone, PartialEq)]
enum Simple {
    Tag(String),
    Any,
    Class(String),
    Attr(String, Option<String>),
    Scope,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Combinator {
    Descendant,
    Child,
    Adjacent,
}

/// `compound` is matched against the element; `link` says how the previous
/// compound relates to it.
#[derive(Debug, Clone)]
struct Compound {
    parts: Vec<Simple>,
    link: Option<Combinator>,
}

#[derive(Debug, Clone)]
pub struct Selector {
    alternatives: Vec<Vec<Compound>>,
}

impl Selector {
    /// Parses a selector the crate itself wrote; a malformed one is a defect in
    /// the caller, so this panics instead of returning an error.
    pub fn new(text: &str) -> Selector {
        Selector {
            alternatives: split_list(text).into_iter().map(parse_complex).collect(),
        }
    }

    /// `scope` is the element `:scope` stands for (the root of `querySelector`).
    pub(super) fn matches(&self, dom: &Dom, id: NodeId, scope: Option<NodeId>) -> bool {
        self.alternatives
            .iter()
            .any(|complex| match_complex(dom, id, complex, complex.len() - 1, scope))
    }
}

fn split_list(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let (mut quote, mut start) = (None::<char>, 0usize);
    for (i, c) in text.char_indices() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some(_), _) => {}
            (None, '"' | '\'') => quote = Some(c),
            (None, ',') => {
                out.push(text[start..i].trim());
                start = i + 1;
            }
            _ => {}
        }
    }
    out.push(text[start..].trim());
    out
}

fn parse_complex(text: &str) -> Vec<Compound> {
    let chars: Vec<char> = text.chars().collect();
    let mut compounds: Vec<Compound> = Vec::new();
    let mut i = 0;
    let mut pending: Option<Combinator> = None;
    while i < chars.len() {
        if chars[i].is_whitespace() {
            while i < chars.len() && chars[i].is_whitespace() {
                i += 1;
            }
            if pending.is_none() && !compounds.is_empty() {
                pending = Some(Combinator::Descendant);
            }
            continue;
        }
        if chars[i] == '>' || chars[i] == '+' {
            pending = Some(if chars[i] == '>' {
                Combinator::Child
            } else {
                Combinator::Adjacent
            });
            i += 1;
            continue;
        }
        let (parts, next) = parse_compound(&chars, i);
        compounds.push(Compound {
            parts,
            link: pending.take().filter(|_| !compounds.is_empty()),
        });
        i = next;
    }
    assert!(!compounds.is_empty(), "empty selector: {text:?}");
    compounds
}

fn is_ident(c: char) -> bool {
    c.is_alphanumeric() || c == '-' || c == '_'
}

fn parse_compound(chars: &[char], mut i: usize) -> (Vec<Simple>, usize) {
    let mut parts = Vec::new();
    let ident = |i: &mut usize| -> String {
        let start = *i;
        while *i < chars.len() && is_ident(chars[*i]) {
            *i += 1;
        }
        chars[start..*i].iter().collect()
    };
    while i < chars.len() && !chars[i].is_whitespace() && chars[i] != '>' && chars[i] != '+' {
        match chars[i] {
            '*' => {
                parts.push(Simple::Any);
                i += 1;
            }
            '.' => {
                i += 1;
                parts.push(Simple::Class(ident(&mut i)));
            }
            ':' => {
                i += 1;
                let name = ident(&mut i);
                assert_eq!(name, "scope", "unsupported pseudo-class :{name}");
                parts.push(Simple::Scope);
            }
            '[' => {
                i += 1;
                let name = ident(&mut i);
                if chars[i] == ']' {
                    parts.push(Simple::Attr(name, None));
                } else {
                    assert_eq!(chars[i], '=', "unsupported attribute operator");
                    i += 1;
                    let value: String = if chars[i] == '"' || chars[i] == '\'' {
                        let quote = chars[i];
                        i += 1;
                        let start = i;
                        while chars[i] != quote {
                            i += 1;
                        }
                        let v = chars[start..i].iter().collect();
                        i += 1;
                        v
                    } else {
                        let start = i;
                        while chars[i] != ']' {
                            i += 1;
                        }
                        chars[start..i].iter().collect()
                    };
                    parts.push(Simple::Attr(name, Some(value)));
                }
                assert_eq!(chars[i], ']');
                i += 1;
            }
            c if is_ident(c) => parts.push(Simple::Tag(ident(&mut i).to_ascii_lowercase())),
            c => panic!("unsupported selector character {c:?}"),
        }
    }
    (parts, i)
}

fn match_simple(dom: &Dom, id: NodeId, simple: &Simple, scope: Option<NodeId>) -> bool {
    let Some(el) = dom.element(id) else {
        return false;
    };
    match simple {
        Simple::Any => true,
        Simple::Tag(name) => el.name.eq_ignore_ascii_case(name),
        Simple::Class(class) => el
            .attrs
            .iter()
            .find(|(n, _)| n == "class")
            .is_some_and(|(_, v)| v.split_ascii_whitespace().any(|c| c == class)),
        Simple::Attr(name, None) => el.attrs.iter().any(|(n, _)| n == name),
        Simple::Attr(name, Some(value)) => el.attrs.iter().any(|(n, v)| n == name && v == value),
        Simple::Scope => scope == Some(id),
    }
}

fn match_complex(
    dom: &Dom,
    id: NodeId,
    complex: &[Compound],
    at: usize,
    scope: Option<NodeId>,
) -> bool {
    let compound = &complex[at];
    if !compound
        .parts
        .iter()
        .all(|p| match_simple(dom, id, p, scope))
    {
        return false;
    }
    let Some(link) = compound.link else {
        return true;
    };
    match link {
        Combinator::Child => dom
            .parent_element(id)
            .is_some_and(|p| match_complex(dom, p, complex, at - 1, scope)),
        Combinator::Adjacent => dom
            .previous_element_sibling(id)
            .is_some_and(|p| match_complex(dom, p, complex, at - 1, scope)),
        Combinator::Descendant => {
            let mut up = dom.parent_element(id);
            while let Some(p) = up {
                if match_complex(dom, p, complex, at - 1, scope) {
                    return true;
                }
                up = dom.parent_element(p);
            }
            false
        }
    }
}
