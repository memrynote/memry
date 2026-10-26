//! The MessageFormat subset of `intl-messageformat` 10 with `ignoreTag: true`: literals with
//! apostrophe quoting, `{arg}`, `plural` / `selectordinal` (`offset:`, `=N`, category
//! selectors, `#`) and `select`. A parse or format error returns the raw template, the
//! `IcuFormatter` rule of `packages/i18n/src/shared/icu-formatter.ts`. Byte equality with
//! the real library is checked by `i18n-format.json`.

use std::collections::BTreeMap;

use icu_decimal::DecimalFormatter;
use icu_decimal::input::Decimal;
use icu_locale::Locale;
use icu_plurals::{PluralCategory, PluralRules};

/// A value passed to a message. JS strings and numbers are the only kinds the app uses.
#[derive(Debug, Clone, PartialEq)]
pub enum Arg {
    Str(String),
    Num(f64),
}

impl From<&str> for Arg {
    fn from(value: &str) -> Self {
        Self::Str(value.to_owned())
    }
}

impl From<i64> for Arg {
    fn from(value: i64) -> Self {
        Self::Num(value as f64)
    }
}

pub type Args = BTreeMap<String, Arg>;

/// `String(value)` of a JS number.
fn js_number(value: f64) -> String {
    if value.is_nan() {
        "NaN".to_owned()
    } else if value.is_infinite() {
        if value > 0.0 { "Infinity" } else { "-Infinity" }.to_owned()
    } else if value != 0.0 && (value.abs() >= 1e21 || value.abs() < 1e-6) {
        // JS switches to exponent form outside [1e-6, 1e21) and always signs the exponent.
        let text = format!("{value:e}");
        match text.split_once('e') {
            Some((mantissa, exponent)) if !exponent.starts_with('-') => {
                format!("{mantissa}e+{exponent}")
            }
            _ => text,
        }
    } else if value == value.trunc() {
        format!("{}", value as i128)
    } else {
        format!("{value}")
    }
}

impl Arg {
    fn as_text(&self) -> String {
        match self {
            Self::Str(text) => text.clone(),
            Self::Num(number) => js_number(*number),
        }
    }

    /// `Number(value)` as the plural lookup coerces it.
    fn as_number(&self) -> f64 {
        match self {
            Self::Num(number) => *number,
            Self::Str(text) => text.trim().parse().unwrap_or(f64::NAN),
        }
    }
}

#[derive(Debug)]
enum Node {
    Text(String),
    Arg(String),
    Pound,
    Plural {
        name: String,
        ordinal: bool,
        offset: i64,
        options: Vec<(String, Vec<Node>)>,
    },
    Select {
        name: String,
        options: Vec<(String, Vec<Node>)>,
    },
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Parent {
    None,
    Plural,
}

struct Parser {
    chars: Vec<char>,
    at: usize,
}

type Parsed<T> = Result<T, ()>;

fn is_pattern_syntax(ch: char) -> bool {
    ch.is_ascii_punctuation() && ch != '_'
}

impl Parser {
    fn peek(&self, ahead: usize) -> Option<char> {
        self.chars.get(self.at + ahead).copied()
    }

    fn skip_space(&mut self) {
        while self.peek(0).is_some_and(char::is_whitespace) {
            self.at += 1;
        }
    }

    fn eat(&mut self, ch: char) -> bool {
        let found = self.peek(0) == Some(ch);
        if found {
            self.at += 1;
        }
        found
    }

    fn identifier(&mut self) -> String {
        let start = self.at;
        while self
            .peek(0)
            .is_some_and(|ch| !ch.is_whitespace() && !is_pattern_syntax(ch))
        {
            self.at += 1;
        }
        self.chars[start..self.at].iter().collect()
    }

    fn message(&mut self, level: u32, parent: Parent) -> Parsed<Vec<Node>> {
        let mut nodes = Vec::new();
        while let Some(ch) = self.peek(0) {
            if ch == '{' {
                nodes.push(self.argument(level)?);
            } else if ch == '}' && level > 0 {
                break;
            } else if ch == '#' && parent == Parent::Plural {
                self.at += 1;
                nodes.push(Node::Pound);
            } else {
                let text = self.literal(level, parent);
                match nodes.last_mut() {
                    Some(Node::Text(previous)) => previous.push_str(&text),
                    _ => nodes.push(Node::Text(text)),
                }
            }
        }
        Ok(nodes)
    }

