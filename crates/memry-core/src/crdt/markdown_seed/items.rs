//! BlockNote's inline content for a block, rebuilt from the seed's flat
//! pieces.
//!
//! The parse hands desktop text items that hold `\n`, one per run; the seed
//! splits them into a break piece between texts, as the document holds them.
//! A break carries the marks of the run it came from, so adjacent pieces with
//! the same marks are one item again, and where a break sits against a mark's
//! edge is as the parse put it: `**b**\nc` is bold `b` and plain `\nc`,
//! `**b\nc**` one bold item.

use super::roundtrip::UNSERIALIZED;
use super::{SeedInline, SeedMarks, Unsupported};

/// One BlockNote inline item: a run of text with one style, or a link (the
/// `link` mark) holding plain text. `text` may hold `\n`, a hard break.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Item {
    pub text: String,
    pub marks: SeedMarks,
}

impl Item {
    pub(super) fn is_code(&self) -> bool {
        self.marks.code
    }
}

/// `content` as BlockNote's items. Anything outside plain, bold, italic,
/// strike, code and plain-link runs is [`Unsupported`]: their nesting follows
/// the schema's mark order.
pub(super) fn items(content: &[SeedInline]) -> Result<Vec<Item>, Unsupported> {
    let mut out = Vec::new();
    let mut current: Option<Item> = None;
    for piece in content {
        let (text, marks) = match piece {
            SeedInline::Text { text, marks } => (text.as_str(), marks),
            SeedInline::HardBreak { marks } => ("\n", marks),
            SeedInline::InlineImage { .. }
            | SeedInline::HtmlComment { .. }
            | SeedInline::Token(_) => {
                return Err(UNSERIALIZED);
            }
        };
        let styles = [marks.bold, marks.italic, marks.strike, marks.code];
        let count = styles.iter().filter(|on| **on).count();
        if count > 1 || (count == 1 && marks.link.is_some()) {
            return Err(UNSERIALIZED);
        }
        match current.take() {
            Some(mut item) if item.marks == *marks => {
                item.text.push_str(text);
                current = Some(item);
            }
            previous => {
                out.extend(previous);
                current = Some(Item {
                    text: text.to_owned(),
                    marks: marks.clone(),
                });
            }
        }
    }
    out.extend(current);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(value: &str, marks: SeedMarks) -> SeedInline {
        SeedInline::Text {
            text: value.to_owned(),
            marks,
        }
    }

    fn hard_break(marks: &SeedMarks) -> SeedInline {
        SeedInline::HardBreak {
            marks: marks.clone(),
        }
    }

    #[test]
    fn a_break_belongs_to_the_run_it_was_split_from() {
        let bold = SeedMarks {
            bold: true,
            ..SeedMarks::default()
        };
        let plain = SeedMarks::default();
        let content = [
            text("a", bold.clone()),
            hard_break(&bold),
            text("b", bold.clone()),
            hard_break(&plain),
            text("c", plain),
        ];
        let texts: Vec<String> = items(&content)
            .expect("items")
            .into_iter()
            .map(|item| item.text)
            .collect();
        assert_eq!(texts, ["a\nb", "\nc"]);
    }
}
