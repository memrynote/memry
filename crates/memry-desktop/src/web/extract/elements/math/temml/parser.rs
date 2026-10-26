//! `Parser.js` (the expression and symbol half; arguments are in `parser_args`) and
//! `parseTree.js`.

use std::rc::Rc;

use super::functions::{self, Ctx};
use super::macro_expander::{MacroExpander, is_implicit_command};
use super::settings::Settings;
use super::tables::{symbol, tables};
use super::val::{R, Tok, V, jserr, loc_range, perr, perr_at, tok};
use crate::node;

const BIN_LEFT_CANCELLERS: [&str; 5] = ["bin", "op", "open", "punct", "rel"];
const END_OF_EXPRESSION: [&str; 6] = ["}", "\\endgroup", "\\end", "\\right", "\\endtoggle", "&"];

pub struct Parser {
    pub mode: &'static str,
    pub gullet: MacroExpander,
    pub settings: Rc<Settings>,
    pub left_right_depth: i32,
    pub prev_atom_type: String,
    pub next_token: Option<Tok>,
}

/// The trailing run of U+0300..U+036F in `text`, as `[start, end)` UTF-16 offsets.
fn combining_tail(text: &str) -> Option<usize> {
    let units: Vec<u16> = text.encode_utf16().collect();
    let mut i = units.len();
    while i > 0 && (0x0300..=0x036F).contains(&units[i - 1]) {
        i -= 1;
    }
    (i < units.len()).then_some(i)
}

fn utf16_prefix_str(text: &str, n: usize) -> String {
    String::from_utf16_lossy(&text.encode_utf16().take(n).collect::<Vec<_>>())
}

fn utf16_suffix_str(text: &str, n: usize) -> String {
    String::from_utf16_lossy(&text.encode_utf16().skip(n).collect::<Vec<_>>())
}

/// `text[0]` when it is a whole BMP character (a lone surrogate matches no table key).
fn first_bmp(text: &str) -> Option<char> {
    text.chars().next().filter(|c| (*c as u32) < 0x10000)
}

fn is_verb(text: &str) -> bool {
    match text.strip_prefix("\\verb") {
        Some(rest) => rest
            .chars()
            .next()
            .is_some_and(|c| !c.is_ascii_alphabetic()),
        None => false,
    }
}

impl Parser {
    pub fn new(input: &str, settings: Rc<Settings>) -> Parser {
        Parser {
            mode: "math",
            gullet: MacroExpander::new(input, settings.clone(), "math"),
            settings,
            left_right_depth: 0,
            prev_atom_type: String::new(),
            next_token: None,
        }
    }

    pub fn expect(&mut self, text: &str, consume: bool) -> R<()> {
        let t = self.fetch()?;
        if t.borrow().text != text {
            let got = t.borrow().text.clone();
            return perr_at(format!("Expected '{text}', got '{got}'"), &t);
        }
        if consume {
            self.consume();
        }
        Ok(())
    }

    pub fn consume(&mut self) {
        self.next_token = None;
    }

    pub fn fetch(&mut self) -> R<Tok> {
        if self.next_token.is_none() {
            self.next_token = Some(self.gullet.expand_next_token()?);
        }
        Ok(self.next_token.clone().expect("fetched"))
    }

    pub fn fetch_text(&mut self) -> R<String> {
        Ok(self.fetch()?.borrow().text.clone())
    }

    pub fn switch_mode(&mut self, mode: &'static str) {
        self.mode = mode;
        self.gullet.switch_mode(mode);
    }

    pub fn parse(&mut self) -> R<Vec<V>> {
        self.gullet.begin_group();
        let parse = self.parse_expression(false, None, false)?;
        self.expect("EOF", true)?;
        let tag = self.gullet.macros.get("\\df@tag");
        self.gullet.end_group()?;
        if let Some(tag) = tag {
            self.gullet
                .macros
                .current
                .borrow_mut()
                .insert("\\df@tag".to_string(), tag);
        }
        Ok(parse)
    }

