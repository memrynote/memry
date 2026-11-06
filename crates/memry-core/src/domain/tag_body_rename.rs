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
//! A new name the inline grammar cannot read back (`my project`, `2024`)
//! leaves the bodies alone, as desktop's `isInlineTagName` check does.
//!
//! [`rewrite_markdown`] is the same rewrite over a markdown file's body, for
//! desktop, whose note files hold the text.

use std::cell::Cell;

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
use crate::domain::{body_tags, body_write, journal, notes, reads, tags};

pub(crate) fn renamed_tag(tag: &str, from: &str, to: &str) -> Option<String> {
    let from = tags::tag_key(from);
    if tags::fold(tag) == from {
        return Some(to.trim().to_owned());
    }
    // Segment-wise, never at `from.len()`: the fold can change length.
    let depth = from.split('/').count();
    let segments: Vec<&str> = tag.split('/').collect();
    (segments.len() > depth && tags::fold(&segments[..depth].join("/")) == from)
        .then(|| format!("{}/{}", to.trim(), segments[depth..].join("/")))
}

/// Whether `name` can be written as an inline `#tag` (desktop `isInlineTagName`).
pub fn is_inline_tag_name(name: &str) -> bool {
    let word = |segment: &str, first_alpha: bool| {
        let mut chars = segment.chars();
        chars
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || (!first_alpha && c.is_ascii_digit()))
            && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    };
    let mut segments = name.split('/');
    segments.next().is_some_and(|head| word(head, true)) && segments.all(|s| word(s, false))
}

thread_local! {
    static STEPS: Cell<usize> = const { Cell::new(0) };
}

fn step(by: usize) {
    STEPS.with(|steps| steps.set(steps.get() + by));
}

/// The bytes [`rewrite_markdown`] has looked at on this thread, for the complexity tests.
#[doc(hidden)]
pub fn markdown_steps() -> usize {
    STEPS.with(Cell::get)
}

/// `content`, a markdown body, with every inline `#tag` that names `from` or a `from/…` child
/// renamed to `to` (desktop `rewriteInlineTagsInMarkdown`), or `None` when nothing changed or
/// `to` cannot be read back as an inline tag. Code (`/```[\s\S]*?```|`[^`]+`/g`) keeps its
/// bytes, and a `#tag` right after code reads the character before the code, as the extractor
/// that indexes the body reads it (it removes the code first).
pub fn rewrite_markdown(content: &str, from: &str, to: &str) -> Option<String> {
    if !is_inline_tag_name(to.trim()) {
        return None;
    }
    let mut out = String::with_capacity(content.len());
    let mut before = None;
    let mut last = 0;
    for (start, end) in code_spans(content) {
        let plain = &content[last..start];
        rewrite_plain(plain, before, from, to, &mut out);
        out.push_str(&content[start..end]);
        before = plain.chars().last().or(before);
        last = end;
    }
    rewrite_plain(&content[last..], before, from, to, &mut out);
    (out != content).then_some(out)
}

fn rewrite_plain(text: &str, before: Option<char>, from: &str, to: &str, out: &mut String) {
    step(text.len());
    let mut at = 0;
    for (start, end) in body_tags::tag_spans(text, before) {
        if let Some(next) = renamed_tag(&text[start..end], from, to) {
            out.push_str(&text[at..start]);
            out.push_str(&next);
            at = end;
        }
    }
    out.push_str(&text[at..]);
}

/// The byte spans of desktop's code pattern, a fence (three backticks to the next three) tried
/// before an inline span (a backtick, at least one other character, a backtick), left to right.
/// Linear: a match is jumped over, and a search for a closer fails at most a few times, at the
/// end of the text, since any later opener would have been that closer.
fn code_spans(text: &str) -> Vec<(usize, usize)> {
    const FENCE: &str = "```";
    let mut spans = Vec::new();
    let mut at = 0;
    while let Some(offset) = text[at..].find('`') {
        step(offset + 1);
        at += offset;
        let closer = match text[at..].starts_with(FENCE) {
            true => text[at + FENCE.len()..]
                .find(FENCE)
                .map(|close| at + FENCE.len() + close + FENCE.len()),
            false => None,
        };
        let closer = closer.or_else(|| match text[at + 1..].find('`') {
            Some(close) if close > 0 => Some(at + close + 2),
            _ => None,
        });
        match closer {
            Some(end) => {
                step(end - at);
                spans.push((at, end));
                at = end;
            }
            None => at += 1,
        }
    }
    spans
}