    fn literal(&mut self, level: u32, parent: Parent) -> String {
        let mut text = String::new();
        loop {
            if let Some(quoted) = self.quote(parent) {
                text.push_str(&quoted);
                continue;
            }
            match self.peek(0) {
                None | Some('{') => break,
                Some('#') if parent == Parent::Plural => break,
                Some('}') if level > 0 => break,
                Some(ch) => {
                    self.at += 1;
                    text.push(ch);
                }
            }
        }
        text
    }

    /// ICU apostrophe quoting as the formatjs parser reads it.
    fn quote(&mut self, parent: Parent) -> Option<String> {
        if self.peek(0) != Some('\'') {
            return None;
        }
        match self.peek(1) {
            Some('\'') => {
                self.at += 2;
                return Some("'".to_owned());
            }
            Some('{' | '<' | '>' | '}') => {}
            Some('#') if parent == Parent::Plural => {}
            _ => return None,
        }
        self.at += 1;
        let mut out = String::new();
        out.push(self.peek(0)?);
        self.at += 1;
        while let Some(ch) = self.peek(0) {
            if ch == '\'' {
                if self.peek(1) == Some('\'') {
                    out.push('\'');
                    self.at += 1;
                } else {
                    self.at += 1;
                    break;
                }
            } else {
                out.push(ch);
            }
            self.at += 1;
        }
        Some(out)
    }

    fn argument(&mut self, level: u32) -> Parsed<Node> {
        self.at += 1; // `{`
        self.skip_space();
        let name = self.identifier();
        if name.is_empty() {
            return Err(());
        }
        self.skip_space();
        if self.eat('}') {
            return Ok(Node::Arg(name));
        }
        if !self.eat(',') {
            return Err(());
        }
        self.skip_space();
        let kind = self.identifier();
        self.skip_space();
        match kind.as_str() {
            "plural" | "selectordinal" | "select" => {
                if !self.eat(',') {
                    return Err(());
                }
                self.skip_space();
                let mut offset = 0;
                if kind != "select" && self.starts_with("offset:") {
                    self.at += "offset:".len();
                    self.skip_space();
                    offset = self.integer()?;
                    self.skip_space();
                }
                let parent = if kind == "select" {
                    Parent::None
                } else {
                    Parent::Plural
                };
                let options = self.options(level, parent)?;
                if !options.iter().any(|(selector, _)| selector == "other") {
                    return Err(());
                }
                Ok(match kind.as_str() {
                    "select" => Node::Select { name, options },
                    _ => Node::Plural {
                        name,
                        ordinal: kind == "selectordinal",
                        offset,
                        options,
                    },
                })
            }
            // number, date, time and anything else are not part of the native subset.
            _ => Err(()),
        }
    }

    fn starts_with(&self, text: &str) -> bool {
        text.chars()
            .enumerate()
            .all(|(i, ch)| self.peek(i) == Some(ch))
    }

    fn integer(&mut self) -> Parsed<i64> {
        let start = self.at;
        self.eat('-');
        while self.peek(0).is_some_and(|ch| ch.is_ascii_digit()) {
            self.at += 1;
        }
        self.chars[start..self.at]
            .iter()
            .collect::<String>()
            .parse()
            .map_err(|_| ())
    }

    fn options(&mut self, level: u32, parent: Parent) -> Parsed<Vec<(String, Vec<Node>)>> {
        let mut options: Vec<(String, Vec<Node>)> = Vec::new();
        loop {
            self.skip_space();
            if self.peek(0) == Some('}') {
                self.at += 1;
                return Ok(options);
            }
            let selector = if self.eat('=') {
                let start = self.at;
                while self.peek(0).is_some_and(|ch| ch.is_ascii_digit()) {
                    self.at += 1;
                }
                if start == self.at {
                    return Err(());
                }
                format!("={}", self.chars[start..self.at].iter().collect::<String>())
            } else {
                self.identifier()
            };
            if selector.is_empty() || options.iter().any(|(seen, _)| *seen == selector) {
                return Err(());
            }
            self.skip_space();
            if !self.eat('{') {
                return Err(());
            }
            let body = self.message(level + 1, parent)?;
            if !self.eat('}') {
                return Err(());
            }
            options.push((selector, body));
        }
    }
}

struct Context<'a> {
    locale: &'a str,
    args: &'a Args,
}

