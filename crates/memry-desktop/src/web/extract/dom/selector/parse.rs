//! Port of css-what 6.2.2 `parse` (`lib/es/parse.js`). It works on `char`s where css-what works
//! on UTF-16 units; every index comparison is the same because the characters that steer the
//! parser are all ASCII and every other character is consumed whole by the name rule.

use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::js::is_js_whitespace;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttributeAction {
    Any,
    Element,
    End,
    Equals,
    Exists,
    Hyphen,
    Not,
    Start,
}

/// css-what's `ignoreCase`: `null`, `"quirks"`, `true` or `false`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IgnoreCase {
    Unknown,
    Quirks,
    Yes,
    No,
}

#[derive(Debug, Clone, PartialEq)]
pub enum PseudoData {
    None,
    Text(String),
    Selectors(Vec<Vec<Token>>),
}

#[derive(Debug, Clone, PartialEq)]
pub enum Token {
    Attribute {
        name: String,
        action: AttributeAction,
        value: String,
        namespace: Option<String>,
        ignore_case: IgnoreCase,
    },
    Pseudo {
        name: String,
        data: PseudoData,
    },
    PseudoElement,
    Tag {
        name: String,
        namespace: Option<String>,
    },
    Universal {
        namespace: Option<String>,
    },
    Adjacent,
    Child,
    Descendant,
    /// css-select's `_flexibleDescendant`, produced only while compiling.
    FlexibleDescendant,
    Parent,
    Sibling,
    ColumnCombinator,
}

impl Token {
    /// css-what `isTraversal`.
    pub fn is_traversal(&self) -> bool {
        matches!(
            self,
            Token::Adjacent
                | Token::Child
                | Token::Descendant
                | Token::Parent
                | Token::Sibling
                | Token::ColumnCombinator
        )
    }
}

fn err(message: impl Into<String>) -> ExtractError {
    ExtractError::Selector(message.into())
}

fn is_whitespace(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\n' | '\u{c}' | '\r')
}

fn is_quote(c: Option<char>) -> bool {
    matches!(c, Some('\'' | '"'))
}

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `.` in a JS regex without the `s` flag.
fn is_dot(c: char) -> bool {
    !matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// One iteration of `(?:\\(?:[\da-f]{1,6}\s?|.)|[\w\-\u00b0-\uFFFF])` from `reName`.
fn name_unit(s: &[char], pos: usize) -> Option<usize> {
    let c = *s.get(pos)?;
    if c == '\\' {
        let next = *s.get(pos + 1)?;
        if next.is_ascii_digit() || ('a'..='f').contains(&next) {
            let mut end = pos + 1;
            while end < s.len()
                && end - (pos + 1) < 6
                && (s[end].is_ascii_digit() || ('a'..='f').contains(&s[end]))
            {
                end += 1;
            }
            if end < s.len() && is_js_whitespace(s[end]) {
                end += 1;
            }
            return Some(end - pos);
        }
        return is_dot(next).then_some(2);
    }
    (is_word(c) || c == '-' || ('\u{b0}'..='\u{ffff}').contains(&c)).then_some(1)
}

fn name_run(s: &[char], mut pos: usize) -> Option<usize> {
    let start = pos;
    while let Some(width) = name_unit(s, pos) {
        pos += width;
    }
    (pos > start).then_some(pos - start)
}

/// Length of the match of `reName` at the start of `s`, or `None`. The leading
/// `[^\\#]?` takes any one character except a backslash or `#`, so `)x` is a name.
fn match_name(s: &[char]) -> Option<usize> {
    if let Some(&first) = s.first()
        && first != '\\'
        && first != '#'
        && let Some(rest) = name_run(s, 1)
    {
        return Some(1 + rest);
    }
    name_run(s, 0)
}

/// css-what `unescapeCSS`: `str.replace(/\\([\da-f]{1,6}\s?|(\s)|.)/gi, funescape)`.
fn unescape_css(input: &str) -> String {
    let s: Vec<char> = input.chars().collect();
    let mut out = String::new();
    let mut i = 0usize;
    while i < s.len() {
        if s[i] != '\\' || i + 1 >= s.len() {
            out.push(s[i]);
            i += 1;
            continue;
        }
        let next = s[i + 1];
        if next.is_ascii_hexdigit() {
            let mut end = i + 1;
            while end < s.len() && end - (i + 1) < 6 && s[end].is_ascii_hexdigit() {
                end += 1;
            }
            let hex: String = s[i + 1..end].iter().collect();
            if end < s.len() && is_js_whitespace(s[end]) {
                end += 1;
            }
            let code = u32::from_str_radix(&hex, 16).unwrap_or(0);
            push_escaped_code(&mut out, code);
            i = end;
        } else if is_js_whitespace(next) || is_dot(next) {
            out.push(next);
            i += 2;
        } else {
            out.push(s[i]);
            i += 1;
        }
    }
    out
}

/// css-what `funescape`: a BMP value becomes one UTF-16 unit, anything higher a surrogate pair
/// built with `>> 10`, which for values past U+10FFFF yields lone surrogates. A lone surrogate
/// cannot live in a Rust string and becomes U+FFFD.
fn push_escaped_code(out: &mut String, code: u32) {
    if code < 0x1_0000 {
        out.push(char::from_u32(code).unwrap_or('\u{fffd}'));
        return;
    }
    let high = (code - 0x1_0000) as u64;
    let units = [
        (((high >> 10) | 0xd800) & 0xffff) as u16,
        (((high & 0x3ff) | 0xdc00) & 0xffff) as u16,
    ];
    out.extend(char::decode_utf16(units).map(|r| r.unwrap_or('\u{fffd}')));
}

pub fn parse(selector: &str) -> Result<Vec<Vec<Token>>, ExtractError> {
    let chars: Vec<char> = selector.chars().collect();
    let mut subselects = Vec::new();
    let end = Parser {
        s: &chars,
        index: 0,
    }
    .parse_selector(&mut subselects, 0)?;
    if end < chars.len() {
        let rest: String = chars[end..].iter().collect();
        return Err(err(format!("Unmatched selector: {rest}")));
    }
    Ok(subselects)
}

struct Parser<'a> {
    s: &'a [char],
    index: usize,
}

