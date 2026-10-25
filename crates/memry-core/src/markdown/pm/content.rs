//! Content expressions (`NodeSpec.content`) compiled to a DFA, a port of
//! `prosemirror-model/src/content.ts`. Edge order is significant: it decides
//! which node `fillBefore` generates and which wrapping `findWrapping` returns.

use std::collections::{HashMap, VecDeque};

use super::model::Node;
use super::schema::{NodeTypeId, Schema};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StateId(pub u32);

/// One DFA state. `StateId(0)` is `ContentMatch.empty`, the state of a leaf.
pub struct MatchState {
    pub next: Vec<(NodeTypeId, StateId)>,
    pub valid_end: bool,
}

/// What the expression compiler needs to know about each node type.
pub struct TypeInfo {
    pub name: &'static str,
    pub groups: Vec<&'static str>,
    pub is_inline: bool,
    pub is_text: bool,
    pub has_required_attrs: bool,
}

/// A position in a content expression: `prosemirror-model`'s `ContentMatch`.
#[derive(Clone, Copy)]
pub struct ContentMatch<'a> {
    schema: &'a Schema,
    id: StateId,
}

impl<'a> ContentMatch<'a> {
    pub(super) fn new(schema: &'a Schema, id: StateId) -> Self {
        ContentMatch { schema, id }
    }

    fn state(&self) -> &'a MatchState {
        &self.schema.states[self.id.0 as usize]
    }

    pub fn id(&self) -> StateId {
        self.id
    }

    pub fn valid_end(&self) -> bool {
        self.state().valid_end
    }

    /// The outgoing edges in declaration order.
    pub fn edges(&self) -> &'a [(NodeTypeId, StateId)] {
        &self.state().next
    }

    pub fn match_type(&self, ty: NodeTypeId) -> Option<ContentMatch<'a>> {
        self.edges()
            .iter()
            .find(|(edge, _)| *edge == ty)
            .map(|(_, next)| ContentMatch::new(self.schema, *next))
    }

    pub fn match_fragment(&self, nodes: &[Node], start: usize) -> Option<ContentMatch<'a>> {
        let mut current = *self;
        for node in nodes.get(start..).unwrap_or(&[]) {
            current = current.match_type(node.ty)?;
        }
        Some(current)
    }

    /// The first edge's type is inline: this position holds inline content.
    pub fn inline_content(&self) -> bool {
        self.edges()
            .first()
            .is_some_and(|(ty, _)| self.schema.node_ty(*ty).is_inline)
    }

    /// The first matching type at this position that can be generated.
    pub fn default_type(&self) -> Option<NodeTypeId> {
        self.edges().iter().map(|(ty, _)| *ty).find(|ty| {
            let node_ty = self.schema.node_ty(*ty);
            !(node_ty.is_text || node_ty.has_required_attrs)
        })
    }

    /// Match `after` from `start_index`; when that fails, find nodes that can
    /// be inserted in front of it. `to_end` demands a valid end.
    pub fn fill_before(
        &self,
        after: &[Node],
        to_end: bool,
        start_index: usize,
    ) -> Option<Vec<Node>> {
        let mut seen = vec![self.id];
        self.fill_search(*self, &[], after, to_end, start_index, &mut seen)
    }

    fn fill_search(
        &self,
        at: ContentMatch<'a>,
        types: &[NodeTypeId],
        after: &[Node],
        to_end: bool,
        start_index: usize,
        seen: &mut Vec<StateId>,
    ) -> Option<Vec<Node>> {
        if let Some(finished) = at.match_fragment(after, start_index)
            && (!to_end || finished.valid_end())
        {
            return types
                .iter()
                .map(|ty| self.schema.create_and_fill(*ty))
                .collect();
        }
        for (ty, next) in at.edges() {
            let node_ty = self.schema.node_ty(*ty);
            if !(node_ty.is_text || node_ty.has_required_attrs) && !seen.contains(next) {
                seen.push(*next);
                let mut extended = types.to_vec();
                extended.push(*ty);
                let at_next = ContentMatch::new(self.schema, *next);
                if let Some(found) =
                    self.fill_search(at_next, &extended, after, to_end, start_index, seen)
                {
                    return Some(found);
                }
            }
        }
        None
    }

    /// Wrapping node types that let a node of type `target` appear here; empty
    /// when it fits directly, `None` when no wrapping exists.
    pub fn find_wrapping(&self, target: NodeTypeId) -> Option<Vec<NodeTypeId>> {
        struct Active<'s> {
            at: ContentMatch<'s>,
            ty: Option<NodeTypeId>,
            via: Option<usize>,
        }
        let mut arena = vec![Active {
            at: *self,
            ty: None,
            via: None,
        }];
        let mut queue = VecDeque::from([0usize]);
        let mut seen: Vec<NodeTypeId> = Vec::new();
        while let Some(index) = queue.pop_front() {
            let at = arena[index].at;
            if at.match_type(target).is_some() {
                let mut result = Vec::new();
                let mut cursor = Some(index);
                while let Some(i) = cursor {
                    let Some(ty) = arena[i].ty else { break };
                    result.push(ty);
                    cursor = arena[i].via;
                }
                result.reverse();
                return Some(result);
            }
            let current_is_root = arena[index].ty.is_none();
            for (ty, next) in at.edges() {
                let node_ty = self.schema.node_ty(*ty);
                let next_valid = self.schema.states[next.0 as usize].valid_end;
                if !node_ty.is_leaf
                    && !node_ty.has_required_attrs
                    && !seen.contains(ty)
                    && (current_is_root || next_valid)
                {
                    arena.push(Active {
                        at: ContentMatch::new(self.schema, node_ty.content_match),
                        ty: Some(*ty),
                        via: Some(index),
                    });
                    queue.push_back(arena.len() - 1);
                    seen.push(*ty);
                }
            }
        }
        None
    }
}

