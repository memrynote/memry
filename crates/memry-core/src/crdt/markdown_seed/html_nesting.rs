//! How many handled tags desktop's HTML parse holds open, which is what its
//! recursion costs: `packages/editor-schema/src/inline/html-nesting.ts` is the
//! reference, and chapter 12 §12.1.0 states the rule.
//!
//! A handled tag opened while [`MAX_NESTING`] are open is text, and so is the
//! closing tag that belongs to it. "Open" is what the parse keeps, not what the
//! note spells: `<li>`, `<td>` and their kin close the one of their kind that is
//! open, a paragraph ends the marks opened in it, the parse's list of active
//! formatting elements keeps three of any identical ones, and a closing tag
//! closes the innermost open tag of its name that its scope can see.

use std::collections::HashMap;

use super::nesting::MAX_NESTING;

/// The tags the parse keeps in its active formatting list.
const FORMATTING: [&str; 9] = ["a", "b", "code", "em", "i", "s", "strike", "strong", "u"];

/// The handled tags the parse's "special" category holds: what a `<li>` start tag
/// and the "any other end tag" rule do not look past.
const SPECIAL: [&str; 23] = [
    "blockquote",
    "caption",
    "colgroup",
    "details",
    "figcaption",
    "figure",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "li",
    "ol",
    "pre",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "tr",
    "ul",
];

/// The handled tags whose start tag closes the paragraph that holds it.
const CLOSES_PARAGRAPH: [&str; 16] = [
    "blockquote",
    "details",
    "figcaption",
    "figure",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "li",
    "ol",
    "pre",
    "table",
    "ul",
];

/// What `</ul>` and the like cannot see past.
const SCOPE: [&str; 4] = ["caption", "table", "td", "th"];
const LIST_ITEM_SCOPE: [&str; 6] = ["caption", "table", "td", "th", "ol", "ul"];

fn is_heading(name: &str) -> bool {
    matches!(name, "h1" | "h2" | "h3" | "h4" | "h5" | "h6")
}

fn is_cell(name: &str) -> bool {
    matches!(name, "td" | "th")
}

fn is_section(name: &str) -> bool {
    matches!(name, "tbody" | "thead" | "tfoot")
}

/// What a closing tag did: closed an open tag, was the text of a capped one, or
/// closed nothing.
#[derive(PartialEq, Eq)]
pub(super) enum Close {
    Closed,
    Literal,
    Stray,
}

/// An open handled tag.
struct Open {
    name: String,
    seq: usize,
    /// Opened outside any paragraph, so no paragraph's end closes it.
    persistent: bool,
    /// The active-formatting entry that stands for it, if it has one.
    listed: Option<usize>,
}

/// An entry of the parse's list of active formatting elements.
struct Listed {
    id: usize,
    name: String,
    key: String,
    seq: usize,
    /// Whether its element is still open, as opposed to closed by a paragraph.
    on_stack: bool,
}

#[derive(Default)]
pub(super) struct HtmlNesting {
    /// The handled tags that are open, innermost last.
    stack: Vec<Open>,
    /// The parse's list of active formatting elements, oldest first.
    active: Vec<Listed>,
    /// The entries of `active` whose element a paragraph has closed.
    off: usize,
    /// For each name, the order of the tags of it that are text, innermost last.
    literal: HashMap<String, Vec<usize>>,
    seq: usize,
    next_id: usize,
    /// Whether the tags that open now are outside any paragraph.
    block: bool,
}

impl HtmlNesting {
    /// How many tags the parse holds open.
    fn depth(&self) -> usize {
        self.stack.len() + self.off
    }

    /// A blank line ends the paragraph, and the HTML block, that is open.
    pub(super) fn blank_line(&mut self) {
        self.end_paragraph();
        self.block = false;
    }

    /// A line that starts an HTML block interrupts a paragraph.
    pub(super) fn html_block_line(&mut self) {
        if !self.block {
            self.end_paragraph();
            self.block = true;
        }
    }

