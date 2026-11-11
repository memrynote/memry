//! Split from `body_edit.rs` along its existing seams; see `mod.rs`.

#[allow(unused_imports)]
use super::*;
use yrs::{OffsetKind, Out};

/// Replaces a range of a block's text with an inline node.
///
/// **An inline node is a sibling element, not a mark** — y-prosemirror builds
/// one as an `XmlElement` beside the block's `XmlText` — so this splits the
/// run the range falls in and puts the node between the two halves.
///
/// The tail is rebuilt **with its formatting and its embeds**, read back
/// through the same `diff` the reader uses. Rebuilding it as plain text would
/// silently strip the bold a user already had from everything after their
/// cursor, which is the kind of loss that is only noticed much later.
///
/// An offset inside a character is refused before anything changes: yrs
/// would split the character's bytes (#4255).
#[allow(clippy::too_many_arguments)]
pub(super) fn insert_inline(
    txn: &mut TransactionMut,
    block_id: &str,
    start: u32,
    end: u32,
    kind: &str,
    text: &str,
    attrs: &HashMap<String, String>,
) -> Result<(), CrdtError> {
    if end < start {
        return Err(CrdtError::Undecodable {
            doc_id: block_id.to_owned(),
            what: "that range ends before it starts".to_owned(),
        });
    }
    let (_, block) = locate(txn, block_id).ok_or_else(|| missing(block_id))?;

    // The run the range falls in, and where it sits inside that run.
    let children: Vec<XmlOut> = block.children(txn).collect();
    let mut base = 0u32;
    let mut found: Option<(u32, XmlTextRef, u32)> = None;
    for (index, child) in children.iter().enumerate() {
        let length = match child {
            XmlOut::Text(run) => run.len(txn),
            XmlOut::Element(element) => element_text_len(txn, element),
            XmlOut::Fragment(_) => 0,
        };
        if let XmlOut::Text(run) = child
            && start >= base
            && end <= base + length
        {
            found = Some((index as u32, run.clone(), base));
            break;
        }
        base += length;
    }

    let (index, run, base) = found.ok_or_else(|| CrdtError::Undecodable {
        doc_id: block_id.to_owned(),
        what: "that range does not fall inside one run of this block's text".to_owned(),
    })?;

    let local_start = start - base;
    let local_end = end - base;

    // The tail, with its formatting and embeds, before anything is removed.
    let tail = match (
        run_tail(txn, &run, local_start),
        run_tail(txn, &run, local_end),
    ) {
        (Some(_), Some(tail)) => tail,
        _ => return Err(inside_a_character(block_id)),
    };
    if tail
        .iter()
        .any(|(content, _)| !matches!(content, Out::Any(_)))
    {
        // y-prosemirror never embeds a shared type in a text run; carrying
        // one over would need a deep copy, and dropping it loses data.
        return Err(CrdtError::Undecodable {
            doc_id: block_id.to_owned(),
            what: "the text after that range embeds a shared type".to_owned(),
        });
    }

    // Everything from the insertion point to the end of this run goes; the
    // tail comes back after the node.
    let length = run.len(txn);
    if length > local_start {
        run.remove_range(txn, local_start, length - local_start);
    }

    let node = block.insert(txn, index + 1, XmlElementPrelim::empty(kind));
    // Sorted, so two writes of the same node produce the same document.
    let mut names: Vec<&String> = attrs.keys().collect();
    names.sort();
    for name in names {
        node.insert_attribute(txn, name.as_str(), inline_attr(kind, name, &attrs[name]));
    }
    if !text.is_empty() {
        node.insert(txn, 0, XmlTextPrelim::new(text));
    }

    if !tail.is_empty() {
        let rebuilt = block.insert(txn, index + 2, XmlTextPrelim::new(""));
        for (content, chunk_attrs) in tail {
            // Appended at the run's own length, in the document's offset
            // unit. An unmarked chunk gets an explicit empty set: a plain
            // insert after a marked one would inherit its mark.
            let at = rebuilt.len(txn);
            let attrs = chunk_attrs.map(|attrs| *attrs).unwrap_or_default();
            match content {
                Out::Any(Any::String(text)) => {
                    rebuilt.insert_with_attributes(txn, at, &text, attrs);
                }
                Out::Any(embed) => {
                    rebuilt.insert_embed_with_attributes(txn, at, embed, attrs);
                }
                _ => unreachable!("refused above"),
            }
        }
    }
    Ok(())
}

