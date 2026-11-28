//! Memry's `((date:…))` and `((mention:…))` tokens as the nodes they stand for
//! (chapter 12 §12.1.1.1).
//!
//! A date mention and a link mention reach a vault file as text tokens, and
//! desktop turns each token back into its `dateMention` or `linkMention` node:
//! its seed does it in the document every device receives, and its editor does
//! it on open for a body an older build seeded with the tokens as text. The
//! core does both too, through this one module: the markdown seed for the
//! documents it builds ([`super::markdown_seed`]), and [`promote_in`] for a body
//! that already holds tokens as text.
//!
//! The rule is desktop's (`packages/editor-schema/src/inline/inline-token-promote.ts`):
//! every match in a text run with no style, of any block but a code block, a
//! table cell included, whose payload parses becomes the node, and the text
//! around it stays in the run. A token in a styled run, in a link's text or in
//! an inline node stays text, and so does one whose payload is refused.

mod date;
mod link;
mod promote;

use yrs::{Any, TransactionMut, Xml as _, XmlElementRef};

pub(crate) use promote::promote_in;

/// The node a token becomes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InlineToken {
    /// `dateMention`, its props as `createDateMentionContent` sets them.
    Date(DateMention),
    /// `linkMention` as `createLinkMentionContent(url, domain)` makes it:
    /// `title`, `favicon` and `siteName` empty, for the editor to fill in.
    Link { url: String, domain: String },
}

/// A `dateMention`'s props (`packages/shared/src/date-mention.ts`
/// `DateMentionData`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DateMention {
    pub anchor_id: String,
    pub date_iso: String,
    pub has_time: bool,
    pub date_format: String,
    pub remind: String,
    pub time_format: String,
}

/// What one token's payload makes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Fate {
    Node(InlineToken),
    /// The payload is refused: the token stays text.
    Text,
    /// The payload parses, but this port cannot tell what desktop makes of it
    /// (a `Date.parse` or `new URL` case it does not reproduce).
    Undecided,
}

/// One piece of a text run cut at its tokens.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Piece<'a> {
    Text(&'a str),
    Node(InlineToken),
}

impl InlineToken {
    pub(crate) fn tag(&self) -> &'static str {
        match self {
            Self::Date(_) => "dateMention",
            Self::Link { .. } => "linkMention",
        }
    }

    /// Sets the node's props on `element`, every one of them, as y-prosemirror
    /// writes a node's `attrs`.
    pub(crate) fn write_attributes(&self, txn: &mut TransactionMut, element: &XmlElementRef) {
        let text = |value: &str| Any::String(value.into());
        let attributes: Vec<(&str, Any)> = match self {
            Self::Date(date) => vec![
                ("anchorId", text(&date.anchor_id)),
                ("dateISO", text(&date.date_iso)),
                ("hasTime", Any::Bool(date.has_time)),
                ("dateFormat", text(&date.date_format)),
                ("remind", text(&date.remind)),
                ("timeFormat", text(&date.time_format)),
            ],
            Self::Link { url, domain } => vec![
                ("url", text(url)),
                ("domain", text(domain)),
                ("title", text("")),
                ("favicon", text("")),
                ("siteName", text("")),
            ],
        };
        for (name, value) in attributes {
            element.insert_attribute(txn, name, value);
        }
    }
}

/// One token match in `text`: where it starts and ends, and its kind and
/// payload.
struct Match<'a> {
    start: usize,
    end: usize,
    date: bool,
    payload: &'a str,
}

/// `DATE_MENTION_TOKEN_REGEX`, `/\(\(date:([A-Za-z0-9,;_\\-]+)\)\)/g`, and
/// `MENTION_TOKEN_REGEX`, `/\(\(mention:([^()\n\r]+)\)\)/g`, in text order.
/// Neither payload class holds a paren, so the two never overlap.
fn matches(text: &str) -> Vec<Match<'_>> {
    let mut found = Vec::new();
    for (open, date) in [("((date:", true), ("((mention:", false)] {
        let mut from = 0;
        while let Some(at) = text[from..].find(open) {
            let start = from + at;
            let payload_start = start + open.len();
            let rest = &text[payload_start..];
            let length = rest
                .find(|c: char| {
                    if date {
                        !(c.is_ascii_alphanumeric() || matches!(c, ',' | ';' | '_' | '\\' | '-'))
                    } else {
                        matches!(c, '(' | ')' | '\n' | '\r')
                    }
                })
                .unwrap_or(rest.len());
            if length > 0 && rest[length..].starts_with("))") {
                let end = payload_start + length + 2;
                found.push(Match {
                    start,
                    end,
                    date,
                    payload: &rest[..length],
                });
                from = end;
            } else {
                from = start + 1;
            }
        }
    }
    found.sort_by_key(|found| found.start);
    found
}

/// What the token `payload` makes: `parseDateMentionToken`, else
/// `salvageDateMentionToken`, for a date; `parseLinkMentionToken` and the
/// URL's domain for a link.
fn fate(date: bool, payload: &str) -> Fate {
    if date {
        date::fate(payload)
    } else {
        link::fate(payload)
    }
}

/// `text` cut at every token that becomes a node, or `None` when none does.
/// An undecided token stays text, as a refused one does.
pub(crate) fn split(text: &str) -> Option<Vec<Piece<'_>>> {
    let mut pieces = Vec::new();
    let mut last = 0;
    for found in matches(text) {
        let Fate::Node(node) = fate(found.date, found.payload) else {
            continue;
        };
        if found.start > last {
            pieces.push(Piece::Text(&text[last..found.start]));
        }
        pieces.push(Piece::Node(node));
        last = found.end;
    }
    if pieces.is_empty() {
        return None;
    }
    if last < text.len() {
        pieces.push(Piece::Text(&text[last..]));
    }
    Some(pieces)
}

/// Whether `text` holds a token this port cannot decide.
pub(crate) fn holds_undecided(text: &str) -> bool {
    matches(text)
        .iter()
        .any(|found| fate(found.date, found.payload) == Fate::Undecided)
}

#[cfg(test)]
mod tests;
