//! Defuddle's turndown rules (`dist/markdown.js:73-460`), in the order turndown tries them:
//! `addRule` puts the newest rule first, so this is the reverse of the order the rules are added
//! in. Turndown's own rules follow (`turndown::defaults`), then `keep` and `remove`.
//!
//! Not ported yet (stage 5, with `mathml-to-latex` and `temml`): the `callout`-preceding `katex`
//! and `math` rules, `extractLatex` and its helpers, the `ltx_equation` branch of `table` and the
//! `<math>` substitution in the `figure` caption. A page with math markup converts differently
//! from Defuddle until then; the oracle pages contain none. `handleTextNodesInTables` never
//! matches, since a rule filter only ever sees elements, so it has no port.

mod callout;
mod code;
mod footnotes;
mod images;
mod inline;
mod lists;
mod table;

use super::turndown::{Filter, Rule};

pub static RULES: &[Rule] = &[
    Rule {
        filter: Filter::Predicate(callout::is_callout),
        replacement: callout::callout,
    },
    Rule {
        filter: Filter::Predicate(code::is_pre),
        replacement: code::preformatted_code,
    },
    Rule {
        filter: Filter::Predicate(footnotes::is_backref),
        replacement: footnotes::backref,
    },
    Rule {
        filter: Filter::Predicate(footnotes::is_footnotes_list),
        replacement: footnotes::footnotes_list,
    },
    Rule {
        filter: Filter::Predicate(footnotes::is_citation),
        replacement: footnotes::citation,
    },
    Rule {
        filter: Filter::Predicate(lists::is_arxiv_enumerate),
        replacement: lists::arxiv_enumerate,
    },
    Rule {
        filter: Filter::Predicate(inline::is_complex_link),
        replacement: inline::complex_link,
    },
    Rule {
        filter: Filter::Tags(&["a"]),
        replacement: inline::link,
    },
    Rule {
        filter: Filter::Predicate(inline::is_strikethrough),
        replacement: inline::strikethrough,
    },
    Rule {
        filter: Filter::Tags(&["mark"]),
        replacement: inline::highlight,
    },
    Rule {
        filter: Filter::Predicate(images::is_embed),
        replacement: images::embed,
    },
    Rule {
        filter: Filter::Tags(&["img"]),
        replacement: images::image,
    },
    Rule {
        filter: Filter::Tags(&["figure"]),
        replacement: images::figure,
    },
    Rule {
        filter: Filter::Tags(&["li"]),
        replacement: lists::list_item,
    },
    Rule {
        filter: Filter::Tags(&["ul", "ol"]),
        replacement: lists::list,
    },
    Rule {
        filter: Filter::Tags(&["button"]),
        replacement: inline::button,
    },
    Rule {
        filter: Filter::Tags(&["table"]),
        replacement: table::table,
    },
];