    pub fn subparse(&mut self, tokens: Vec<Tok>) -> R<Vec<V>> {
        let old = self.next_token.clone();
        self.consume();
        self.gullet.push_token(tok("}", None));
        self.gullet.push_tokens(tokens);
        let parse = self.parse_expression(false, None, false)?;
        self.expect("}", true)?;
        self.next_token = old;
        Ok(parse)
    }

    pub fn parse_expression(
        &mut self,
        break_on_infix: bool,
        break_on_token_text: Option<&str>,
        break_on_middle: bool,
    ) -> R<Vec<V>> {
        let mut body: Vec<V> = Vec::new();
        self.prev_atom_type = String::new();
        loop {
            if self.mode == "math" {
                self.consume_spaces()?;
            }
            let lex = self.fetch_text()?;
            if END_OF_EXPRESSION.contains(&lex.as_str()) {
                break;
            }
            if break_on_token_text == Some(lex.as_str()) {
                break;
            }
            if break_on_middle && lex == "\\middle" {
                break;
            }
            if break_on_infix && functions::get(&lex).is_some_and(|f| f.infix) {
                break;
            }
            let Some(atom) = self.parse_atom(break_on_token_text)? else {
                break;
            };
            if atom.is_type("internal") {
                continue;
            }
            self.prev_atom_type = if atom.is_type("atom") {
                atom.text("family")
            } else {
                atom.ty()
            };
            body.push(atom);
        }
        if self.mode == "text" {
            self.form_ligatures(&mut body);
        }
        self.handle_infix_nodes(body)
    }

    fn handle_infix_nodes(&mut self, body: Vec<V>) -> R<Vec<V>> {
        let mut over_index: Option<usize> = None;
        let mut func_name = String::new();
        for (i, node) in body.iter().enumerate() {
            if node.is_type("infix") {
                if over_index.is_some() {
                    let t = match node.get("token") {
                        V::Tok(t) => t,
                        _ => tok("", None),
                    };
                    return perr_at("only one infix operator per group", &t);
                }
                over_index = Some(i);
                func_name = node.text("replaceWith");
            }
        }
        let Some(over) = over_index.filter(|_| !func_name.is_empty()) else {
            return Ok(body);
        };
        let numer_body = body[..over].to_vec();
        let denom_body = body[over + 1..].to_vec();
        let mode = self.mode;
        let group = |b: Vec<V>| -> V {
            if b.len() == 1 && b[0].is_type("ordgroup") {
                b[0].clone()
            } else {
                let n = node! {"type" => "ordgroup", "mode" => mode};
                n.set("body", V::arr(b));
                n
            }
        };
        let numer = group(numer_body);
        let denom = group(denom_body);
        let node = if func_name == "\\\\abovefrac" {
            self.call_function(
                &func_name,
                &[numer, body[over].clone(), denom],
                &[],
                None,
                None,
            )?
        } else {
            self.call_function(&func_name, &[numer, denom], &[], None, None)?
        };
        Ok(vec![node])
    }

    fn handle_supsubscript(&mut self, name: &str) -> R<V> {
        let symbol_token = self.fetch()?;
        let _ = symbol_token;
        self.consume();
        self.consume_spaces()?;
        loop {
            let group = self.parse_group(name, None)?;
            match group {
                None => return jserr("Cannot read properties of null (reading 'type')"),
                Some(g) if g.is_type("internal") => continue,
                Some(g) => return Ok(g),
            }
        }
    }

    fn format_unsupported_cmd(&self, text: &str) -> V {
        let textord_array: Vec<V> = text
            .chars()
            .map(|c| node! {"type" => "textord", "mode" => "text", "text" => c.to_string()})
            .collect();
        // JS iterates UTF-16 units; a command name holds none outside the BMP.
        let text_node = node! {"type" => "text", "mode" => self.mode};
        text_node.set("body", V::arr(textord_array));
        let color_node = node! {
            "type" => "color",
            "mode" => self.mode,
            "color" => self.settings.error_color.clone(),
        };
        color_node.set("body", V::arr(vec![text_node]));
        color_node
    }