impl Parser<'_> {
    fn at(&self, i: usize) -> Option<char> {
        self.s.get(i).copied()
    }

    fn get_name(&mut self, offset: usize) -> Result<String, ExtractError> {
        let from = (self.index + offset).min(self.s.len());
        match match_name(&self.s[from..]) {
            Some(len) => {
                let name: String = self.s[from..from + len].iter().collect();
                self.index += offset + len;
                Ok(unescape_css(&name))
            }
            None => {
                let rest: String = self.s[self.index.min(self.s.len())..].iter().collect();
                Err(err(format!("Expected name, found {rest}")))
            }
        }
    }

    fn strip_whitespace(&mut self, offset: usize) {
        self.index += offset;
        while self.index < self.s.len() && is_whitespace(self.s[self.index]) {
            self.index += 1;
        }
    }

    fn is_escaped(&self, mut pos: usize) -> bool {
        let mut slashes = 0;
        while pos > 0 {
            pos -= 1;
            if self.s[pos] == '\\' {
                slashes += 1;
            } else {
                break;
            }
        }
        slashes & 1 == 1
    }

    fn read_value_with_parenthesis(&mut self) -> Result<String, ExtractError> {
        self.index += 1;
        let start = self.index;
        let mut counter = 1;
        while counter > 0 && self.index < self.s.len() {
            match self.s[self.index] {
                '(' if !self.is_escaped(self.index) => counter += 1,
                ')' if !self.is_escaped(self.index) => counter -= 1,
                _ => {}
            }
            self.index += 1;
        }
        if counter != 0 {
            return Err(err("Parenthesis not matched"));
        }
        let text: String = self.s[start..self.index - 1].iter().collect();
        Ok(unescape_css(&text))
    }

    fn parse_selector(
        &mut self,
        subselects: &mut Vec<Vec<Token>>,
        selector_index: usize,
    ) -> Result<usize, ExtractError> {
        self.index = selector_index;
        let mut tokens: Vec<Token> = Vec::new();

        self.strip_whitespace(0);
        if self.s.len() == self.index {
            return Ok(self.index);
        }

        'outer: while self.index < self.s.len() {
            let first = self.s[self.index];
            match first {
                ' ' | '\t' | '\n' | '\u{c}' | '\r' => {
                    if tokens.is_empty() || tokens[0] != Token::Descendant {
                        ensure_not_traversal(&tokens)?;
                        tokens.push(Token::Descendant);
                    }
                    self.strip_whitespace(1);
                }
                '>' => {
                    add_traversal(&mut tokens, Token::Child)?;
                    self.strip_whitespace(1);
                }
                '<' => {
                    add_traversal(&mut tokens, Token::Parent)?;
                    self.strip_whitespace(1);
                }
                '~' => {
                    add_traversal(&mut tokens, Token::Sibling)?;
                    self.strip_whitespace(1);
                }
                '+' => {
                    add_traversal(&mut tokens, Token::Adjacent)?;
                    self.strip_whitespace(1);
                }
                '.' => {
                    let value = self.get_name(1)?;
                    tokens.push(special_attribute("class", AttributeAction::Element, value));
                }
                '#' => {
                    let value = self.get_name(1)?;
                    tokens.push(special_attribute("id", AttributeAction::Equals, value));
                }
                '[' => {
                    let token = self.parse_attribute()?;
                    tokens.push(token);
                }
                ':' => {
                    if self.at(self.index + 1) == Some(':') {
                        self.get_name(2)?;
                        if self.at(self.index) == Some('(') {
                            self.read_value_with_parenthesis()?;
                        }
                        tokens.push(Token::PseudoElement);
                        continue;
                    }
                    let token = self.parse_pseudo()?;
                    tokens.push(token);
                }
                ',' => {
                    finalize_subselector(&mut tokens, subselects)?;
                    tokens = Vec::new();
                    self.strip_whitespace(1);
                }
                _ => {
                    if self.s[self.index..].starts_with(&['/', '*']) {
                        let from = self.index + 2;
                        let found = (from..self.s.len().saturating_sub(1))
                            .find(|&i| self.s[i] == '*' && self.s[i + 1] == '/');
                        let Some(end) = found else {
                            return Err(err("Comment was not terminated"));
                        };
                        self.index = end + 2;
                        if tokens.is_empty() {
                            self.strip_whitespace(0);
                        }
                        continue;
                    }
                    let mut namespace = None;
                    let mut name;
                    if first == '*' {
                        self.index += 1;
                        name = "*".to_string();
                    } else if first == '|' {
                        name = String::new();
                        if self.at(self.index + 1) == Some('|') {
                            add_traversal(&mut tokens, Token::ColumnCombinator)?;
                            self.strip_whitespace(2);
                            continue;
                        }
                    } else if match_name(&self.s[self.index..]).is_some() {
                        name = self.get_name(0)?;
                    } else {
                        break 'outer;
                    }
                    if self.at(self.index) == Some('|') && self.at(self.index + 1) != Some('|') {
                        namespace = Some(name);
                        if self.at(self.index + 1) == Some('*') {
                            name = "*".to_string();
                            self.index += 2;
                        } else {
                            name = self.get_name(1)?;
                        }
                    }
                    tokens.push(if name == "*" {
                        Token::Universal { namespace }
                    } else {
                        Token::Tag { name, namespace }
                    });
                }
            }
        }
        finalize_subselector(&mut tokens, subselects)?;
        Ok(self.index)
    }

    fn parse_attribute(&mut self) -> Result<Token, ExtractError> {
        self.strip_whitespace(1);
        let mut namespace = None;
        let mut name;
        if self.at(self.index) == Some('|') {
            name = self.get_name(1)?;
        } else if self.s[self.index..].starts_with(&['*', '|']) {
            namespace = Some("*".to_string());
            name = self.get_name(2)?;
        } else {
            name = self.get_name(0)?;
            if self.at(self.index) == Some('|') && self.at(self.index + 1) != Some('=') {
                namespace = Some(name);
                name = self.get_name(1)?;
            }
        }
        self.strip_whitespace(0);

        let mut action = AttributeAction::Exists;
        let possible = match self.at(self.index) {
            Some('~') => Some(AttributeAction::Element),
            Some('^') => Some(AttributeAction::Start),
            Some('$') => Some(AttributeAction::End),
            Some('*') => Some(AttributeAction::Any),
            Some('!') => Some(AttributeAction::Not),
            Some('|') => Some(AttributeAction::Hyphen),
            _ => None,
        };
        if let Some(found) = possible {
            action = found;
            if self.at(self.index + 1) != Some('=') {
                return Err(err("Expected `=`"));
            }
            self.strip_whitespace(2);
        } else if self.at(self.index) == Some('=') {
            action = AttributeAction::Equals;
            self.strip_whitespace(1);
        }

        let mut value = String::new();
        let mut ignore_case = IgnoreCase::Unknown;
        if action != AttributeAction::Exists {
            if is_quote(self.at(self.index)) {
                let quote = self.s[self.index];
                let mut end = self.index + 1;
                while end < self.s.len() && (self.s[end] != quote || self.is_escaped(end)) {
                    end += 1;
                }
                if self.at(end) != Some(quote) {
                    return Err(err("Attribute value didn't end"));
                }
                let text: String = self.s[self.index + 1..end].iter().collect();
                value = unescape_css(&text);
                self.index = end + 1;
            } else {
                let start = self.index;
                while self.index < self.s.len()
                    && ((!is_whitespace(self.s[self.index]) && self.s[self.index] != ']')
                        || self.is_escaped(self.index))
                {
                    self.index += 1;
                }
                let text: String = self.s[start..self.index].iter().collect();
                value = unescape_css(&text);
            }
            self.strip_whitespace(0);
            // `code | 0x20` on the code unit; NaN at the end of input never matches.
            match self.at(self.index).map(|c| c as u32 | 0x20) {
                Some(0x73) => {
                    ignore_case = IgnoreCase::No;
                    self.strip_whitespace(1);
                }
                Some(0x69) => {
                    ignore_case = IgnoreCase::Yes;
                    self.strip_whitespace(1);
                }
                _ => {}
            }
        }
        if self.at(self.index) != Some(']') {
            return Err(err("Attribute selector didn't terminate"));
        }
        self.index += 1;
        Ok(Token::Attribute {
            name,
            action,
            value,
            namespace,
            ignore_case,
        })
    }

    fn parse_pseudo(&mut self) -> Result<Token, ExtractError> {
        let name = self.get_name(1)?.to_lowercase();
        let mut data = PseudoData::None;
        if self.at(self.index) == Some('(') {
            if matches!(
                name.as_str(),
                "has" | "not" | "matches" | "is" | "where" | "host" | "host-context"
            ) {
                if is_quote(self.at(self.index + 1)) {
                    return Err(err(format!("Pseudo-selector {name} cannot be quoted")));
                }
                let mut inner = Vec::new();
                let end = self.parse_selector(&mut inner, self.index + 1)?;
                self.index = end;
                if self.at(self.index) != Some(')') {
                    let all: String = self.s.iter().collect();
                    return Err(err(format!(
                        "Missing closing parenthesis in :{name} ({all})"
                    )));
                }
                self.index += 1;
                data = PseudoData::Selectors(inner);
            } else {
                let mut text = self.read_value_with_parenthesis()?;
                if matches!(name.as_str(), "contains" | "icontains") {
                    let chars: Vec<char> = text.chars().collect();
                    if let (Some(&first), Some(&last)) = (chars.first(), chars.last())
                        && first == last
                        && (first == '\'' || first == '"')
                    {
                        text = if chars.len() < 2 {
                            String::new()
                        } else {
                            chars[1..chars.len() - 1].iter().collect()
                        };
                    }
                }
                data = PseudoData::Text(unescape_css(&text));
            }
        }
        Ok(Token::Pseudo { name, data })
    }
}

fn special_attribute(name: &str, action: AttributeAction, value: String) -> Token {
    Token::Attribute {
        name: name.to_string(),
        action,
        value,
        namespace: None,
        ignore_case: IgnoreCase::Quirks,
    }
}

fn ensure_not_traversal(tokens: &[Token]) -> Result<(), ExtractError> {
    if tokens.last().is_some_and(Token::is_traversal) {
        return Err(err("Did not expect successive traversals."));
    }
    Ok(())
}

fn add_traversal(tokens: &mut Vec<Token>, token: Token) -> Result<(), ExtractError> {
    if tokens.last() == Some(&Token::Descendant) {
        *tokens.last_mut().expect("checked non-empty") = token;
        return Ok(());
    }
    ensure_not_traversal(tokens)?;
    tokens.push(token);
    Ok(())
}

fn finalize_subselector(
    tokens: &mut Vec<Token>,
    subselects: &mut Vec<Vec<Token>>,
) -> Result<(), ExtractError> {
    if tokens.last() == Some(&Token::Descendant) {
        tokens.pop();
    }
    if tokens.is_empty() {
        return Err(err("Empty sub-selector"));
    }
    subselects.push(std::mem::take(tokens));
    Ok(())
}