impl Context<'_> {
    fn icu_locale(&self) -> Locale {
        Locale::try_from_str(self.locale)
            .or_else(|_| Locale::try_from_str("en"))
            .unwrap_or(Locale::UNKNOWN)
    }

    fn category(&self, ordinal: bool, value: f64) -> &'static str {
        let locale = self.icu_locale();
        let rules = if ordinal {
            PluralRules::try_new_ordinal((&locale).into())
        } else {
            PluralRules::try_new_cardinal((&locale).into())
        };
        let Ok(rules) = rules else { return "other" };
        let decimal = if value.is_finite() {
            Decimal::try_from_str(&js_number(value)).ok()
        } else {
            None
        };
        let Some(decimal) = decimal else {
            return "other";
        };
        match rules.category_for(&decimal) {
            PluralCategory::Zero => "zero",
            PluralCategory::One => "one",
            PluralCategory::Two => "two",
            PluralCategory::Few => "few",
            PluralCategory::Many => "many",
            PluralCategory::Other => "other",
        }
    }

    /// `Intl.NumberFormat(locale).format(value)` for `#`.
    fn number(&self, value: f64) -> String {
        let locale = self.icu_locale();
        let formatter = DecimalFormatter::try_new((&locale).into(), Default::default());
        let decimal = Decimal::try_from_str(&js_number(value));
        match (formatter, decimal) {
            (Ok(formatter), Ok(decimal)) if value.is_finite() => {
                formatter.format(&decimal).to_string()
            }
            _ => js_number(value),
        }
    }

    fn render(&self, nodes: &[Node], pound: Option<f64>, out: &mut String) -> Parsed<()> {
        for node in nodes {
            match node {
                Node::Text(text) => out.push_str(text),
                Node::Arg(name) => out.push_str(&self.args.get(name).ok_or(())?.as_text()),
                Node::Pound => {
                    if let Some(value) = pound {
                        out.push_str(&self.number(value));
                    } else {
                        out.push('#');
                    }
                }
                Node::Plural {
                    name,
                    ordinal,
                    offset,
                    options,
                } => {
                    let arg = self.args.get(name).ok_or(())?;
                    let exact = format!("={}", arg.as_text());
                    let shifted = arg.as_number() - *offset as f64;
                    let chosen = options
                        .iter()
                        .find(|(selector, _)| *selector == exact)
                        .or_else(|| {
                            let category = self.category(*ordinal, shifted);
                            options.iter().find(|(selector, _)| selector == category)
                        })
                        .or_else(|| options.iter().find(|(selector, _)| selector == "other"))
                        .ok_or(())?;
                    self.render(&chosen.1, Some(shifted), out)?;
                }
                Node::Select { name, options } => {
                    let value = self.args.get(name).ok_or(())?.as_text();
                    let chosen = options
                        .iter()
                        .find(|(selector, _)| *selector == value)
                        .or_else(|| options.iter().find(|(selector, _)| selector == "other"))
                        .ok_or(())?;
                    self.render(&chosen.1, pound, out)?;
                }
            }
        }
        Ok(())
    }
}

/// Formats `template` for `locale`, or returns it unchanged when it does not parse or an
/// argument is missing.
pub fn format_message(template: &str, locale: &str, args: &Args) -> String {
    let mut parser = Parser {
        chars: template.chars().collect(),
        at: 0,
    };
    let Ok(nodes) = parser.message(0, Parent::None) else {
        return template.to_owned();
    };
    let mut out = String::new();
    match (Context { locale, args }).render(&nodes, None, &mut out) {
        Ok(()) => out,
        Err(()) => template.to_owned(),
    }
}
