//! `Parser.js`: argument parsing (`parseArguments` and the group-of-type parsers).

use std::sync::LazyLock;

use regex::Regex;

use super::functions::FuncData;
use super::parser::Parser;
use super::units::valid_unit;
use super::val::{R, Tok, V, perr, perr_at, tok_range};
use crate::node;
use crate::web::extract::utils::js::to_number;

static SIZE_PREFIX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[-+]? *(?:$|[0-9]+|[0-9]+\.[0-9]*|\.[0-9]*) *[a-z]{0,2} *$").expect("regex")
});
static SIZE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"([-+]?) *([0-9]+(?:\.[0-9]*)?|\.[0-9]+) *([a-z]{2})").expect("regex")
});

impl Parser {
    pub fn parse_arguments(&mut self, func: &str, data: &FuncData) -> R<(Vec<V>, Vec<V>)> {
        let total = data.num_args + data.num_optional_args;
        if total == 0 {
            return Ok((Vec::new(), Vec::new()));
        }
        let mut args = Vec::new();
        let mut opt_args: Vec<V> = Vec::new();
        for i in 0..total {
            let mut arg_type = data.arg_types.and_then(|t| t.get(i).copied());
            let is_optional = i < data.num_optional_args;
            if (data.primitive && arg_type.is_none())
                || (data.ty == "sqrt" && i == 1 && opt_args[0].is_nullish())
            {
                arg_type = Some("primitive");
            }
            let arg =
                self.parse_group_of_type(&format!("argument to '{func}'"), arg_type, is_optional)?;
            if is_optional {
                opt_args.push(arg.unwrap_or(V::Null));
            } else if let Some(a) = arg {
                args.push(a);
            } else {
                return perr("Null argument, please report this as a bug");
            }
        }
        Ok((args, opt_args))
    }

    fn parse_group_of_type(
        &mut self,
        name: &str,
        ty: Option<&str>,
        optional: bool,
    ) -> R<Option<V>> {
        match ty {
            Some("size") => self.parse_size_group(optional),
            Some("url") => self.parse_url_group(optional),
            Some("math") => self.parse_argument_group(optional, Some("math")),
            Some("text") => self.parse_argument_group(optional, Some("text")),
            Some("hbox") => {
                let group = self.parse_argument_group(optional, Some("text"))?;
                Ok(group.map(|g| {
                    let n = node! {"type" => "styling", "scriptLevel" => "text"};
                    n.set("mode", g.get("mode"));
                    n.set("body", V::arr(vec![g]));
                    n
                }))
            }
            Some("raw") => {
                let token = self.parse_string_group("raw", optional)?;
                Ok(token.map(|t| {
                    node! {"type" => "raw", "mode" => "text", "string" => t.borrow().text.clone()}
                }))
            }
            Some("primitive") => {
                if optional {
                    return perr("A primitive argument cannot be optional");
                }
                match self.parse_group(name, None)? {
                    Some(g) => Ok(Some(g)),
                    None => {
                        let t = self.fetch()?;
                        perr_at(format!("Expected group as {name}"), &t)
                    }
                }
            }
            Some("original") | None => self.parse_argument_group(optional, None),
            Some(_) => {
                let t = self.fetch()?;
                perr_at(format!("Unknown group type as {name}"), &t)
            }
        }
    }

    pub fn parse_string_group(&mut self, _mode_name: &str, optional: bool) -> R<Option<Tok>> {
        let Some(arg_token) = self.gullet.scan_argument(optional)? else {
            return Ok(None);
        };
        let mut s = String::new();
        loop {
            let next = self.fetch()?;
            if next.borrow().text == "EOF" {
                break;
            }
            s.push_str(&next.borrow().text);
            self.consume();
        }
        self.consume();
        arg_token.borrow_mut().text = s;
        Ok(Some(arg_token))
    }

    fn parse_regex_group(&mut self, mode_name: &str) -> R<Tok> {
        let first = self.fetch()?;
        let mut last = first.clone();
        let mut s = String::new();
        loop {
            let next = self.fetch()?;
            let text = next.borrow().text.clone();
            if text == "EOF" || !SIZE_PREFIX.is_match(&format!("{s}{text}")) {
                break;
            }
            last = next;
            s.push_str(&text);
            self.consume();
        }
        if s.is_empty() {
            let t = first.borrow().text.clone();
            return perr_at(format!("Invalid {mode_name}: '{t}'"), &first);
        }
        Ok(tok_range(&first, &last, s))
    }

    pub fn parse_size_group(&mut self, optional: bool) -> R<Option<V>> {
        let mut is_blank = false;
        self.gullet.consume_spaces()?;
        let res = if !optional && self.gullet.future()?.borrow().text != "{" {
            Some(self.parse_regex_group("size")?)
        } else {
            self.parse_string_group("size", optional)?
        };
        let Some(res) = res else {
            return Ok(None);
        };
        if !optional && res.borrow().text.is_empty() {
            res.borrow_mut().text = "0pt".to_string();
            is_blank = true;
        }
        let text = res.borrow().text.clone();
        let Some(m) = SIZE.captures(&text) else {
            return perr_at(format!("Invalid size: '{text}'"), &res);
        };
        let number = to_number(&format!("{}{}", &m[1], &m[2]));
        let unit = m[3].to_string();
        if !valid_unit(&unit) {
            return perr_at(format!("Invalid unit: '{unit}'"), &res);
        }
        let value = V::new_obj();
        value.set("number", V::Num(number));
        value.set("unit", V::Str(unit));
        let n = node! {"type" => "size", "mode" => self.mode, "isBlank" => is_blank};
        n.set("value", value);
        Ok(Some(n))
    }

    pub fn parse_url_group(&mut self, optional: bool) -> R<Option<V>> {
        self.gullet.lexer.set_catcode("%", 13);
        self.gullet.lexer.set_catcode("~", 12);
        let res = self.parse_string_group("url", optional);
        self.gullet.lexer.set_catcode("%", 14);
        self.gullet.lexer.set_catcode("~", 13);
        let Some(res) = res? else {
            return Ok(None);
        };
        // The first replace's result is discarded in temml: the second one reads `res.text`.
        let url = res.borrow().text.replace("{\u{2044}}", "/");
        Ok(Some(
            node! {"type" => "url", "mode" => self.mode, "url" => url},
        ))
    }

    pub fn parse_argument_group(
        &mut self,
        optional: bool,
        mode: Option<&'static str>,
    ) -> R<Option<V>> {
        let Some(arg_token) = self.gullet.scan_argument(optional)? else {
            return Ok(None);
        };
        let outer_mode = self.mode;
        if let Some(m) = mode {
            self.switch_mode(m);
        }
        self.gullet.begin_group();
        let expression = self.parse_expression(false, Some("EOF"), false)?;
        self.expect("EOF", true)?;
        self.gullet.end_group()?;
        let result = node! {"type" => "ordgroup", "mode" => self.mode};
        result.set("loc", arg_token.borrow().loc.clone().into());
        result.set("body", V::arr(expression));
        if mode.is_some() {
            self.switch_mode(outer_mode);
        }
        Ok(Some(result))
    }
}
