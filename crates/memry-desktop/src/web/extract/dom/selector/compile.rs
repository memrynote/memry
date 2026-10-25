//! Port of css-select 5.2.2 `compile.js`, `general.js`, `sort.js`, `pseudo-selectors/*`.
//!
//! css-select builds a closure per token. This port builds the same structure as data: a chain
//! of [`Step`]s evaluated from the last token (the subject) back to the first, which is what
//! nesting the closures does. `falseFunc` and `trueFunc` are kept as `None` and an empty chain
//! because css-select compares against them: a rule after one that can never match is not
//! compiled, so errors in it never surface.

use super::Scope;
use super::attrs::{AttrRule, compile_attribute};
use super::nth::{NthCheck, nth_check};
use super::parse::{PseudoData, Token, parse};
use crate::web::extract::dom::node::NodeId;
use crate::web::extract::dom::tree::Document;
use crate::web::extract::error::ExtractError;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum CtxEntry {
    Node(NodeId),
    /// css-select's `PLACEHOLDER_ELEMENT`, replaced by the `:has` subject at match time.
    Placeholder(usize),
    /// A document or fragment: not a tag, equal to no element.
    Opaque,
}

pub(super) type Ctx = Option<Vec<CtxEntry>>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum NthKind {
    Child,
    LastChild,
    OfType,
    LastOfType,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Simple {
    Empty,
    FirstChild,
    LastChild,
    FirstOfType,
    LastOfType,
    OnlyOfType,
    OnlyChild,
}

#[derive(Debug)]
pub(super) enum Step {
    Tag(String),
    Attr {
        name: String,
        rule: AttrRule,
    },
    Is(Box<CompiledSelector>),
    Not(Box<CompiledSelector>),
    Has {
        selector: Box<CompiledSelector>,
        slot: Option<usize>,
    },
    Scope(Ctx),
    Root,
    Contains(String),
    IContains(String),
    Nth {
        kind: NthKind,
        check: NthCheck,
    },
    /// `nth-*` formulas that always match still require a parent element.
    ParentIsTag,
    Simple(Simple),
    Descendant {
        cache: Option<usize>,
    },
    FlexibleDescendant,
    Parent,
    Child,
    Sibling,
    Adjacent,
}

/// The value css-select's compile returns: `trueFunc`, `falseFunc` or a function.
#[derive(Debug)]
pub(super) enum Compiled {
    True,
    False,
    Or(Vec<Vec<Step>>),
}

#[derive(Debug)]
pub(super) struct CompiledSelector {
    pub compiled: Compiled,
    pub should_test_next_siblings: bool,
}

struct CompileState<'d> {
    doc: &'d Document,
    next_slot: usize,
    next_cache: usize,
}

fn selector_error(message: impl Into<String>) -> ExtractError {
    ExtractError::Selector(message.into())
}

pub(super) fn compile(
    doc: &Document,
    selectors: &str,
    scope: Option<Scope>,
) -> Result<CompiledSelector, ExtractError> {
    let mut tokens = parse(selectors)?;
    let context = if selectors.contains(":scope") {
        scope.map(|s| match s {
            Scope::Element(id) => CtxEntry::Node(id),
            Scope::Opaque => CtxEntry::Opaque,
        })
    } else {
        None
    };
    let mut state = CompileState {
        doc,
        next_slot: 0,
        next_cache: 0,
    };
    compile_token(&mut state, &mut tokens, context, None, true)
}

/// css-select `isTraversal` of `sort.js`: anything that is not a universal, tag, attribute or
/// pseudo token, which includes a pseudo-element.
fn sort_is_traversal(token: &Token) -> bool {
    !matches!(
        token,
        Token::Universal { .. }
            | Token::Tag { .. }
            | Token::Attribute { .. }
            | Token::Pseudo { .. }
    )
}

fn procedure(token: &Token) -> i32 {
    match token {
        Token::Universal { .. } => 50,
        Token::Tag { .. } => 30,
        Token::Attribute {
            action,
            name,
            ignore_case,
            ..
        } => {
            use super::parse::{AttributeAction as A, IgnoreCase};
            let mut proc = match action {
                A::Exists => 10,
                A::Equals => 8,
                A::Not => 7,
                A::Start | A::End => 6,
                A::Any => 5,
                A::Element | A::Hyphen => 4,
            };
            if *action == A::Equals && name == "id" {
                proc = 9;
            }
            if matches!(ignore_case, IgnoreCase::Quirks | IgnoreCase::Yes) {
                proc >>= 1;
            }
            proc
        }
        Token::Pseudo { name, data } => match data {
            PseudoData::None => 3,
            PseudoData::Text(text) if text.is_empty() => 3,
            _ if name == "has" || name == "contains" => 0,
            PseudoData::Selectors(subs) => {
                let min = subs
                    .iter()
                    .map(|d| d.iter().map(procedure).min().unwrap_or(i32::MAX))
                    .min()
                    .unwrap_or(i32::MAX);
                if min < 0 { 0 } else { min }
            }
            PseudoData::Text(_) => 2,
        },
        _ => -1,
    }
}