// ---- expression compiler ---------------------------------------------------

enum Expr {
    Choice(Vec<Expr>),
    Seq(Vec<Expr>),
    Plus(Box<Expr>),
    Star(Box<Expr>),
    Opt(Box<Expr>),
    Range(u32, Option<u32>, Box<Expr>),
    Name(NodeTypeId),
}

struct Tokens<'a> {
    source: &'a str,
    tokens: Vec<String>,
    pos: usize,
    infos: &'a [TypeInfo],
    inline: Option<bool>,
}

impl<'a> Tokens<'a> {
    fn new(source: &'a str, infos: &'a [TypeInfo]) -> Tokens<'a> {
        let mut tokens = Vec::new();
        let mut chars = source.chars().peekable();
        while let Some(c) = chars.next() {
            if c.is_whitespace() {
                continue;
            }
            if is_word(c) {
                let mut word = String::from(c);
                while let Some(next) = chars.peek().copied().filter(|n| is_word(*n)) {
                    word.push(next);
                    chars.next();
                }
                tokens.push(word);
            } else {
                tokens.push(c.to_string());
            }
        }
        Tokens {
            source,
            tokens,
            pos: 0,
            infos,
            inline: None,
        }
    }

    fn next(&self) -> Option<&str> {
        self.tokens.get(self.pos).map(String::as_str)
    }

    fn eat(&mut self, token: &str) -> bool {
        if self.next() == Some(token) {
            self.pos += 1;
            true
        } else {
            false
        }
    }

    fn err<T>(&self, message: &str) -> Result<T, String> {
        Err(format!(
            "{message} (in content expression '{}')",
            self.source
        ))
    }
}

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

fn parse_expr(stream: &mut Tokens) -> Result<Expr, String> {
    let mut exprs = vec![parse_seq(stream)?];
    while stream.eat("|") {
        exprs.push(parse_seq(stream)?);
    }
    Ok(if exprs.len() == 1 {
        exprs.remove(0)
    } else {
        Expr::Choice(exprs)
    })
}

fn parse_seq(stream: &mut Tokens) -> Result<Expr, String> {
    let mut exprs = vec![parse_subscript(stream)?];
    while stream.next().is_some_and(|t| t != ")" && t != "|") {
        exprs.push(parse_subscript(stream)?);
    }
    Ok(if exprs.len() == 1 {
        exprs.remove(0)
    } else {
        Expr::Seq(exprs)
    })
}

fn parse_subscript(stream: &mut Tokens) -> Result<Expr, String> {
    let mut expr = parse_atom(stream)?;
    loop {
        if stream.eat("+") {
            expr = Expr::Plus(Box::new(expr));
        } else if stream.eat("*") {
            expr = Expr::Star(Box::new(expr));
        } else if stream.eat("?") {
            expr = Expr::Opt(Box::new(expr));
        } else if stream.eat("{") {
            expr = parse_range(stream, expr)?;
        } else {
            return Ok(expr);
        }
    }
}