/// The text an inline node displays, so an offset walk can step over it.
pub(super) fn element_text_len<T: ReadTxn>(txn: &T, element: &XmlElementRef) -> u32 {
    element
        .children(txn)
        .map(|child| match child {
            XmlOut::Text(run) => run.len(txn),
            _ => 0,
        })
        .sum()
}

/// One whole run's text, as formatted chunks. It takes no offset, so no
/// caller can start it inside a character and lose the rest of the run.
/// Embeds are left out, as the block snapshot has no place for them (#4262).
pub(super) fn formatted_text(
    txn: &TransactionMut,
    run: &XmlTextRef,
) -> Vec<(String, Option<Box<yrs::types::Attrs>>)> {
    run.diff(txn, yrs::types::text::YChange::identity)
        .into_iter()
        .filter_map(|chunk| match chunk.insert {
            Out::Any(Any::String(text)) => Some((text.to_string(), chunk.attributes)),
            _ => None,
        })
        .collect()
}

/// One run's content from `from` onward, as `(content, attributes)` chunks:
/// text as `Any::String`, an embed as what it holds. `from` is in the
/// document's own offset unit, bytes in a registry document
/// ([`crate::crdt::registry::OFFSET_KIND`]) and UTF-16 units in a Yjs-shaped
/// one; `None` when it falls inside a character.
fn run_tail(
    txn: &TransactionMut,
    run: &XmlTextRef,
    from: u32,
) -> Option<Vec<(Out, Option<Box<yrs::types::Attrs>>)>> {
    let kind = txn.doc().offset_kind();
    let mut out = Vec::new();
    let mut seen = 0u32;
    for chunk in run.diff(txn, yrs::types::text::YChange::identity) {
        let Out::Any(Any::String(value)) = &chunk.insert else {
            // An embed takes one position in either offset kind.
            if seen >= from {
                out.push((chunk.insert.clone(), chunk.attributes.clone()));
            }
            seen += 1;
            continue;
        };
        let chunk_end = seen + units(kind, value);
        if chunk_end > from {
            let skip = byte_index(kind, value, from.saturating_sub(seen))?;
            out.push((
                Out::Any(Any::from(&value[skip..])),
                chunk.attributes.clone(),
            ));
        }
        seen = chunk_end;
    }
    Some(out)
}

fn units(kind: OffsetKind, text: &str) -> u32 {
    match kind {
        OffsetKind::Bytes => text.len() as u32,
        OffsetKind::Utf16 => text.encode_utf16().count() as u32,
    }
}

/// The byte index of `offset` (in `kind`'s unit) in `text`, or `None` when
/// it falls inside a character.
fn byte_index(kind: OffsetKind, text: &str, offset: u32) -> Option<usize> {
    let mut seen = 0u32;
    for (index, ch) in text.char_indices() {
        if seen == offset {
            return Some(index);
        }
        seen += match kind {
            OffsetKind::Bytes => ch.len_utf8(),
            OffsetKind::Utf16 => ch.len_utf16(),
        } as u32;
        if seen > offset {
            return None;
        }
    }
    (seen == offset).then_some(text.len())
}

fn inside_a_character(block_id: &str) -> CrdtError {
    CrdtError::Undecodable {
        doc_id: block_id.to_owned(),
        what: "that offset falls inside a character".to_owned(),
    }
}