    /// A tag that holds nothing: a rule still closes the paragraph it is in.
    pub(super) fn passes(&mut self, name: &str) {
        if CLOSES_PARAGRAPH.contains(&name) {
            self.html_block_line();
        }
    }

    /// The end of a paragraph, heading or cell: the marks opened in it are closed.
    fn end_paragraph(&mut self) {
        while self.stack.last().is_some_and(|open| !open.persistent) {
            self.pop_to(self.stack.len() - 1);
        }
    }

    /// Opens `name`, whose attributes are spelled `key` (none to compare when
    /// `None`), and says whether it is within the cap. One that is not is text,
    /// and its close is.
    pub(super) fn open(&mut self, name: &str, key: Option<&str>) -> bool {
        self.close_implied(name);
        if self.depth() >= MAX_NESTING {
            self.push_literal(name);
            return false;
        }
        if CLOSES_PARAGRAPH.contains(&name) {
            self.html_block_line();
        }
        self.seq += 1;
        let mut open = Open {
            name: name.to_owned(),
            seq: self.seq,
            persistent: self.block,
            listed: None,
        };
        if FORMATTING.contains(&name) {
            let key = key.map_or_else(|| format!("?{}", open.seq), str::to_owned);
            self.list(&mut open, key);
        }
        self.stack.push(open);
        true
    }

    /// Counts a tag that is text (a plain `<span>`) so its close is text too.
    pub(super) fn push_literal(&mut self, name: &str) {
        self.seq += 1;
        self.literal
            .entry(name.to_owned())
            .or_default()
            .push(self.seq);
    }

    /// Closes the innermost open `name`, or says it was text or closed nothing.
    pub(super) fn close(&mut self, name: &str) -> Close {
        let literal_seq = self
            .literal
            .get(name)
            .and_then(|seqs| seqs.last())
            .copied()
            .unwrap_or(0);
        let formatting = FORMATTING.contains(&name);
        let listed = if formatting {
            self.active.iter().rposition(|entry| entry.name == name)
        } else {
            None
        };
        let at = if listed.is_none() {
            self.find(name)
        } else {
            None
        };
        let open_seq = match (listed, at) {
            (Some(entry), _) => self.active[entry].seq,
            (None, Some(index)) => self.stack[index].seq,
            (None, None) => 0,
        };
        if literal_seq > open_seq {
            if let Some(seqs) = self.literal.get_mut(name) {
                seqs.pop();
            }
            return Close::Literal;
        }
        if let Some(entry) = listed {
            self.unlist(entry, true);
            return Close::Closed;
        }
        let Some(index) = at else {
            return Close::Stray;
        };
        // A formatting element is taken out of its place and what it held
        // stays; the rest close what is inside them.
        if formatting {
            self.remove_at(index);
        } else {
            self.pop_to(index);
        }
        Close::Closed
    }

    /// Pops the open tags from `index` up, which the parse has closed.
    fn pop_to(&mut self, index: usize) {
        while self.stack.len() > index {
            let Some(open) = self.stack.pop() else { return };
            if let Some(id) = open.listed
                && let Some(entry) = self.active.iter_mut().find(|entry| entry.id == id)
            {
                entry.on_stack = false;
                self.off += 1;
            }
        }
    }

    /// Takes one open tag out of the stack, and the entry that stands for it with it.
    fn remove_at(&mut self, index: usize) {
        let open = self.stack.remove(index);
        if let Some(id) = open.listed
            && let Some(entry) = self.active.iter().position(|entry| entry.id == id)
        {
            self.active.remove(entry);
        }
    }

    /// Takes the entry at `index` off the active list. `close_element` is a
    /// close that also removes its element, which a Noah's Ark eviction does not.
    fn unlist(&mut self, index: usize, close_element: bool) {
        let entry = self.active.remove(index);
        if !entry.on_stack {
            self.off -= 1;
            return;
        }
        if let Some(at) = self
            .stack
            .iter()
            .position(|open| open.listed == Some(entry.id))
        {
            if close_element {
                self.stack.remove(at);
            } else {
                self.stack[at].listed = None;
            }
        }
    }