pub(crate) fn rewrite_bodies(
    conn: &Connection,
    from: &str,
    to: &str,
    device_id: &str,
    now_ms: i64,
) {
    if !is_inline_tag_name(to.trim()) {
        return;
    }
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
    // A locked note keeps its tags, as Electron's `keepLockedNoteTags` keeps them.
    if body_write::is_locked(conn, id)? {
        return Ok(());
    }
    let plan = update_log::load_plan(conn, id)?;
    let may_hold = plan
        .blobs()
        .iter()
        .any(|blob| tags::fold(&String::from_utf8_lossy(blob)).contains(needle));
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
    // `note_body_tags` caches the body's parse; refresh it with the body so
    // tag counts follow the rename before the next search reindex.
    if let Some(blocks) = reads::note_blocks(&tx, id)? {
        body_tags::write(&tx, id, &body_tags::extract(&blocks))?;
    }
    tx.commit().map_err(failed)?;
    Ok(())
}

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
    fn inline_tag_names_match_desktop() {
        for name in ["work", "a/b2", "x_y-z", "Area/2024"] {
            assert!(is_inline_tag_name(name), "{name}");
        }
        for name in ["my project", "2024", "a/", "/a", "a//b", "-a", "ünï", ""] {
            assert!(!is_inline_tag_name(name), "{name}");
        }
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

    fn rewritten(content: &str, from: &str, to: &str) -> String {
        rewrite_markdown(content, from, to).unwrap_or_else(|| content.to_owned())
    }

    /// A case's text pieces, each `true` when it is inline code; the old and new names; the text
    /// after the rename with the backticks out.
    type Case = (
        &'static [(&'static str, bool)],
        &'static str,
        &'static str,
        &'static str,
    );

    /// `packages/shared/src/inline-tag-rename-cases.ts` and `inline-tags.test.ts`, the markdown
    /// path: a code piece is inline code, and the case's text compares with the backticks out.
    #[test]
    fn rewrites_markdown_as_desktop_does() {
        let cases: [Case; 7] = [
            (
                &[("#person met #Person/VIP and #personal #person-x", false)],
                "person",
                "people",
                "#people met #people/VIP and #personal #person-x",
            ),
            (
                &[("mail@x#person a#person", false)],
                "person",
                "people",
                "mail@x#person a#person",
            ),
            (
                &[("see ", false), ("#person", true), (" and #person", false)],
                "person",
                "people",
                "see #person and #people",
            ),
            (
                &[("x ", false), ("code", true), ("#person", false)],
                "person",
                "people",
                "x code#people",
            ),
            (
                &[("x", false), ("code", true), ("#person", false)],
                "person",
                "people",
                "xcode#person",
            ),
            (
                &[("met #person/VIP today", false)],
                "person",
                "people",
                "met #people/VIP today",
            ),
            (
                &[("#WORK/Deep #work", false)],
                "Work",
                "job",
                "#job/Deep #job",
            ),
        ];
        for (pieces, from, to, expected) in cases {
            let markdown: String = pieces
                .iter()
                .map(|(text, code)| match code {
                    true => format!("`{text}`"),
                    false => (*text).to_owned(),
                })
                .collect();
            let got = rewritten(&markdown, from, to).replace('`', "");
            assert_eq!(got, expected, "{markdown}");
        }
        let content = "a#person `#person` #work\n```\n#person\n```\n#person";
        assert_eq!(
            rewritten(content, "person", "people"),
            "a#person `#person` #work\n```\n#person\n```\n#people"
        );
        let content = "x `code`#person y #person/a/b";
        assert_eq!(
            body_tags::extract_markdown(&rewritten(content, "person", "people")),
            ["people", "people/a/b"]
        );
        assert_eq!(rewrite_markdown("#person", "person", "my people"), None);
        assert_eq!(rewrite_markdown("no tags here", "person", "people"), None);
        assert_eq!(rewritten("#Person", "person", "person"), "#person");
    }

    #[test]
    fn the_markdown_rewrite_reads_each_byte_a_bounded_number_of_times() {
        // Runs of ticks and fences, and tags with no code: a search that started over from the
        // start of the text for each tick would read it once per tick.
        let n = 20_000;
        for text in [
            "```".repeat(n) + "#person",
            "`".repeat(n),
            "`a".repeat(n),
            "#person ".repeat(n),
        ] {
            memry_test_kit::assert_steps_at_most(
                "markdown tag rewrite",
                markdown_steps,
                6 * text.len() + 10,
                || {
                    rewrite_markdown(&text, "person", "people");
                },
            );
        }
    }

    mod properties {
        use memry_test_kit::{DEFAULT_CASES, proptest_config};
        use proptest::prelude::*;

        use super::*;

        fn markdown(alphabet: &'static str) -> impl Strategy<Value = String> {
            let pieces: Vec<&'static str> = alphabet.split(' ').collect();
            prop::collection::vec(prop::sample::select(pieces), 0..40)
                .prop_map(|pieces| pieces.iter().map(|piece| piece.replace('_', " ")).collect())
        }

        proptest! {
            #![proptest_config(proptest_config(DEFAULT_CASES))]

            /// With no code in the text, what the extractor reads after the rewrite is what it
            /// read before, each tag under `person` renamed.
            #[test]
            fn the_extractor_reads_the_renamed_tags(
                text in markdown("#person #Person/VIP #personal #per x _ \n a# #people/x é"),
            ) {
                let before = body_tags::extract_markdown(&text);
                let after = body_tags::extract_markdown(&rewritten(&text, "person", "people"));
                let expected = tags::dedupe(before.iter().map(|tag| {
                    renamed_tag(tag, "person", "people").unwrap_or_else(|| tag.clone())
                }));
                prop_assert_eq!(after, expected);
            }

            /// Code keeps its bytes, and the output grows by at most the new name per tag read.
            #[test]
            fn code_keeps_its_bytes_and_the_output_is_bounded(
                text in markdown("#person ` `` ``` x _ \n #Person/a é"),
            ) {
                let out = rewritten(&text, "person", "people-and-more");
                let code = |text: &str| -> Vec<String> {
                    code_spans(text).iter().map(|&(a, b)| text[a..b].to_owned()).collect()
                };
                prop_assert_eq!(code(&out), code(&text));
                let spans = body_tags::extract_markdown(&text).len().max(text.matches('#').count());
                prop_assert!(out.len() <= text.len() + spans * "people-and-more".len());
            }
        }
    }
}
