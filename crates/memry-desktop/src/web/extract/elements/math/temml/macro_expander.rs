//! `Namespace.js` and `MacroExpander.js`: the macro table with TeX group scoping and the token
//! stack the parser reads from.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use super::functions;
use super::lexer::Lexer;
use super::macros;
use super::settings::Settings;
use super::tables::tables;
use super::val::{R, Tok, loc_range, perr, perr_at, tok, ulen};

/// What a macro expands to: a token list (in stack order) and its argument shape.
#[derive(Clone)]
pub struct Expansion {
    pub tokens: Vec<Tok>,
    pub num_args: usize,
    pub delimiters: Option<Vec<Vec<String>>>,
    pub unexpandable: bool,
}

pub enum MacroResult {
    Text(String),
    Exp(Expansion),
}

pub type MacroFn = fn(&mut MacroExpander) -> R<MacroResult>;

#[derive(Clone)]
pub enum MacroDef {
    Text(String),
    Func(MacroFn),
    Exp(Rc<Expansion>),
}

pub type MacroMap = Rc<RefCell<HashMap<String, MacroDef>>>;

pub struct Namespace {
    pub current: MacroMap,
    undef_stack: Vec<HashMap<String, Option<MacroDef>>>,
}

fn builtin(name: &str) -> Option<MacroDef> {
    if let Some(text) = tables().macros.get(name) {
        return Some(MacroDef::Text(text.clone()));
    }
    macros::function_macro(name).map(MacroDef::Func)
}

impl Namespace {
    pub fn new(current: MacroMap) -> Namespace {
        Namespace {
            current,
            undef_stack: Vec::new(),
        }
    }

    pub fn begin_group(&mut self) {
        self.undef_stack.push(HashMap::new());
    }

    pub fn end_group(&mut self) -> R<()> {
        let Some(undefs) = self.undef_stack.pop() else {
            return perr(
                "Unbalanced namespace destruction: attempt to pop global namespace; please report this as a bug",
            );
        };
        let mut current = self.current.borrow_mut();
        for (name, value) in undefs {
            match value {
                None => {
                    current.remove(&name);
                }
                Some(v) => {
                    current.insert(name, v);
                }
            }
        }
        Ok(())
    }

    pub fn has(&self, name: &str) -> bool {
        self.current.borrow().contains_key(name) || builtin(name).is_some()
    }

    pub fn get(&self, name: &str) -> Option<MacroDef> {
        if let Some(def) = self.current.borrow().get(name) {
            return Some(def.clone());
        }
        builtin(name)
    }

    pub fn set(&mut self, name: &str, value: MacroDef, global: bool) {
        if global {
            for frame in &mut self.undef_stack {
                frame.remove(name);
            }
            if let Some(top) = self.undef_stack.last_mut() {
                top.insert(name.to_string(), Some(value.clone()));
            }
        } else if let Some(top) = self.undef_stack.last_mut()
            && !top.contains_key(name)
        {
            top.insert(name.to_string(), self.current.borrow().get(name).cloned());
        }
        self.current.borrow_mut().insert(name.to_string(), value);
    }

    /// `set(name, undefined, true)`: `get` then reports the macro as undefined. Only used for
    /// names without a builtin.
    pub fn set_global_undefined(&mut self, name: &str) {
        for frame in &mut self.undef_stack {
            frame.remove(name);
        }
        if let Some(top) = self.undef_stack.last_mut() {
            top.insert(name.to_string(), None);
        }
        self.current.borrow_mut().remove(name);
    }

    pub fn delete(&mut self, name: &str) {
        self.current.borrow_mut().remove(name);
    }
}

pub struct MacroExpander {
    pub settings: Rc<Settings>,
    pub expansion_count: usize,
    pub lexer: Lexer,
    pub macros: Namespace,
    pub mode: &'static str,
    pub stack: Vec<Tok>,
}

const IMPLICIT: [&str; 4] = ["^", "_", "\\limits", "\\nolimits"];

pub fn is_implicit_command(name: &str) -> bool {
    IMPLICIT.contains(&name)
}

impl MacroExpander {
    pub fn new(input: &str, settings: Rc<Settings>, mode: &'static str) -> MacroExpander {
        let lexer = Lexer::new(input, &settings);
        MacroExpander {
            macros: Namespace::new(settings.macros.clone()),
            settings,
            expansion_count: 0,
            lexer,
            mode,
            stack: Vec::new(),
        }
    }

    pub fn feed(&mut self, input: &str) {
        self.lexer = Lexer::new(input, &self.settings);
    }

    pub fn switch_mode(&mut self, mode: &'static str) {
        self.mode = mode;
    }

    pub fn begin_group(&mut self) {
        self.macros.begin_group();
    }

    pub fn end_group(&mut self) -> R<()> {
        self.macros.end_group()
    }

