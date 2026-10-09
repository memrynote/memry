//! Body `#tag` rewrite for a tag rename, after desktop's
//! `rewriteInlineTagsInMarkdown` and `renameTagsInDoc`
//! (`apps/desktop/src/main/tags/rename-tag-in-doc.ts`).
//!
//! A rename of `from` to `to` also renames every `from/…` child, whole tags
//! only: `#person` follows, `#personal` does not. A `hashTag` element gets its
//! `tag` attribute set; a `#tag` still held as text is rewritten in place with
//! its marks, by the grammar [`body_tags::tag_spans`] reads. Code blocks and
//! `code`-marked text are left alone.
//!
//! Sources, the byte prefilter and the write path are
//! [`notes::link_rewrite`](super::notes::link_rewrite)'s: every live markdown
//! note and journal, skipped unless its log holds the old name, edited through
//! [`body_write`] so the update is logged and queued. The rename already moved
//! the tag elsewhere, so a body that fails is reported on stderr and skipped.

use rusqlite::Connection;
use yrs::types::Attrs;
use yrs::types::text::YChange;
use yrs::{
    Any, Out, ReadTxn as _, Text as _, TransactionMut, Xml as _, XmlFragment as _, XmlOut,
    XmlTextRef,
};

use crate::api::errors::StorageError;
use crate::crdt::BODY_FRAGMENT;
use crate::crdt::errors::CrdtError;
use crate::crdt::update_log;
use crate::domain::notes::failed;
use crate::domain::{body_tags, body_write, journal, notes, tags};

/// The name `tag` takes when `from` is renamed to `to`, or `None` when it is
/// neither `from` nor a child of it. A child keeps its own suffix spelling.
pub(crate) fn renamed_tag(tag: &str, from: &str, to: &str) -> Option<String> {
    let key = tags::fold(tag);
    let from = tags::fold(from.trim());
    if key == from {
        return Some(to.trim().to_owned());
    }
    key.strip_prefix(&from)
        .filter(|rest| rest.starts_with('/'))
        .map(|_| format!("{}{}", to.trim(), &tag[from.len()..]))
}

/// Renames `from` (and its children) to `to` in every live body.
/// Never fails: see the module comment.
pub(crate) fn rewrite_bodies(
    conn: &Connection,
    from: &str,
    to: &str,
    device_id: &str,
    now_ms: i64,
) {
    let sources = match sources(conn) {
        Ok(sources) => sources,
        Err(error) => {
            eprintln!("memry-core: body #tag rename skipped, sources unreadable: {error}");
            return;
        }
    };
    let needle = tags::fold(from.trim());
    for (id, item_type) in sources {
        if let Err(error) =
            rewrite_source(conn, &id, item_type, &needle, from, to, device_id, now_ms)
        {
            eprintln!("memry-core: body #tag rename skipped {item_type}/{id}: {error}");
        }
    }
}

fn sources(conn: &Connection) -> Result<Vec<(String, &'static str)>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT id, 0 FROM notes WHERE deleted_at IS NULL AND file_type = 'markdown' \
             UNION ALL SELECT id, 1 FROM journal_entries WHERE deleted_at IS NULL \
             ORDER BY 1",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map([], |row| {
            let kind = if row.get::<_, i64>(1)? == 0 {
                notes::ITEM_TYPE
            } else {
                journal::ITEM_TYPE
            };
            Ok((row.get::<_, String>(0)?, kind))
        })
        .map_err(failed)?;
    rows.collect::<Result<_, _>>().map_err(failed)
}

