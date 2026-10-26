//! `functions/def.js`: `\def`, `\let`, `\newcommand` and their prefixes.

use std::rc::Rc;

use super::{Ctx, Props, Registry, assert_node_type};
use crate::node;
use crate::web::extract::elements::math::temml::macro_expander::{Expansion, MacroDef};
use crate::web::extract::elements::math::temml::parser::Parser;
use crate::web::extract::elements::math::temml::val::{R, Tok, V, jserr, perr, perr_at};
use crate::web::extract::utils::js::parse_int;

fn global_map(name: &str) -> Option<&'static str> {
    Some(match name {
        "\\global" => "\\global",
        "\\long" | "\\\\globallong" => "\\\\globallong",
        "\\def" | "\\gdef" => "\\gdef",
        "\\edef" | "\\xdef" => "\\xdef",
        "\\let" => "\\\\globallet",
        "\\futurelet" => "\\\\globalfuture",
        _ => return None,
    })
}

/// `/^(?:[\\{}$&#^_]|EOF)$/.test(name)`.
fn is_not_control_sequence(name: &str) -> bool {
    matches!(name, "\\" | "{" | "}" | "$" | "&" | "#" | "^" | "_" | "EOF")
}

fn check_control_sequence(tok: &Tok) -> R<String> {
    let name = tok.borrow().text.clone();
    if is_not_control_sequence(&name) {
        return perr_at("Expected a control sequence", tok);
    }
    Ok(name)
}

fn get_rhs(parser: &mut Parser) -> R<Tok> {
    let mut tok = parser.gullet.pop_token()?;
    if tok.borrow().text == "=" {
        tok = parser.gullet.pop_token()?;
        if tok.borrow().text == " " {
            tok = parser.gullet.pop_token()?;
        }
    }
    Ok(tok)
}

fn let_command(parser: &mut Parser, name: &str, tok: &Tok, global: bool) {
    let text = tok.borrow().text.clone();
    let def = match parser.gullet.macros.get(&text) {
        Some(d) => d,
        None => {
            tok.borrow_mut().noexpand = true;
            MacroDef::Exp(Rc::new(Expansion {
                tokens: vec![tok.clone()],
                num_args: 0,
                delimiters: None,
                unexpandable: !parser.gullet.is_expandable(&text),
            }))
        }
    };
    parser.gullet.macros.set(name, def, global);
}

fn internal(parser: &Parser) -> V {
    node! {"type" => "internal", "mode" => parser.mode}
}

fn global_handler(ctx: &mut Ctx, _args: &[V], _opt: &[V]) -> R<V> {
    ctx.parser.consume_spaces()?;
    let token = ctx.parser.fetch()?;
    let text = token.borrow().text.clone();
    if let Some(mapped) = global_map(&text) {
        if ctx.func_name == "\\global" || ctx.func_name == "\\\\globallong" {
            token.borrow_mut().text = mapped.to_string();
        }
        return match ctx.parser.parse_function(None, None)? {
            Some(n) => assert_node_type(&n, "internal"),
            None => jserr("Expected node of type internal, but got null"),
        };
    }
    perr_at("Invalid token after macro prefix", &token)
}

fn def_handler(ctx: &mut Ctx, _args: &[V], _opt: &[V]) -> R<V> {
    let func_name = ctx.func_name.clone();
    let parser = &mut *ctx.parser;
    let mut tok = parser.gullet.pop_token()?;
    let name = tok.borrow().text.clone();
    if is_not_control_sequence(&name) {
        return perr_at("Expected a control sequence", &tok);
    }
    let mut num_args = 0usize;
    let mut insert: Option<Tok> = None;
    let mut delimiters: Vec<Vec<String>> = vec![Vec::new()];
    while parser.gullet.future()?.borrow().text != "{" {
        tok = parser.gullet.pop_token()?;
        let text = tok.borrow().text.clone();
        if text == "#" {
            if parser.gullet.future()?.borrow().text == "{" {
                insert = Some(parser.gullet.future()?);
                delimiters[num_args].push("{".to_string());
                break;
            }
            tok = parser.gullet.pop_token()?;
            let digit = tok.borrow().text.clone();
            if !(digit.len() == 1 && matches!(digit.as_bytes()[0], b'1'..=b'9')) {
                return perr(format!("Invalid argument number \"{digit}\""));
            }
            if parse_int(&digit) != Some(num_args as i64 + 1) {
                return perr(format!("Argument number \"{digit}\" out of order"));
            }
            num_args += 1;
            delimiters.push(Vec::new());
        } else if text == "EOF" {
            return perr("Expected a macro definition");
        } else {
            delimiters[num_args].push(text);
        }
    }
    let (mut tokens, _, _) = parser.gullet.consume_arg()?;
    if let Some(i) = insert {
        tokens.insert(0, i);
    }
    if func_name == "\\edef" || func_name == "\\xdef" {
        tokens = parser.gullet.expand_tokens(tokens)?;
        if tokens.len() > parser.gullet.settings.max_expand {
            return perr(format!("Too many expansions in an {func_name}"));
        }
        tokens.reverse();
    }
    let global = global_map(&func_name) == Some(func_name.as_str());
    parser.gullet.macros.set(
        &name,
        MacroDef::Exp(Rc::new(Expansion {
            tokens,
            num_args,
            delimiters: Some(delimiters),
            unexpandable: false,
        })),
        global,
    );
    Ok(internal(parser))
}