fn parse_num(stream: &mut Tokens) -> Result<u32, String> {
    let value = stream
        .next()
        .filter(|t| !t.is_empty() && t.chars().all(|c| c.is_ascii_digit()))
        .and_then(|t| t.parse::<u32>().ok());
    match value {
        Some(value) => {
            stream.pos += 1;
            Ok(value)
        }
        None => stream.err(&format!(
            "Expected number, got '{}'",
            stream.next().unwrap_or("")
        )),
    }
}

fn parse_range(stream: &mut Tokens, expr: Expr) -> Result<Expr, String> {
    let min = parse_num(stream)?;
    let mut max = Some(min);
    if stream.eat(",") {
        max = if stream.next() != Some("}") {
            Some(parse_num(stream)?)
        } else {
            None
        };
    }
    if !stream.eat("}") {
        return stream.err("Unclosed braced range");
    }
    Ok(Expr::Range(min, max, Box::new(expr)))
}

fn parse_atom(stream: &mut Tokens) -> Result<Expr, String> {
    if stream.eat("(") {
        let expr = parse_expr(stream)?;
        if !stream.eat(")") {
            return stream.err("Missing closing paren");
        }
        return Ok(expr);
    }
    let Some(token) = stream.next().map(str::to_owned) else {
        return stream.err("Unexpected end");
    };
    if !token.chars().all(is_word) {
        return stream.err(&format!("Unexpected token '{token}'"));
    }
    let infos = stream.infos;
    let mut types: Vec<NodeTypeId> = infos
        .iter()
        .position(|i| i.name == token)
        .map(|i| vec![NodeTypeId(i as u16)])
        .unwrap_or_default();
    if types.is_empty() {
        types = infos
            .iter()
            .enumerate()
            .filter(|(_, i)| i.groups.contains(&token.as_str()))
            .map(|(i, _)| NodeTypeId(i as u16))
            .collect();
    }
    if types.is_empty() {
        return stream.err(&format!("No node type or group '{token}' found"));
    }
    let mut exprs = Vec::new();
    for ty in types {
        let inline = infos[ty.0 as usize].is_inline;
        match stream.inline {
            None => stream.inline = Some(inline),
            Some(expected) if expected != inline => {
                return stream.err("Mixing inline and block content");
            }
            Some(_) => {}
        }
        exprs.push(Expr::Name(ty));
    }
    stream.pos += 1;
    Ok(if exprs.len() == 1 {
        exprs.remove(0)
    } else {
        Expr::Choice(exprs)
    })
}

struct Edge {
    term: Option<NodeTypeId>,
    to: Option<usize>,
}

type Handle = (usize, usize);

struct Nfa {
    states: Vec<Vec<Edge>>,
}

impl Nfa {
    fn node(&mut self) -> usize {
        self.states.push(Vec::new());
        self.states.len() - 1
    }

    fn edge(&mut self, from: usize, to: Option<usize>, term: Option<NodeTypeId>) -> Handle {
        self.states[from].push(Edge { term, to });
        (from, self.states[from].len() - 1)
    }

    fn connect(&mut self, handles: Vec<Handle>, to: usize) {
        for (state, index) in handles {
            self.states[state][index].to = Some(to);
        }
    }

    fn compile(&mut self, expr: &Expr, from: usize) -> Vec<Handle> {
        match expr {
            Expr::Choice(exprs) => exprs.iter().flat_map(|e| self.compile(e, from)).collect(),
            Expr::Seq(exprs) => {
                let mut from = from;
                for (i, e) in exprs.iter().enumerate() {
                    let next = self.compile(e, from);
                    if i == exprs.len() - 1 {
                        return next;
                    }
                    from = self.node();
                    self.connect(next, from);
                }
                Vec::new()
            }
            Expr::Star(inner) => {
                let loop_ = self.node();
                self.edge(from, Some(loop_), None);
                let body = self.compile(inner, loop_);
                self.connect(body, loop_);
                vec![self.edge(loop_, None, None)]
            }
            Expr::Plus(inner) => {
                let loop_ = self.node();
                let first = self.compile(inner, from);
                self.connect(first, loop_);
                let again = self.compile(inner, loop_);
                self.connect(again, loop_);
                vec![self.edge(loop_, None, None)]
            }
            Expr::Opt(inner) => {
                let mut out = vec![self.edge(from, None, None)];
                out.extend(self.compile(inner, from));
                out
            }
            Expr::Range(min, max, inner) => {
                let mut cur = from;
                for _ in 0..*min {
                    let next = self.node();
                    let body = self.compile(inner, cur);
                    self.connect(body, next);
                    cur = next;
                }
                match max {
                    None => {
                        let body = self.compile(inner, cur);
                        self.connect(body, cur);
                    }
                    Some(max) => {
                        for _ in *min..*max {
                            let next = self.node();
                            self.edge(cur, Some(next), None);
                            let body = self.compile(inner, cur);
                            self.connect(body, next);
                            cur = next;
                        }
                    }
                }
                vec![self.edge(cur, None, None)]
            }
            Expr::Name(ty) => vec![self.edge(from, None, Some(*ty))],
        }
    }

