//! The search box's grammar, turned into an FTS5 `MATCH` expression (#4318).
//!
//! Desktop's grammar, in the order the user typed it:
//!
//! - a plain word is a prefix (`pass` is `"pass"*`, so it finds "password"),
//!   and words side by side are AND-ed;
//! - `"exact phrase"` matches those words adjacent, with no prefix;
//! - the uppercase words `AND`, `OR` and `NOT` are operators. Lowercase `and`,
//!   `or` and `not` are words to search for.
//!
//! An operator with no operand before it (`NOT b`, `OR b`) or after it
//! (`a NOT`) is dropped, and of two operators in a row the second wins
//! (`a OR NOT b` is `a NOT b`): FTS5 has no unary `NOT` and raises a syntax
//! error on each of those shapes.
//!
//! ## A user string is not an FTS5 query
//!
//! A raw string handed to `MATCH` is parsed as an FTS5 expression, so a lone
//! `"`, a bare `*`, a `:`, `NEAR` or a `(` either changes the query the user
//! meant or raises a SQL error. The expression is therefore **built** from
//! parsed tokens, never passed through. Each word and phrase is split on every
//! non-alphanumeric character, which is what the `unicode61` tokenizer does to
//! the indexed side anyway, and each run lands inside a double-quoted FTS5
//! string. A string literal ends only at a `"` and every character FTS5 treats
//! as syntax is ASCII punctuation, so no run can close the quote. The only
//! bare words in the output are the three operators this module emits.
//!
//! `parseSearchQuery` in `apps/desktop/src/main/lib/search-utils.ts` is the
//! same parser. The two test tables hold the same cases.

/// The `MATCH` expressions for one query.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FtsQuery {
    /// Which rows match.
    pub expression: String,
    /// The words of a plain multi-word query as one prefixed phrase. Rows
    /// matching it sort first; `None` for a single word or a query with
    /// operators or quotes, which keep plain bm25 order.
    pub phrase: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Operator {
    And,
    Or,
    Not,
}

impl Operator {
    fn parse(word: &str) -> Option<Self> {
        match word {
            "AND" => Some(Self::And),
            "OR" => Some(Self::Or),
            "NOT" => Some(Self::Not),
            _ => None,
        }
    }

    fn keyword(self) -> &'static str {
        match self {
            Self::And => "AND",
            Self::Or => "OR",
            Self::Not => "NOT",
        }
    }
}

/// One parsed unit of the query. A term and a phrase each hold the
/// alphanumeric runs they were typed as, never empty.
#[derive(Debug)]
enum Token {
    Term(Vec<String>),
    Phrase(Vec<String>),
    Operator(Operator),
}

impl Token {
    /// The FTS5 operand, or `None` for an operator.
    fn operand(&self) -> Option<String> {
        match self {
            Self::Term(runs) => Some(format!("\"{}\"*", runs.join(" "))),
            Self::Phrase(runs) => Some(format!("\"{}\"", runs.join(" "))),
            Self::Operator(_) => None,
        }
    }
}

/// Turns the search box text into `MATCH` expressions, or `None` when it
/// carries no searchable term.
pub fn parse(query: &str) -> Option<FtsQuery> {
    let tokens = tokenize(query);

    let mut expression = String::new();
    let mut pending: Option<Operator> = None;
    for token in &tokens {
        let Some(operand) = token.operand() else {
            if let Token::Operator(operator) = token
                && !expression.is_empty()
            {
                pending = Some(*operator);
            }
            continue;
        };
        if !expression.is_empty() {
            expression.push(' ');
            if let Some(operator) = pending.take() {
                expression.push_str(operator.keyword());
                expression.push(' ');
            }
        }
        expression.push_str(&operand);
    }
    if expression.is_empty() {
        return None;
    }

    let terms: Vec<&Vec<String>> = tokens
        .iter()
        .map(|token| match token {
            Token::Term(runs) => Some(runs),
            Token::Phrase(_) | Token::Operator(_) => None,
        })
        .collect::<Option<_>>()
        .unwrap_or_default();
    let phrase = (terms.len() > 1).then(|| {
        let words: Vec<&str> = terms
            .iter()
            .flat_map(|runs| runs.iter())
            .map(String::as_str)
            .collect();
        format!("\"{}\"*", words.join(" "))
    });
    Some(FtsQuery { expression, phrase })
}

/// Splits on `"` pairs first, then on whitespace. A `"` with no partner is a
/// separator. Curly quotes count as `"`: iOS Smart Punctuation types `“…”`
/// when the user presses the quote key.
fn tokenize(query: &str) -> Vec<Token> {
    let query = query.replace(['\u{201C}', '\u{201D}'], "\"");
    let mut tokens = Vec::new();
    let mut rest = query.as_str();
    while let Some(open) = rest.find('"') {
        let Some(length) = rest[open + 1..].find('"') else {
            break;
        };
        words(&rest[..open], &mut tokens);
        let inner = runs(&rest[open + 1..open + 1 + length]);
        if !inner.is_empty() {
            tokens.push(Token::Phrase(inner));
        }
        rest = &rest[open + 2 + length..];
    }
    words(rest, &mut tokens);
    tokens
}

