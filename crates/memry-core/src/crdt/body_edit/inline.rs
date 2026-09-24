//! Split from `body_edit.rs` along its existing seams; see `mod.rs`.

#[allow(unused_imports)]
use super::*;

/// Replaces a range of a block's text with an inline node.
///
/// **An inline node is a sibling element, not a mark** — y-prosemirror builds
/// one as an `XmlElement` beside the block's `XmlText` — so this splits the
/// run the range falls in and puts the node between the two halves.
///
/// The tail is rebuilt **with its formatting**, read back through the same
/// `diff` the reader uses. Rebuilding it as plain text would silently strip
/// the bold a user already had from everything after their cursor, which is
/// the kind of loss that is only noticed much later.
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

    // The tail, with its formatting, before anything is removed.
    let tail = formatted_tail(txn, &run, local_end);

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
        node.insert_attribute(txn, name.as_str(), attrs[name].as_str());
    }
    if !text.is_empty() {
        node.insert(txn, 0, XmlTextPrelim::new(text));
    }

    if !tail.is_empty() {
        let rebuilt = block.insert(txn, index + 2, XmlTextPrelim::new(""));
        let mut at = 0u32;
        for (chunk, chunk_attrs) in tail {
            // An unmarked chunk gets an explicit empty set: a plain insert
            // after a marked one would inherit its mark.
            let attrs = chunk_attrs.map(|attrs| *attrs).unwrap_or_default();
            rebuilt.insert_with_attributes(txn, at, &chunk, attrs);
            at += chunk.chars().count() as u32;
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

/// One run's content from `from` onward, as formatted chunks.
pub(super) fn formatted_tail(
    txn: &TransactionMut,
    run: &XmlTextRef,
    from: u32,
) -> Vec<(String, Option<Box<yrs::types::Attrs>>)> {
    let mut out = Vec::new();
    let mut seen = 0u32;
    for chunk in run.diff(txn, yrs::types::text::YChange::identity) {
        let yrs::Out::Any(Any::String(value)) = &chunk.insert else {
            continue;
        };
        let length = value.chars().count() as u32;
        let chunk_end = seen + length;
        if chunk_end > from {
            let skip = from.saturating_sub(seen) as usize;
            let kept: String = value.chars().skip(skip).collect();
            if !kept.is_empty() {
                out.push((kept, chunk.attributes.clone()));
            }
        }
        seen = chunk_end;
    }
    out
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
    let text = block
        .children(txn)
        .find_map(|child| match child {
            XmlOut::Text(value) => Some(value),
            _ => None,
        })
        .ok_or_else(|| CrdtError::Undecodable {
            doc_id: block_id.to_owned(),
            what: "that block holds no text to mark".to_owned(),
        })?;

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

    let length = text.len(txn);
    if start >= length {
        return Err(CrdtError::Undecodable {
            doc_id: block_id.to_owned(),
            what: "that range starts past the end of the block".to_owned(),
        });
    }
    let end = end.min(length);
    text.format(txn, start, end - start, [(mark.into(), attribute)].into());
    Ok(())
}