/// Applies or removes a mark over a range inside one block.
///
/// **This is what removes `SetText`'s documented limitation.** Replacing a
/// block's whole text loses its marks; a range keeps every run outside it, so
/// a shell with a selection no longer has to choose between formatting and
/// editing.
///
/// The attribute shape is y-prosemirror's: a mark's value is its `attrs`
/// object, and BlockNote wraps a string style's value in `stringValue`.
/// Removing is `Any::Null`, which is how yrs deletes a formatting attribute.
pub(super) fn set_mark(
    txn: &mut TransactionMut,
    block_id: &str,
    start: u32,
    end: u32,
    mark: &str,
    value: Option<&str>,
    apply: bool,
) -> Result<(), CrdtError> {
    if end <= start {
        // An empty range formats nothing. Refused rather than silently doing
        // nothing, because a caller that computed it wrongly should hear so.
        return Err(CrdtError::Undecodable {
            doc_id: block_id.to_owned(),
            what: "a mark needs a non-empty range".to_owned(),
        });
    }
    let (_, block) = locate(txn, block_id).ok_or_else(|| missing(block_id))?;

    let attribute = if !apply {
        Any::Null
    } else {
        match value {
            Some(value) => {
                let mut attrs = std::collections::HashMap::new();
                // `link` names its address `href`; every string style wraps
                // its value in `stringValue`.
                let key = if mark == "link" {
                    "href"
                } else {
                    "stringValue"
                };
                attrs.insert(key.to_owned(), Any::String(value.into()));
                Any::Map(attrs.into())
            }
            // A boolean style carries an empty attribute object.
            None => Any::Map(std::collections::HashMap::new().into()),
        }
    };

    // Every text run with where it starts, in the same offset walk
    // `insert_inline` uses: an inline node counts as the text it displays.
    // Addressing only the first run left everything after a wiki link or a
    // date unreachable.
    let mut runs: Vec<(u32, XmlTextRef, u32)> = Vec::new();
    let mut base = 0u32;
    for child in block.children(txn) {
        match child {
            XmlOut::Text(run) => {
                let length = run.len(txn);
                runs.push((base, run, length));
                base += length;
            }
            XmlOut::Element(element) if element.tag().as_ref() != "blockGroup" => {
                base += element_text_len(txn, &element);
            }
            _ => {}
        }
    }
    if runs.is_empty() {
        return Err(CrdtError::Undecodable {
            doc_id: block_id.to_owned(),
            what: "that block holds no text to mark".to_owned(),
        });
    }
    if start >= base {
        return Err(CrdtError::Undecodable {
            doc_id: block_id.to_owned(),
            what: "that range starts past the end of the block".to_owned(),
        });
    }
    let end = end.min(base);
    // Checked over every run before any is formatted, so a refusal leaves
    // the block as it was.
    for (run_start, run, length) in &runs {
        for offset in [start, end] {
            if offset > *run_start
                && offset < run_start + length
                && run_tail(txn, run, offset - run_start).is_none()
            {
                return Err(inside_a_character(block_id));
            }
        }
    }
    for (run_start, run, length) in runs {
        let from = start.max(run_start);
        let to = end.min(run_start + length);
        if from < to {
            run.format(
                txn,
                from - run_start,
                to - from,
                [(mark.into(), attribute.clone())].into(),
            );
        }
    }
    Ok(())
}

/// An inline node's attribute **in its declared type**.
///
/// The FFI carries every value as text, and BlockNote declares some of these
/// props as booleans: a date mention's `hasTime`, a wiki link's marks, a
/// checkbox's `checked`, a wiki link's card `cover` and `preview`. Stored as the string `"false"` they read as true
/// anywhere the prop is tested for truth, so a date written without a time
/// would render with one on desktop.
pub(super) fn inline_attr(kind: &str, name: &str, value: &str) -> Any {
    let boolean = matches!(
        (kind, name),
        ("dateMention", "hasTime")
            | ("inlineCheckbox", "checked")
            | (
                "wikiLink",
                "bold" | "italic" | "underline" | "strike" | "code" | "cover" | "preview"
            )
    );
    match (boolean, value) {
        (true, "true") => Any::Bool(true),
        (true, "false") => Any::Bool(false),
        _ => Any::String(value.into()),
    }
}