    pub fn parse_atom(&mut self, break_on_token_text: Option<&str>) -> R<Option<V>> {
        let base = self.parse_group("atom", break_on_token_text)?;
        if let Some(b) = &base
            && b.is_type("internal")
        {
            return Ok(base);
        }
        if self.mode == "text" {
            return Ok(base);
        }
        let mut superscript: Option<V> = None;
        let mut subscript: Option<V> = None;
        loop {
            self.consume_spaces()?;
            let lex = self.fetch()?;
            let text = lex.borrow().text.clone();
            if text == "\\limits" || text == "\\nolimits" {
                match &base {
                    Some(b) if b.is_type("op") => {
                        b.set("limits", V::Bool(text == "\\limits"));
                        b.set("alwaysHandleSupSub", V::Bool(true));
                    }
                    Some(b) if b.is_type("operatorname") => {
                        if b.get("alwaysHandleSupSub").truthy() {
                            b.set("limits", V::Bool(text == "\\limits"));
                        }
                    }
                    _ => return perr_at("Limit controls must follow a math operator", &lex),
                }
                self.consume();
            } else if text == "^" {
                if superscript.is_some() {
                    return perr_at("Double superscript", &lex);
                }
                superscript = Some(self.handle_supsubscript("superscript")?);
            } else if text == "_" {
                if subscript.is_some() {
                    return perr_at("Double subscript", &lex);
                }
                subscript = Some(self.handle_supsubscript("subscript")?);
            } else if text == "'" {
                if superscript.is_some() {
                    return perr_at("Double superscript", &lex);
                }
                let prime = node! {"type" => "textord", "mode" => self.mode, "text" => "\\prime"};
                let mut primes = vec![prime.clone()];
                self.consume();
                while self.fetch_text()? == "'" {
                    primes.push(prime.clone());
                    self.consume();
                }
                if self.fetch_text()? == "^" {
                    primes.push(self.handle_supsubscript("superscript")?);
                }
                let group = node! {"type" => "ordgroup", "mode" => self.mode};
                group.set("body", V::arr(primes));
                superscript = Some(group);
            } else if let Some((ascii, is_sub)) = tables().u_subs_and_sups.get(&text).cloned() {
                let mut tokens = vec![tok(ascii, None)];
                self.consume();
                loop {
                    let t = self.fetch_text()?;
                    let Some((a, sub)) = tables().u_subs_and_sups.get(&t).cloned() else {
                        break;
                    };
                    if sub != is_sub {
                        break;
                    }
                    tokens.insert(0, tok(a, None));
                    self.consume();
                }
                let body = self.subparse(tokens)?;
                let group = node! {"type" => "ordgroup", "mode" => "math"};
                group.set("body", V::arr(body));
                if is_sub {
                    subscript = Some(group);
                } else {
                    superscript = Some(group);
                }
            } else {
                break;
            }
        }
        if superscript.is_none() && subscript.is_none() {
            return Ok(base);
        }
        if let Some(b) = &base
            && b.is_type("multiscript")
            && !b.get("postscripts").truthy()
        {
            let post = V::new_obj();
            post.set("sup", superscript.unwrap_or(V::Undef));
            post.set("sub", subscript.unwrap_or(V::Undef));
            b.set("postscripts", post);
            return Ok(base);
        }
        let followed = match &base {
            Some(b) if b.is_type("op") || b.is_type("operatorname") => {
                let next = match &self.next_token {
                    Some(t) => t.borrow().text.clone(),
                    None => return jserr("Cannot read properties of null (reading 'text')"),
                };
                V::Bool(functions::is_delimiter(&next))
            }
            _ => V::Undef,
        };
        let n = node! {"type" => "supsub", "mode" => self.mode};
        n.set("base", base.unwrap_or(V::Null));
        n.set("sup", superscript.unwrap_or(V::Undef));
        n.set("sub", subscript.unwrap_or(V::Undef));
        n.set("isFollowedByDelimiter", followed);
        Ok(Some(n))
    }