    pub fn future(&mut self) -> R<Tok> {
        if self.stack.is_empty() {
            let t = self.lexer.lex()?;
            self.stack.push(t);
        }
        Ok(self.stack.last().expect("non-empty").clone())
    }

    pub fn pop_token(&mut self) -> R<Tok> {
        self.future()?;
        Ok(self.stack.pop().expect("non-empty"))
    }

    pub fn push_token(&mut self, t: Tok) {
        self.stack.push(t);
    }

    pub fn push_tokens(&mut self, tokens: Vec<Tok>) {
        self.stack.extend(tokens);
    }

    /// `scanArgument(isOptional)`: returns the argument token (empty text, the argument's range).
    pub fn scan_argument(&mut self, is_optional: bool) -> R<Option<Tok>> {
        let (start, end, tokens);
        if is_optional {
            self.consume_spaces()?;
            if self.future()?.borrow().text != "[" {
                return Ok(None);
            }
            start = self.pop_token()?;
            let (t, e) = self.consume_arg_delimited(Some(&["]".to_string()]))?;
            tokens = t;
            end = e;
        } else {
            let (t, s, e) = self.consume_arg()?;
            tokens = t;
            start = s;
            end = e;
        }
        let eof_loc = end.borrow().loc.clone();
        self.push_token(tok("EOF", eof_loc));
        self.push_tokens(tokens);
        Ok(Some(tok("", loc_range(&start, Some(&end)))))
    }

    pub fn consume_spaces(&mut self) -> R<()> {
        loop {
            let t = self.future()?;
            if t.borrow().text == " " {
                self.stack.pop();
            } else {
                return Ok(());
            }
        }
    }

    fn consume_arg_delimited(&mut self, delims: Option<&[String]>) -> R<(Vec<Tok>, Tok)> {
        let (tokens, _, end) = self.consume_arg_full(delims)?;
        Ok((tokens, end))
    }

    /// `consumeArg()` with no delimiters.
    pub fn consume_arg(&mut self) -> R<(Vec<Tok>, Tok, Tok)> {
        self.consume_arg_full(None)
    }

    /// `consumeArg(delims)`: the tokens in stack order, the first token and the last.
    pub fn consume_arg_full(&mut self, delims: Option<&[String]>) -> R<(Vec<Tok>, Tok, Tok)> {
        let mut tokens: Vec<Tok> = Vec::new();
        let is_delimited = delims.is_some_and(|d| !d.is_empty());
        if !is_delimited {
            self.consume_spaces()?;
        }
        let start = self.future()?;
        let mut depth: i32 = 0;
        let mut matched = 0usize;
        let mut last;
        loop {
            let t = self.pop_token()?;
            tokens.push(t.clone());
            last = t.clone();
            let text = t.borrow().text.clone();
            if text == "{" {
                depth += 1;
            } else if text == "}" {
                depth -= 1;
                if depth == -1 {
                    return perr_at("Extra }", &t);
                }
            } else if text == "EOF" {
                let expected = match delims {
                    Some(d) if is_delimited => d[matched].clone(),
                    _ => "}".to_string(),
                };
                return perr_at(
                    format!("Unexpected end of input in a macro argument, expected '{expected}'"),
                    &t,
                );
            }
            if let Some(d) = delims.filter(|_| is_delimited) {
                if (depth == 0 || (depth == 1 && d[matched] == "{")) && text == d[matched] {
                    matched += 1;
                    if matched == d.len() {
                        let n = tokens.len();
                        tokens.drain(n - matched..);
                        break;
                    }
                } else {
                    matched = 0;
                }
            }
            if depth == 0 && !is_delimited {
                break;
            }
        }
        if start.borrow().text == "{" && tokens.last().is_some_and(|t| t.borrow().text == "}") {
            tokens.pop();
            tokens.remove(0);
        }
        tokens.reverse();
        Ok((tokens, start, last))
    }

    pub fn consume_args(
        &mut self,
        num_args: usize,
        delimiters: Option<&Vec<Vec<String>>>,
    ) -> R<Vec<Vec<Tok>>> {
        if let Some(delimiters) = delimiters {
            if delimiters.len() != num_args + 1 {
                return perr("The length of delimiters doesn't match the number of args!");
            }
            for expected in &delimiters[0] {
                let t = self.pop_token()?;
                if *expected != t.borrow().text {
                    return perr_at("Use of the macro doesn't match its definition", &t);
                }
            }
        }
        let mut args = Vec::new();
        for i in 0..num_args {
            let delims = delimiters.map(|d| d[i + 1].as_slice());
            args.push(self.consume_arg_full(delims)?.0);
        }
        Ok(args)
    }