/// css-select `sortByProcedure`: an insertion sort that keeps traversals in place.
fn sort_rules(rules: &mut [Token]) {
    let mut procs: Vec<i32> = rules.iter().map(procedure).collect();
    for i in 1..rules.len() {
        let proc_new = procs[i];
        if proc_new < 0 {
            continue;
        }
        let mut j = i;
        while j > 0 && proc_new < procs[j - 1] {
            rules.swap(j, j - 1);
            procs[j] = procs[j - 1];
            procs[j - 1] = proc_new;
            j -= 1;
        }
    }
}

fn includes_scope(token: &Token) -> bool {
    match token {
        Token::Pseudo { name, data } => {
            name == "scope"
                || matches!(data, PseudoData::Selectors(subs)
                    if subs.iter().any(|d| d.iter().any(includes_scope)))
        }
        _ => false,
    }
}

fn scope_token() -> Token {
    Token::Pseudo {
        name: "scope".into(),
        data: PseudoData::None,
    }
}

/// css-select `absolutize`: Selectors Level 4 section 3.4.1.
fn absolutize(state: &CompileState, tokens: &mut [Vec<Token>], context: &Ctx) {
    let has_context = context.as_ref().is_some_and(|entries| {
        entries.iter().all(|entry| match entry {
            CtxEntry::Placeholder(_) => true,
            CtxEntry::Opaque => false,
            CtxEntry::Node(id) => state.doc.parent_element(*id).is_some(),
        })
    });
    for t in tokens {
        let starts_with_other_traversal = t
            .first()
            .is_some_and(|first| sort_is_traversal(first) && *first != Token::Descendant);
        if starts_with_other_traversal {
            // Falls through to the scope prefix.
        } else if has_context && !t.iter().any(includes_scope) {
            t.insert(0, Token::Descendant);
        } else {
            continue;
        }
        t.insert(0, scope_token());
    }
}

fn compile_token(
    state: &mut CompileState,
    tokens: &mut [Vec<Token>],
    options_context: Option<CtxEntry>,
    context_param: Ctx,
    cache_results: bool,
) -> Result<CompiledSelector, ExtractError> {
    for rules in tokens.iter_mut() {
        sort_rules(rules);
    }
    let (context, is_array_context) = match options_context {
        Some(entry) => (Some(vec![entry]), false),
        None => match context_param {
            Some(entries) => (Some(entries), true),
            None => (None, false),
        },
    };
    absolutize(state, tokens, &context);

    let mut should_test_next_siblings = false;
    let mut branches: Vec<Option<Vec<Step>>> = Vec::new();
    for rules in tokens.iter_mut() {
        if rules.len() >= 2 && matches!(&rules[0], Token::Pseudo { name, .. } if name == "scope") {
            if is_array_context && rules[1] == Token::Descendant {
                rules[1] = Token::FlexibleDescendant;
            } else if matches!(rules[1], Token::Adjacent | Token::Sibling) {
                should_test_next_siblings = true;
            }
        }
        branches.push(compile_rules(state, rules, &context, cache_results)?);
    }

    // `reduceRules` starting from `falseFunc`: a `trueFunc` branch absorbs the rest.
    let mut compiled = Compiled::False;
    for branch in branches {
        let Some(chain) = branch else { continue };
        compiled = match compiled {
            Compiled::True => Compiled::True,
            Compiled::False if chain.is_empty() => Compiled::True,
            Compiled::False => Compiled::Or(vec![chain]),
            Compiled::Or(_) if chain.is_empty() => Compiled::True,
            Compiled::Or(mut chains) => {
                chains.push(chain);
                Compiled::Or(chains)
            }
        };
    }
    Ok(CompiledSelector {
        compiled,
        should_test_next_siblings,
    })
}