    pub fn parse_function(
        &mut self,
        break_on_token_text: Option<&str>,
        name: Option<&str>,
    ) -> R<Option<V>> {
        let token = self.fetch()?;
        let func = token.borrow().text.clone();
        let Some(func_data) = functions::get(&func) else {
            return Ok(None);
        };
        self.consume();
        if let Some(name) = name
            && name != "atom"
            && !func_data.allowed_in_argument
        {
            return perr_at(
                format!("Got function '{func}' with no arguments as {name}"),
                &token,
            );
        } else if self.mode == "text" && !func_data.allowed_in_text {
            return perr_at(format!("Can't use function '{func}' in text mode"), &token);
        } else if self.mode == "math" && !func_data.allowed_in_math {
            return perr_at(format!("Can't use function '{func}' in math mode"), &token);
        }
        let prev_atom_type = self.prev_atom_type.clone();
        let (args, opt_args) = self.parse_arguments(&func, func_data)?;
        self.prev_atom_type = prev_atom_type;
        Ok(Some(self.call_function(
            &func,
            &args,
            &opt_args,
            Some(token),
            break_on_token_text,
        )?))
    }

    pub fn call_function(
        &mut self,
        name: &str,
        args: &[V],
        opt_args: &[V],
        token: Option<Tok>,
        break_on_token_text: Option<&str>,
    ) -> R<V> {
        let Some(func) = functions::get(name) else {
            return perr(format!("No function handler for {name}"));
        };
        let mut ctx = Ctx {
            func_name: name.to_string(),
            parser: self,
            token,
            break_on_token_text: break_on_token_text.map(str::to_string),
        };
        (func.handler)(&mut ctx, args, opt_args)
    }

    pub fn consume_spaces(&mut self) -> R<()> {
        loop {
            let ch = self.fetch_text()?;
            if ch == " " || ch == "\u{a0}" || ch == "\u{fe0e}" {
                self.consume();
            } else {
                return Ok(());
            }
        }
    }

    pub fn parse_group(&mut self, name: &str, break_on_token_text: Option<&str>) -> R<Option<V>> {
        let first = self.fetch()?;
        let text = first.borrow().text.clone();
        if name == "argument to '\\left'" {
            return self.parse_symbol();
        }
        if text == "{" || text == "\\begingroup" || text == "\\toggle" {
            self.consume();
            let group_end = match text.as_str() {
                "{" => "}",
                "\\begingroup" => "\\endgroup",
                _ => "\\endtoggle",
            };
            self.gullet.begin_group();
            let expression = self.parse_expression(false, Some(group_end), false)?;
            let last = self.fetch()?;
            self.expect(group_end, true)?;
            self.gullet.end_group()?;
            let ty = if last.borrow().text == "\\endtoggle" {
                "toggle"
            } else {
                "ordgroup"
            };
            let result = node! {"type" => ty, "mode" => self.mode};
            result.set("loc", loc_range(&first, Some(&last)).into());
            result.set("body", V::arr(expression));
            if text == "\\begingroup" {
                result.set("semisimple", V::Bool(true));
            }
            return Ok(Some(result));
        }
        let mut result = self.parse_function(break_on_token_text, Some(name))?;
        if result.is_none() {
            result = self.parse_symbol()?;
        }
        if result.is_none() && text.starts_with('\\') && !is_implicit_command(&text) {
            if self.settings.throw_on_error {
                return perr_at(format!("Unsupported function name: {text}"), &first);
            }
            result = Some(self.format_unsupported_cmd(&text));
            self.consume();
        }
        Ok(result)
    }