    fn list(&mut self, open: &mut Open, key: String) {
        if open.name == "a"
            && let Some(earlier) = self.active.iter().position(|entry| entry.name == "a")
        {
            // A second `<a>` closes the first.
            self.unlist(earlier, true);
        }
        let same: Vec<usize> = self
            .active
            .iter()
            .enumerate()
            .filter(|(_, entry)| entry.key == key)
            .map(|(index, _)| index)
            .collect();
        if same.len() >= 3 {
            self.unlist(same[0], false);
        }
        self.next_id += 1;
        open.listed = Some(self.next_id);
        self.active.push(Listed {
            id: self.next_id,
            name: open.name.clone(),
            key,
            seq: open.seq,
            on_stack: true,
        });
    }

    /// What an opening tag closes by itself, as the parse does.
    fn close_implied(&mut self, name: &str) {
        if is_heading(name) {
            if self.stack.last().is_some_and(|top| is_heading(&top.name)) {
                self.pop_to(self.stack.len() - 1);
            }
        } else if name == "li" {
            for index in (0..self.stack.len()).rev() {
                let open = self.stack[index].name.as_str();
                if open == "li" {
                    return self.pop_to(index);
                }
                if SPECIAL.contains(&open) {
                    return;
                }
            }
        } else if is_cell(name) || name == "tr" {
            // A cell closes the cell and a row the row, and what is in them.
            for index in (0..self.stack.len()).rev() {
                let open = self.stack[index].name.as_str();
                if open == "table" {
                    return;
                }
                if if name == "tr" {
                    open == "tr"
                } else {
                    is_cell(open)
                } {
                    return self.pop_to(index);
                }
            }
        } else if is_section(name) || name == "caption" || name == "colgroup" {
            // These close the cell, the row and the section: all that is in the table.
            if let Some(table) = self.stack.iter().rposition(|open| open.name == "table") {
                self.pop_to(table + 1);
            }
        }
    }

    /// Where the open tag a closing `name` closes is.
    fn find(&self, name: &str) -> Option<usize> {
        let scope = scope_of(name);
        for index in (0..self.stack.len()).rev() {
            let open = self.stack[index].name.as_str();
            if if is_heading(name) {
                is_heading(open)
            } else {
                open == name
            } {
                return Some(index);
            }
            let blocked = match scope {
                Some(scope) => scope.contains(&open),
                None => SPECIAL.contains(&open),
            };
            if blocked {
                return None;
            }
        }
        None
    }
}

/// The tags a closing `name` cannot see past, or `None` for the parse's "any
/// other end tag".
fn scope_of(name: &str) -> Option<&'static [&'static str]> {
    match name {
        "li" => Some(&LIST_ITEM_SCOPE),
        "table" => Some(&[]),
        "td" | "th" | "tr" | "tbody" | "thead" | "tfoot" | "caption" => Some(&["table"]),
        "span" | "del" | "video" | "audio" => None,
        _ if FORMATTING.contains(&name) => None,
        _ => Some(&SCOPE),
    }
}

#[cfg(test)]
mod tests {
    use super::super::raw_html::scan;
    use super::MAX_NESTING as CAP;

    /// The source of each range the scan hides in `markdown`.
    fn hidden(markdown: &str) -> Vec<String> {
        let chars: Vec<char> = markdown.chars().collect();
        scan(markdown, true)
            .into_iter()
            .map(|span| chars[span.start..span.end].iter().collect())
            .collect()
    }

    fn repeat(count: usize, make: impl Fn(usize) -> String, join: &str) -> String {
        (0..count).map(make).collect::<Vec<_>>().join(join)
    }