fn words(text: &str, tokens: &mut Vec<Token>) {
    for word in text.split(|character: char| character.is_whitespace() || character == '"') {
        if let Some(operator) = Operator::parse(word) {
            tokens.push(Token::Operator(operator));
            continue;
        }
        let runs = runs(word);
        if !runs.is_empty() {
            tokens.push(Token::Term(runs));
        }
    }
}

fn runs(text: &str) -> Vec<String> {
    text.split(|character: char| !character.is_alphanumeric())
        .filter(|run| !run.is_empty())
        .map(str::to_owned)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Query, expression, phrase. The same rows as `parseSearchQuery`'s table
    /// in `apps/desktop/src/main/lib/search-utils.test.ts`.
    const CASES: &[(&str, &str, Option<&str>)] = &[
        ("pass", "\"pass\"*", None),
        (
            "hello world",
            "\"hello\"* \"world\"*",
            Some("\"hello world\"*"),
        ),
        ("\"meeting notes\"", "\"meeting notes\"", None),
        (
            "meeting NOT personal",
            "\"meeting\"* NOT \"personal\"*",
            None,
        ),
        ("meeting AND notes", "\"meeting\"* AND \"notes\"*", None),
        ("meeting OR notes", "\"meeting\"* OR \"notes\"*", None),
        ("foo OR \"a b\"", "\"foo\"* OR \"a b\"", None),
        (
            "\"exact phrase\" AND other",
            "\"exact phrase\" AND \"other\"*",
            None,
        ),
        (
            "a or not b",
            "\"a\"* \"or\"* \"not\"* \"b\"*",
            Some("\"a or not b\"*"),
        ),
        ("NOT foo", "\"foo\"*", None),
        ("OR foo", "\"foo\"*", None),
        ("foo NOT", "\"foo\"*", None),
        ("foo OR", "\"foo\"*", None),
        ("a OR NOT b", "\"a\"* NOT \"b\"*", None),
        ("a AND OR b", "\"a\"* OR \"b\"*", None),
        ("title:foo", "\"title foo\"*", None),
        (
            "wi-fi router",
            "\"wi fi\"* \"router\"*",
            Some("\"wi fi router\"*"),
        ),
        (
            "he said \"hello",
            "\"he\"* \"said\"* \"hello\"*",
            Some("\"he said hello\"*"),
        ),
        ("a\"b c\"d", "\"a\"* \"b c\" \"d\"*", None),
        ("(chapter OR twelve)", "\"chapter\"* OR \"twelve\"*", None),
        ("\u{201C}meeting notes\u{201D}", "\"meeting notes\"", None),
        (
            "şifre café",
            "\"şifre\"* \"café\"*",
            Some("\"şifre café\"*"),
        ),
    ];

    #[test]
    fn each_query_builds_the_expression_desktop_builds() {
        for (query, expression, phrase) in CASES {
            let built = parse(query).unwrap_or_else(|| panic!("{query:?} built nothing"));
            assert_eq!(built.expression, *expression, "expression for {query:?}");
            assert_eq!(built.phrase.as_deref(), *phrase, "phrase for {query:?}");
        }
    }

    #[test]
    fn a_query_with_no_searchable_term_never_reaches_sql() {
        for empty in [
            "",
            "   ",
            "\"",
            "\"\"",
            "*",
            ":",
            "()",
            "--",
            "AND",
            "OR",
            "NOT",
            "NOT OR AND",
        ] {
            assert_eq!(parse(empty), None, "{empty:?}");
        }
    }

    #[test]
    fn no_input_can_close_a_quote_or_add_a_bare_word() {
        for hostile in [
            "he said \"hello",
            "\"\"\"",
            "a\"\"b",
            "*\"*\"*",
            "title:\"x OR y\"",
            "NEAR(a b, 2)",
            "^start -bar {x}",
        ] {
            let Some(built) = parse(hostile) else {
                continue;
            };
            let mut outside = String::new();
            for (index, part) in built.expression.split('"').enumerate() {
                if index % 2 == 0 {
                    outside.push_str(part);
                } else {
                    assert!(
                        part.chars().all(|c| c.is_alphanumeric() || c == ' '),
                        "{hostile:?} put syntax inside a quote: {}",
                        built.expression
                    );
                }
            }
            for bare in outside.split_whitespace() {
                assert!(
                    ["*", "AND", "OR", "NOT"].contains(&bare),
                    "{hostile:?} left a bare {bare:?}: {}",
                    built.expression
                );
            }
        }
    }
}