    fn form_ligatures(&self, group: &mut Vec<V>) {
        if group.is_empty() {
            return;
        }
        let mut n = group.len() as isize - 1;
        let mut i = 0isize;
        while i < n {
            let a = group[i as usize].clone();
            let v = a.get("text");
            let next_text = group[i as usize + 1].get("text");
            let is = |x: &V, s: &str| matches!(x, V::Str(t) if t == s);
            if is(&v, "-") && is(&next_text, "-") {
                if i + 1 < n && is(&group[i as usize + 2].get("text"), "-") {
                    let t = node! {"type" => "textord", "mode" => "text", "text" => "---"};
                    group.splice(i as usize..i as usize + 3, [t]);
                    n -= 2;
                } else {
                    let t = node! {"type" => "textord", "mode" => "text", "text" => "--"};
                    group.splice(i as usize..i as usize + 2, [t]);
                    n -= 1;
                }
            }
            let v = group[i as usize].get("text");
            let is_quote = matches!(&v, V::Str(t) if t == "'" || t == "`");
            if is_quote && i + 1 < group.len() as isize {
                let doubled = group[i as usize + 1].get("text");
                let (V::Str(a), V::Str(b)) = (&v, &doubled) else {
                    i += 1;
                    continue;
                };
                if a == b {
                    let t =
                        node! {"type" => "textord", "mode" => "text", "text" => format!("{a}{a}")};
                    group.splice(i as usize..i as usize + 2, [t]);
                    n -= 1;
                }
            }
            i += 1;
        }
    }

    fn parse_symbol(&mut self) -> R<Option<V>> {
        let nucleus = self.fetch()?;
        let mut text = nucleus.borrow().text.clone();
        if is_verb(&text) {
            self.consume();
            let mut arg = utf16_suffix_str(&text, 5);
            let star = arg.starts_with('*');
            if star {
                arg = utf16_suffix_str(&arg, 1);
            }
            let chars: Vec<char> = arg.chars().collect();
            if chars.len() < 2 || chars[0] != chars[chars.len() - 1] {
                return perr(
                    "\\verb assertion failed --\n                    please report what input caused this bug",
                );
            }
            let inner: String = chars[1..chars.len() - 1].iter().collect();
            return Ok(Some(
                node! {"type" => "verb", "mode" => "text", "body" => inner, "star" => star},
            ));
        }
        let mode = self.mode;
        if let Some(first) = first_bmp(&text)
            && let Some(replacement) = tables().unicode_symbols.get(&first.to_string())
            && mode == "math"
            && symbol(mode, &first.to_string()).is_none()
        {
            if self.settings.strict {
                return perr_at(
                    format!("Accented Unicode text character \"{first}\" used in math mode"),
                    &nucleus,
                );
            }
            text = format!("{replacement}{}", utf16_suffix_str(&text, 1));
        }
        let combining = if mode == "math" {
            combining_tail(&text)
        } else {
            None
        };
        let match_text = combining.map(|at| utf16_suffix_str(&text, at));
        if let Some(at) = combining {
            text = utf16_prefix_str(&text, at);
            if text == "i" {
                text = "\u{131}".to_string();
            } else if text == "j" {
                text = "\u{237}".to_string();
            }
        }
        let mut sym: V;
        if let Some(entry) = symbol(mode, &text) {
            let mut group = entry.group.clone();
            if group == "bin"
                && (BIN_LEFT_CANCELLERS.contains(&self.prev_atom_type.as_str())
                    || self.prev_atom_type.is_empty())
            {
                group = "open".to_string();
            }
            let loc = loc_range(&nucleus, None);
            let s;
            if tables().atoms.contains(&group) {
                s = node! {"type" => "atom", "mode" => mode, "family" => group.clone(), "text" => text.clone()};
                s.set("loc", loc.clone().into());
                if (group == "rel" || group == "bin")
                    && self.prev_atom_type == "text"
                    && let Some(loc) = &loc
                    && text_follows(&loc.lexer, loc.end)
                {
                    s.set("needsSpacing", V::Bool(true));
                }
            } else {
                if let Some(ascii) = tables().ascii_from_script.get(&text) {
                    self.consume();
                    let next = self.fetch_text()?;
                    let code = next.encode_utf16().next();
                    let font = if code == Some(0xfe01) {
                        "mathscr"
                    } else {
                        "mathcal"
                    };
                    if matches!(code, Some(0xfe00) | Some(0xfe01)) {
                        self.consume();
                    }
                    let body =
                        node! {"type" => "mathord", "mode" => "math", "text" => ascii.clone()};
                    body.set("loc", loc.into());
                    let f = node! {"type" => "font", "mode" => "math", "font" => font};
                    f.set("body", body);
                    return Ok(Some(f));
                }
                s = node! {"type" => group.clone(), "mode" => mode, "text" => text.clone()};
                s.set("loc", loc.into());
            }
            sym = s;
        } else if text.encode_utf16().next().is_some_and(|u| u >= 0x80)
            || combining_tail(&text).is_some()
        {
            if self.settings.strict && mode == "math" {
                let first = text.chars().next().unwrap_or(' ');
                return perr_at(
                    format!("Unicode text character \"{first}\" used in math mode"),
                    &nucleus,
                );
            }
            sym = node! {"type" => "textord", "mode" => "text", "text" => text.clone()};
            sym.set("loc", loc_range(&nucleus, None).into());
        } else {
            return Ok(None);
        }
        self.consume();
        if let Some(marks) = match_text {
            for accent in marks.chars() {
                let key = accent.to_string();
                let Some(entry) = functions::unicode_accent(&key) else {
                    return perr_at(format!("Unknown accent ' {accent}'"), &nucleus);
                };
                let command = if mode == "math" {
                    entry.math.or(entry.text)
                } else {
                    entry.text
                };
                let Some(command) = command else {
                    return perr_at(
                        format!("Accent {accent} unsupported in {mode} mode"),
                        &nucleus,
                    );
                };
                let a = node! {
                    "type" => "accent",
                    "mode" => mode,
                    "label" => command,
                    "isStretchy" => false,
                };
                a.set("loc", loc_range(&nucleus, None).into());
                a.set("base", sym);
                sym = a;
            }
        }
        Ok(Some(sym))
    }
}