fn compile_rules(
    state: &mut CompileState,
    rules: &mut [Token],
    context: &Ctx,
    cache_results: bool,
) -> Result<Option<Vec<Step>>, ExtractError> {
    let mut chain = Some(Vec::new());
    for rule in rules.iter_mut() {
        chain = match chain {
            None => None,
            Some(previous) => compile_general(state, previous, rule, context, cache_results)?,
        };
    }
    Ok(chain)
}

fn compile_general(
    state: &mut CompileState,
    mut chain: Vec<Step>,
    rule: &mut Token,
    context: &Ctx,
    cache_results: bool,
) -> Result<Option<Vec<Step>>, ExtractError> {
    match rule {
        Token::PseudoElement => {
            return Err(selector_error(
                "Pseudo-elements are not supported by css-select",
            ));
        }
        Token::ColumnCombinator => {
            return Err(selector_error(
                "Column combinators are not yet supported by css-select",
            ));
        }
        Token::Attribute {
            name,
            action,
            value,
            namespace,
            ignore_case,
        } => {
            if namespace.is_some() {
                return Err(selector_error(
                    "Namespaced attributes are not yet supported by css-select",
                ));
            }
            *name = name.to_lowercase();
            match compile_attribute(*action, name, value, *ignore_case) {
                Some(rule) => chain.push(Step::Attr {
                    name: name.clone(),
                    rule,
                }),
                None => return Ok(None),
            }
        }
        Token::Pseudo { name, data } => {
            return compile_pseudo(state, chain, name, data, context);
        }
        Token::Tag { name, namespace } => {
            if namespace.is_some() {
                return Err(selector_error(
                    "Namespaced tag names are not yet supported by css-select",
                ));
            }
            chain.push(Step::Tag(name.to_lowercase()));
        }
        Token::Descendant => {
            let cache = cache_results.then(|| {
                state.next_cache += 1;
                state.next_cache - 1
            });
            chain.push(Step::Descendant { cache });
        }
        Token::FlexibleDescendant => chain.push(Step::FlexibleDescendant),
        Token::Parent => chain.push(Step::Parent),
        Token::Child => chain.push(Step::Child),
        Token::Sibling => chain.push(Step::Sibling),
        Token::Adjacent => chain.push(Step::Adjacent),
        Token::Universal { namespace } => {
            if namespace.as_deref().is_some_and(|n| n != "*") {
                return Err(selector_error(
                    "Namespaced universal selectors are not yet supported by css-select",
                ));
            }
        }
    }
    Ok(Some(chain))
}

/// The `aliases` of `pseudo-selectors/aliases.js`.
fn alias(name: &str) -> Option<&'static str> {
    Some(match name {
        "any-link" => ":is(a, area, link)[href]",
        "link" => ":any-link:not(:visited)",
        "disabled" => {
            ":is(
        :is(button, input, select, textarea, optgroup, option)[disabled],
        optgroup[disabled] > option,
        fieldset[disabled]:not(fieldset[disabled] legend:first-of-type *)
    )"
        }
        "enabled" => ":not(:disabled)",
        "checked" => ":is(:is(input[type=radio], input[type=checkbox])[checked], option:selected)",
        "required" => ":is(input, select, textarea)[required]",
        "optional" => ":is(input, select, textarea):not([required])",
        "selected" => {
            "option:is([selected], select:not([multiple]):not(:has(> option[selected])) > :first-of-type)"
        }
        "checkbox" => "[type=checkbox]",
        "file" => "[type=file]",
        "password" => "[type=password]",
        "radio" => "[type=radio]",
        "reset" => "[type=reset]",
        "image" => "[type=image]",
        "submit" => "[type=submit]",
        "parent" => ":not(:empty)",
        "header" => ":is(h1, h2, h3, h4, h5, h6)",
        "button" => ":is(button, input[type=button])",
        "input" => ":is(input, textarea, select, button)",
        "text" => "input:is(:not([type!='']), [type=text])",
        _ => return None,
    })
}