fn let_handler(ctx: &mut Ctx, _args: &[V], _opt: &[V]) -> R<V> {
    let global = ctx.func_name == "\\\\globallet";
    let parser = &mut *ctx.parser;
    let name = check_control_sequence(&parser.gullet.pop_token()?)?;
    parser.gullet.consume_spaces()?;
    let tok = get_rhs(parser)?;
    let_command(parser, &name, &tok, global);
    Ok(internal(parser))
}

fn futurelet_handler(ctx: &mut Ctx, _args: &[V], _opt: &[V]) -> R<V> {
    let global = ctx.func_name == "\\\\globalfuture";
    let parser = &mut *ctx.parser;
    let name = check_control_sequence(&parser.gullet.pop_token()?)?;
    let middle = parser.gullet.pop_token()?;
    let tok = parser.gullet.pop_token()?;
    let_command(parser, &name, &tok, global);
    parser.gullet.push_token(tok);
    parser.gullet.push_token(middle);
    Ok(internal(parser))
}

fn newcommand_handler(ctx: &mut Ctx, _args: &[V], _opt: &[V]) -> R<V> {
    let func_name = ctx.func_name.clone();
    let parser = &mut *ctx.parser;
    let tok = parser.gullet.pop_token()?;
    let name = if tok.borrow().text == "{" {
        let n = check_control_sequence(&parser.gullet.pop_token()?)?;
        parser.gullet.pop_token()?;
        n
    } else {
        check_control_sequence(&tok)?
    };
    let exists = parser.gullet.is_defined(&name);
    if exists && func_name == "\\newcommand" {
        return perr(format!("\\newcommand{{{name}}} attempting to redefine {name}; use \\renewcommand"));
    }
    if !exists && func_name == "\\renewcommand" {
        return perr(format!(
            "\\renewcommand{{{name}}} when command {name} does not yet exist; use \\newcommand"
        ));
    }
    let mut num_args = 0usize;
    if parser.gullet.future()?.borrow().text == "[" {
        parser.gullet.pop_token()?;
        let t = parser.gullet.pop_token()?;
        let digit = t.borrow().text.clone();
        if !(digit.len() == 1 && digit.as_bytes()[0].is_ascii_digit()) {
            return perr(format!("Invalid number of arguments: \"{digit}\""));
        }
        num_args = (digit.as_bytes()[0] - b'0') as usize;
        let close = parser.gullet.pop_token()?;
        let close_text = close.borrow().text.clone();
        if close_text != "]" {
            return perr(format!("Invalid argument \"{close_text}\""));
        }
    }
    let (tokens, _, _) = parser.gullet.consume_arg()?;
    if !(func_name == "\\providecommand" && parser.gullet.macros.has(&name)) {
        parser.gullet.macros.set(
            &name,
            MacroDef::Exp(Rc::new(Expansion {
                tokens,
                num_args,
                delimiters: None,
                unexpandable: false,
            })),
            false,
        );
    }
    Ok(internal(parser))
}

pub fn register(r: &mut Registry) {
    let prefix = Props { allowed_in_text: true, ..Props::D };
    let primitive = Props { allowed_in_text: true, primitive: true, ..Props::D };
    r.define("internal", &["\\global", "\\long", "\\\\globallong"], prefix, global_handler, None);
    r.define("internal", &["\\def", "\\gdef", "\\edef", "\\xdef"], primitive, def_handler, None);
    r.define("internal", &["\\let", "\\\\globallet"], primitive, let_handler, None);
    r.define("internal", &["\\futurelet", "\\\\globalfuture"], primitive, futurelet_handler, None);
    r.define(
        "internal",
        &["\\newcommand", "\\renewcommand", "\\providecommand"],
        primitive,
        newcommand_handler,
        None,
    );
}
