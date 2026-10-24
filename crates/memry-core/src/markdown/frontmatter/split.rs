//! Port of `packages/shared/src/frontmatter-split.ts`: where a note's body
//! starts. Offsets are bytes; every delimiter the rule looks at is ASCII, so
//! the split points are the same ones the UTF-16 original finds.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrontmatterSplit<'a> {
    /// Exact original substring from byte 0 (BOM included) through the closing
    /// `---` line and its EOL, or `None` without frontmatter.
    /// `block + body == raw` always holds.
    pub block: Option<&'a str>,
    pub body: &'a str,
}

fn without_cr(line: &str) -> &str {
    line.strip_suffix('\r').unwrap_or(line)
}

/// Slice the raw frontmatter block, so re-emitting it is byte-exact by
/// construction. An unclosed block is not frontmatter.
pub fn split_frontmatter_block(raw: &str) -> FrontmatterSplit<'_> {
    let none = FrontmatterSplit {
        block: None,
        body: raw,
    };
    let bom = if raw.starts_with('\u{FEFF}') {
        '\u{FEFF}'.len_utf8()
    } else {
        0
    };
    let rest = &raw[bom..];
    let Some(first_nl) = rest.find('\n') else {
        return none;
    };
    if without_cr(&rest[..first_nl]) != "---" {
        return none;
    }
    let mut from = first_nl + 1;
    while from <= rest.len() {
        let nl = rest[from..].find('\n').map(|at| from + at);
        let line_end = nl.unwrap_or(rest.len());
        if without_cr(&rest[from..line_end]) == "---" {
            let block_end = nl.map_or(rest.len(), |at| at + 1);
            return FrontmatterSplit {
                block: Some(&raw[..bom + block_end]),
                body: &rest[block_end..],
            };
        }
        match nl {
            Some(at) => from = at + 1,
            None => break,
        }
    }
    none
}