    /// Nodes reachable by null edges from `node`, sorted descending. A node
    /// with a single null out-edge is skipped.
    fn null_from(&self, node: usize) -> Vec<usize> {
        fn scan(nfa: &Nfa, node: usize, result: &mut Vec<usize>) {
            let edges = &nfa.states[node];
            if edges.len() == 1 && edges[0].term.is_none() {
                return scan(nfa, edges[0].to.unwrap_or(0), result);
            }
            result.push(node);
            for edge in edges {
                if edge.term.is_none() {
                    let to = edge.to.unwrap_or(0);
                    if !result.contains(&to) {
                        scan(nfa, to, result);
                    }
                }
            }
        }
        let mut result = Vec::new();
        scan(self, node, &mut result);
        result.sort_by(|a, b| b.cmp(a));
        result
    }

    fn explore(
        &self,
        set: &[usize],
        labeled: &mut HashMap<Vec<usize>, StateId>,
        states: &mut Vec<MatchState>,
    ) -> StateId {
        let mut out: Vec<(NodeTypeId, Vec<usize>)> = Vec::new();
        for node in set {
            for edge in &self.states[*node] {
                let Some(term) = edge.term else { continue };
                let slot = match out.iter().position(|(t, _)| *t == term) {
                    Some(slot) => slot,
                    None => {
                        out.push((term, Vec::new()));
                        out.len() - 1
                    }
                };
                for reached in self.null_from(edge.to.unwrap_or(0)) {
                    if !out[slot].1.contains(&reached) {
                        out[slot].1.push(reached);
                    }
                }
            }
        }
        let id = StateId(states.len() as u32);
        states.push(MatchState {
            next: Vec::new(),
            valid_end: set.contains(&(self.states.len() - 1)),
        });
        labeled.insert(set.to_vec(), id);
        for (term, mut targets) in out {
            targets.sort_by(|a, b| b.cmp(a));
            let next = match labeled.get(&targets) {
                Some(next) => *next,
                None => self.explore(&targets, labeled, states),
            };
            states[id.0 as usize].next.push((term, next));
        }
        id
    }
}

/// Compile `source` into DFA states appended to `states`; the empty
/// expression is `StateId(0)`.
pub fn compile(
    source: &str,
    infos: &[TypeInfo],
    states: &mut Vec<MatchState>,
) -> Result<StateId, String> {
    let mut stream = Tokens::new(source, infos);
    if stream.next().is_none() {
        return Ok(StateId(0));
    }
    let expr = parse_expr(&mut stream)?;
    if stream.next().is_some() {
        return stream.err("Unexpected trailing text");
    }
    let mut nfa = Nfa {
        states: vec![Vec::new()],
    };
    let body = nfa.compile(&expr, 0);
    let end = nfa.node();
    nfa.connect(body, end);
    let first = nfa.explore(&nfa.null_from(0), &mut HashMap::new(), states);
    check_for_dead_ends(first, infos, states, &stream)?;
    Ok(first)
}

fn check_for_dead_ends(
    first: StateId,
    infos: &[TypeInfo],
    states: &[MatchState],
    stream: &Tokens,
) -> Result<(), String> {
    let mut work = vec![first];
    let mut index = 0;
    while index < work.len() {
        let state = &states[work[index].0 as usize];
        index += 1;
        let mut dead = !state.valid_end;
        let mut names = Vec::new();
        for (ty, next) in &state.next {
            let info = &infos[ty.0 as usize];
            names.push(info.name);
            if dead && !(info.is_text || info.has_required_attrs) {
                dead = false;
            }
            if !work.contains(next) {
                work.push(*next);
            }
        }
        if dead {
            return stream.err(&format!(
                "Only non-generatable nodes ({}) in a required position",
                names.join(", ")
            ));
        }
    }
    Ok(())
}