fn compile_pseudo(
    state: &mut CompileState,
    mut chain: Vec<Step>,
    name: &str,
    data: &mut PseudoData,
    context: &Ctx,
) -> Result<Option<Vec<Step>>, ExtractError> {
    if let PseudoData::Selectors(tokens) = data {
        return match name {
            "is" | "matches" | "where" => subselect_is(state, chain, tokens, context),
            "not" => {
                let func = compile_token(state, tokens, None, context.clone(), false)?;
                Ok(match func.compiled {
                    Compiled::False => Some(chain),
                    Compiled::True => None,
                    _ => {
                        chain.push(Step::Not(Box::new(func)));
                        Some(chain)
                    }
                })
            }
            "has" => compile_has(state, chain, tokens),
            _ => {
                // `${data}` of an array of token arrays: every token prints as an object.
                let count: usize = tokens.iter().map(Vec::len).sum();
                let shown = vec!["[object Object]"; count].join(",");
                Err(selector_error(format!(
                    "Unknown pseudo-class :{name}({shown})"
                )))
            }
        };
    }

    if let Some(alias_selector) = alias(name) {
        if *data != PseudoData::None {
            return Err(selector_error(format!(
                "Pseudo {name} doesn't have any arguments"
            )));
        }
        let mut tokens = parse(alias_selector)?;
        return subselect_is(state, chain, &mut tokens, context);
    }

    let arg = match data {
        PseudoData::Text(text) => Some(text.as_str()),
        _ => None,
    };
    match name {
        "contains" => chain.push(Step::Contains(arg.unwrap_or("null").to_string())),
        "icontains" => {
            let Some(text) = arg else {
                return Err(selector_error(
                    "Cannot read properties of null (reading 'toLowerCase')",
                ));
            };
            chain.push(Step::IContains(text.to_lowercase()));
        }
        "nth-child" | "nth-last-child" | "nth-of-type" | "nth-last-of-type" => {
            let Some(formula) = arg else {
                return Err(selector_error(
                    "Cannot read properties of null (reading 'trim')",
                ));
            };
            match nth_check(formula)? {
                NthCheck::False => return Ok(None),
                NthCheck::True => chain.push(Step::ParentIsTag),
                check => {
                    let kind = match name {
                        "nth-child" => NthKind::Child,
                        "nth-last-child" => NthKind::LastChild,
                        "nth-of-type" => NthKind::OfType,
                        _ => NthKind::LastOfType,
                    };
                    chain.push(Step::Nth { kind, check });
                }
            }
        }
        "root" => chain.push(Step::Root),
        "scope" => chain.push(Step::Scope(context.clone())),
        // The adapter has no `isHovered`, `isVisited` or `isActive`, so these never match.
        "hover" | "visited" | "active" => return Ok(None),
        "empty" | "first-child" | "last-child" | "first-of-type" | "last-of-type"
        | "only-of-type" | "only-child" => {
            if arg.is_some() {
                return Err(selector_error(format!(
                    "Pseudo-class :{name} doesn't have any arguments"
                )));
            }
            chain.push(Step::Simple(match name {
                "empty" => Simple::Empty,
                "first-child" => Simple::FirstChild,
                "last-child" => Simple::LastChild,
                "first-of-type" => Simple::FirstOfType,
                "last-of-type" => Simple::LastOfType,
                "only-of-type" => Simple::OnlyOfType,
                _ => Simple::OnlyChild,
            }));
        }
        _ => return Err(selector_error(format!("Unknown pseudo-class :{name}"))),
    }
    Ok(Some(chain))
}

/// `subselects.is`.
fn subselect_is(
    state: &mut CompileState,
    mut chain: Vec<Step>,
    tokens: &mut [Vec<Token>],
    context: &Ctx,
) -> Result<Option<Vec<Step>>, ExtractError> {
    let func = compile_token(state, tokens, None, context.clone(), false)?;
    Ok(match func.compiled {
        Compiled::True => Some(chain),
        Compiled::False => None,
        _ => {
            chain.push(Step::Is(Box::new(func)));
            Some(chain)
        }
    })
}

/// `subselects.has`.
fn compile_has(
    state: &mut CompileState,
    mut chain: Vec<Step>,
    tokens: &mut [Vec<Token>],
) -> Result<Option<Vec<Step>>, ExtractError> {
    let relative = tokens.iter().any(|s| s.iter().any(sort_is_traversal));
    let slot = relative.then(|| {
        state.next_slot += 1;
        state.next_slot - 1
    });
    let context = slot.map(|s| vec![CtxEntry::Placeholder(s)]);
    let compiled = compile_token(state, tokens, None, context, false)?;
    if matches!(compiled.compiled, Compiled::False) {
        return Ok(None);
    }
    // With `trueFunc` the placeholder is never read, so the plain branch applies.
    let slot = if matches!(compiled.compiled, Compiled::True) {
        None
    } else {
        slot
    };
    chain.push(Step::Has {
        selector: Box::new(compiled),
        slot,
    });
    Ok(Some(chain))
}