/// `/^ *\\text/.test(input.slice(end))`.
fn text_follows(input: &[u16], end: usize) -> bool {
    let rest = input.get(end..).unwrap_or(&[]);
    let spaces = rest.iter().take_while(|u| **u == 0x20).count();
    let want: Vec<u16> = "\\text".encode_utf16().collect();
    rest[spaces..].starts_with(&want)
}

/// `parseTree(toParse, settings)`.
pub fn parse_tree(to_parse: &str, settings: &Rc<Settings>) -> R<Vec<V>> {
    let mut parser = Parser::new(to_parse, settings.clone());
    parser.gullet.macros.delete("\\df@tag");
    let tree = match parser.parse() {
        Ok(tree) => tree,
        Err(e) if e.parse && !e.loc && e.message == " Unmatched delimiter" => {
            settings.wrap_delimiter_pairs.set(false);
            parser = Parser::new(to_parse, settings.clone());
            parser.gullet.macros.delete("\\df@tag");
            parser.parse()?
        }
        Err(e) => return Err(e),
    };
    let is_eqn_array = tree
        .first()
        .is_some_and(|n| n.is_type("array") && n.get("addEqnNum").truthy());
    if !is_eqn_array && parser.gullet.macros.get("\\df@tag").is_some() {
        if !settings.display_mode {
            return perr("\\tag works only in display mode");
        }
        parser.gullet.feed("\\df@tag");
        let tag = parser.parse()?;
        let n = node! {"type" => "tag", "mode" => "text"};
        n.set("body", V::arr(tree));
        n.set("tag", V::arr(tag));
        return Ok(vec![n]);
    }
    Ok(tree)
}