    #[test]
    fn a_tag_the_parse_closes_by_itself_is_one_open_at_a_time() {
        for markdown in [
            format!("<ul>\n{}", repeat(150, |i| format!("<li>{i}"), "\n")),
            format!(
                "<table>\n{}",
                repeat(150, |i| format!("<tr><td>a{i}<td>b{i}"), "\n")
            ),
            format!("<table><tr>{}", repeat(150, |_| "<th>h".into(), "")),
            format!(
                "<table>{}",
                repeat(
                    150,
                    |_| "<thead><tr><td>a<tbody><tr><td>b<tfoot>".into(),
                    ""
                )
            ),
            format!("<table>{}", repeat(150, |_| "<caption>c".into(), "")),
            repeat(150, |_| "<h1>a<h2>b".into(), ""),
            repeat(150, |i| format!("<a href=u{i}>x"), ""),
            format!(
                "<table><tr>{}",
                repeat(150, |_| "<td><ul><li><b>x".into(), "")
            ),
        ] {
            assert_eq!(hidden(&markdown), Vec::<String>::new(), "{markdown:.40}");
        }
    }

    #[test]
    fn a_list_item_does_not_look_past_its_list() {
        assert!(hidden(&repeat(CAP / 2, |_| "<ul><li>".into(), "")).is_empty());
        assert!(!hidden(&repeat(CAP / 2 + 1, |_| "<ul><li>".into(), "")).is_empty());
    }

    #[test]
    fn a_paragraph_ends_the_marks_opened_in_it() {
        assert!(hidden(&repeat(150, |i| format!("<b>x{i}"), "\n\n")).is_empty());
        assert_eq!(hidden(&repeat(CAP + 5, |_| "<b>x".into(), "\n")).len(), 5);
        let distinct = repeat(CAP + 5, |i| format!("<b data-n=\"{i}\">x"), "\n\n");
        assert_eq!(hidden(&distinct).len(), 5);
        let closed = repeat(5 * CAP, |i| format!("<b data-n=\"{i}\">x</b>"), "\n\n");
        assert!(hidden(&closed).is_empty());
        let blocks = repeat(
            5 * CAP,
            |_| "# <b>x\n- <i>y\n\n| <u>z |\n| - |".into(),
            "\n\n",
        );
        assert!(hidden(&blocks).is_empty());
    }

    #[test]
    fn a_tag_outside_a_paragraph_stays_open_past_the_blank_line() {
        for open in ["<blockquote>x", "a <ul>x", "a <pre>x"] {
            let markdown = repeat(CAP + 5, |_| open.into(), "\n\n");
            assert_eq!(hidden(&markdown).len(), 5, "{open}");
        }
        let closed = repeat(
            5 * CAP,
            |i| format!("<b data-n=\"{i}\">x</b> <ul>y</ul>"),
            "\n\n",
        );
        assert!(hidden(&closed).is_empty());
        let interrupted = repeat(CAP + 5, |_| "<b>x\n<ul>y".into(), "\n\n");
        assert!(!hidden(&interrupted).is_empty());
    }

    #[test]
    fn a_closing_tag_closes_the_innermost_open_tag_its_scope_sees() {
        let released = format!(
            "{}x</ul></ul></ul>{}",
            repeat(45, |_| "<ul><li>".into(), ""),
            repeat(8, |_| "<ul><li>".into(), "")
        );
        assert!(hidden(&released).is_empty());
        let behind_a_cell = repeat(60, |_| "<ul><table><tr><td>x</ul>".into(), "");
        assert!(!hidden(&behind_a_cell).is_empty());
        assert!(hidden(&repeat(5 * CAP, |_| "</ul></li></b>".into(), "")).is_empty());
        let toggles = repeat(
            150,
            |_| "<details data-memry-toggle>\nx\n</details>".into(),
            "\n\n",
        );
        assert!(
            hidden(&toggles)
                .iter()
                .all(|tag| !tag.starts_with("<details"))
        );
    }

    #[test]
    fn a_tag_closed_gives_back_its_count() {
        let markdown = format!(
            "{}x{} <b>y</b>",
            repeat(CAP + 3, |_| "<b>".into(), ""),
            repeat(CAP + 3, |_| "</b>".into(), "")
        );
        assert_eq!(
            hidden(&markdown),
            ["<b>", "<b>", "<b>", "</b>", "</b>", "</b>"]
        );
    }
}