    /// `expandOnce(expandableOnly)`: true when a macro was expanded.
    pub fn expand_once(&mut self, expandable_only: bool) -> R<bool> {
        let top = self.pop_token()?;
        let name = top.borrow().text.clone();
        let expansion = if top.borrow().noexpand {
            None
        } else {
            self.get_expansion(&name)?
        };
        let expandable = match &expansion {
            Some(e) => !(expandable_only && e.unexpandable),
            None => false,
        };
        if !expandable {
            if expandable_only
                && expansion.is_none()
                && name.starts_with('\\')
                && !self.is_defined(&name)
            {
                return perr(format!("Undefined control sequence: {name}"));
            }
            self.push_token(top);
            return Ok(false);
        }
        let expansion = expansion.expect("expandable");
        self.expansion_count += 1;
        if self.expansion_count > self.settings.max_expand {
            return perr(
                "Too many expansions: infinite loop or need to increase maxExpand setting",
            );
        }
        let mut tokens = expansion.tokens.clone();
        let args = self.consume_args(expansion.num_args, expansion.delimiters.as_ref())?;
        if expansion.num_args > 0 {
            let mut i = tokens.len() as isize - 1;
            while i >= 0 {
                let t = tokens[i as usize].clone();
                if t.borrow().text == "#" {
                    if i == 0 {
                        return perr_at("Incomplete placeholder at end of macro body", &t);
                    }
                    i -= 1;
                    let next = tokens[i as usize].clone();
                    let text = next.borrow().text.clone();
                    if text == "#" {
                        tokens.remove(i as usize + 1);
                    } else if text.len() == 1 && matches!(text.as_bytes()[0], b'1'..=b'9') {
                        let n = (text.as_bytes()[0] - b'0') as usize;
                        let Some(arg) = args.get(n - 1) else {
                            return super::val::jserr("args[n] is not iterable");
                        };
                        tokens.splice(i as usize..i as usize + 2, arg.iter().cloned());
                    } else {
                        return perr_at("Not a valid argument number", &next);
                    }
                }
                i -= 1;
            }
        }
        self.push_tokens(tokens);
        Ok(true)
    }

    pub fn expand_after_future(&mut self) -> R<Tok> {
        self.expand_once(false)?;
        self.future()
    }

    pub fn expand_next_token(&mut self) -> R<Tok> {
        loop {
            if !self.expand_once(false)? {
                let t = self.stack.pop().expect("non-empty");
                if t.borrow().treat_as_relax {
                    t.borrow_mut().text = "\\relax".to_string();
                }
                return Ok(t);
            }
        }
    }

    pub fn expand_tokens(&mut self, tokens: Vec<Tok>) -> R<Vec<Tok>> {
        let mut output = Vec::new();
        let old = self.stack.len();
        self.push_tokens(tokens);
        while self.stack.len() > old {
            if !self.expand_once(true)? {
                let t = self.stack.pop().expect("non-empty");
                if t.borrow().treat_as_relax {
                    t.borrow_mut().noexpand = false;
                    t.borrow_mut().treat_as_relax = false;
                }
                output.push(t);
            }
        }
        Ok(output)
    }

    /// `_getExpansion(name)`.
    fn get_expansion(&mut self, name: &str) -> R<Option<Expansion>> {
        let Some(definition) = self.macros.get(name) else {
            return Ok(None);
        };
        if ulen(name) == 1
            && let Some(code) = self.lexer.catcodes.get(name)
            && *code != 13
        {
            return Ok(None);
        }
        let expansion = match definition {
            MacroDef::Func(f) => f(self)?,
            MacroDef::Text(t) => MacroResult::Text(t),
            MacroDef::Exp(e) => MacroResult::Exp((*e).clone()),
        };
        match expansion {
            MacroResult::Exp(e) => Ok(Some(e)),
            MacroResult::Text(text) => {
                let mut num_args = 0;
                if text.contains('#') {
                    let stripped = text.replace("##", "");
                    while stripped.contains(&format!("#{}", num_args + 1)) {
                        num_args += 1;
                    }
                }
                let mut body = Lexer::new(&text, &self.settings);
                let mut tokens = Vec::new();
                loop {
                    let t = body.lex()?;
                    if t.borrow().text == "EOF" {
                        break;
                    }
                    tokens.push(t);
                }
                tokens.reverse();
                Ok(Some(Expansion {
                    tokens,
                    num_args,
                    delimiters: None,
                    unexpandable: false,
                }))
            }
        }
    }

    pub fn is_defined(&self, name: &str) -> bool {
        self.macros.has(name)
            || functions::get(name).is_some()
            || tables().symbols_math.contains_key(name)
            || tables().symbols_text.contains_key(name)
            || is_implicit_command(name)
    }

    pub fn is_expandable(&self, name: &str) -> bool {
        match self.macros.get(name) {
            Some(MacroDef::Exp(e)) => !e.unexpandable,
            Some(_) => true,
            None => functions::get(name).is_some_and(|f| !f.primitive),
        }
    }
}