#[allow(clippy::too_many_arguments)]
fn rewrite_source(
    conn: &Connection,
    id: &str,
    item_type: &str,
    needle: &str,
    from: &str,
    to: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<(), CrdtError> {
    let plan = update_log::load_plan(conn, id)?;
    let may_hold = plan.blobs().iter().any(|blob| {
        String::from_utf8_lossy(blob)
            .to_ascii_lowercase()
            .contains(needle)
    });
    if !may_hold {
        return Ok(());
    }
    let Some(update) = body_write::author_with(conn, id, device_id, |document| {
        document.write(|txn| rewrite_document(txn, from, to))
    })?
    else {
        return Ok(());
    };
    let tx = conn.unchecked_transaction().map_err(failed)?;
    body_write::append_in(&tx, item_type, id, &update, now_ms)?;
    tx.commit().map_err(failed)?;
    Ok(())
}

/// Renames the tag in one document's body.
pub(crate) fn rewrite_document(txn: &mut TransactionMut<'_>, from: &str, to: &str) {
    let Some(fragment) = txn.get_xml_fragment(BODY_FRAGMENT) else {
        return;
    };
    let mut chips = Vec::new();
    let mut runs = Vec::new();
    let mut pending: Vec<XmlOut> = fragment.children(txn).collect();
    while let Some(node) = pending.pop() {
        match node {
            XmlOut::Element(element) => match element.tag().as_ref() {
                "codeBlock" => {}
                "hashTag" => chips.push(element),
                _ => pending.extend(element.children(txn)),
            },
            XmlOut::Text(run) => runs.push(run),
            XmlOut::Fragment(_) => {}
        }
    }
    for chip in chips {
        let Some(tag) = chip
            .get_attribute(txn, "tag")
            .map(|value| value.to_string(txn))
        else {
            continue;
        };
        if let Some(next) = renamed_tag(&tag, from, to).filter(|next| *next != tag) {
            chip.insert_attribute(txn, "tag", next);
        }
    }
    for run in runs {
        rewrite_run(txn, &run, from, to);
    }
}

/// Rewrites the `#tags` of one text run. Offsets are UTF-8 bytes, the
/// document's offset kind.
fn rewrite_run(txn: &mut TransactionMut<'_>, run: &XmlTextRef, from: &str, to: &str) {
    let mut edits: Vec<(u32, u32, String, Attrs)> = Vec::new();
    let mut offset = 0usize;
    let mut before: Option<char> = None;
    for chunk in run.diff(txn, YChange::identity) {
        let Out::Any(Any::String(text)) = &chunk.insert else {
            offset += 1;
            before = Some('\u{0}');
            continue;
        };
        let attrs = chunk.attributes.map(|attrs| *attrs).unwrap_or_default();
        if !attrs.contains_key("code") {
            for (start, end) in body_tags::tag_spans(text, before) {
                if let Some(next) = renamed_tag(&text[start..end], from, to) {
                    let at = u32::try_from(offset + start).unwrap_or(u32::MAX);
                    let length = u32::try_from(end - start).unwrap_or(u32::MAX);
                    edits.push((at, length, next, attrs.clone()));
                }
            }
        }
        offset += text.len();
        before = text.chars().last().or(before);
    }
    for (at, length, next, attrs) in edits.into_iter().rev() {
        run.remove_range(txn, at, length);
        run.insert_with_attributes(txn, at, &next, attrs);
    }
}

#[cfg(test)]
mod tests {
    use yrs::{Doc, GetString as _, Transact as _, WriteTxn as _, XmlElementPrelim, XmlTextPrelim};

    use super::*;

    #[test]
    fn renames_whole_tags_and_children_only() {
        assert_eq!(
            renamed_tag("Person", "person", "people").as_deref(),
            Some("people")
        );
        assert_eq!(
            renamed_tag("person/VIP", "person", "people").as_deref(),
            Some("people/VIP")
        );
        assert_eq!(renamed_tag("personal", "person", "people"), None);
    }

    #[test]
    fn rewrites_chips_and_text_but_not_code() {
        let doc = Doc::new();
        let mut txn = doc.transact_mut();
        let fragment = txn.get_or_insert_xml_fragment(BODY_FRAGMENT);
        let paragraph = fragment.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
        let text = paragraph.push_back(&mut txn, XmlTextPrelim::new("ünï #person/vip, #personal "));
        let chip = paragraph.push_back(&mut txn, XmlElementPrelim::empty("hashTag"));
        chip.insert_attribute(&mut txn, "tag", "Person");
        let code = fragment.push_back(&mut txn, XmlElementPrelim::empty("codeBlock"));
        let code_text = code.push_back(&mut txn, XmlTextPrelim::new("#person"));

        rewrite_document(&mut txn, "person", "people");

        assert_eq!(text.get_string(&txn), "ünï #people/vip, #personal ");
        assert_eq!(
            chip.get_attribute(&txn, "tag")
                .map(|v| v.to_string(&txn))
                .as_deref(),
            Some("people")
        );
        assert_eq!(code_text.get_string(&txn), "#person");
    }
}
