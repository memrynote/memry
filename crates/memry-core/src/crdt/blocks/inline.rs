//! Split from `blocks.rs` along its existing seams; see `mod.rs`.

#[allow(unused_imports)]
use super::*;

/// The block's own inline content, flattened into runs.
pub(super) fn inline_runs<T: ReadTxn>(element: &XmlElementRef, txn: &T) -> Vec<InlineRun> {
    let mut runs = Vec::new();
    collect_runs(element, txn, &[], &mut runs);
    runs
}

pub(super) fn collect_runs<T: ReadTxn>(
    element: &XmlElementRef,
    txn: &T,
    inherited: &[String],
    runs: &mut Vec<InlineRun>,
) {
    for child in element.children(txn) {
        match child {
            XmlOut::Text(text) => {
                for mut run in runs_of_text(&text, txn) {
                    run.marks = merge(inherited, &run.marks);
                    if !run.text.is_empty() {
                        runs.push(run);
                    }
                }
            }
            XmlOut::Element(inner) => {
                let tag = inner.tag().clone();
                let name: &str = tag.as_ref();
                if !is_inline_node(name) {
                    // A nested block. It contributes its own entry, not this
                    // block's text — folding it in would merge two paragraphs.
                    continue;
                }
                let mut marks = inherited.to_vec();
                marks.push(name.to_owned());
                // The node's own attributes, under its tag. A wiki link's
                // `displayAs` and a date mention's payload live here and
                // nowhere else — `target` carries one of them and would drop
                // the rest.
                let attrs = node_attrs(&inner, txn, name);
                let target = inline_target(&inner, txn);
                let before = runs.len();
                collect_runs(&inner, txn, &marks, runs);
                for run in runs[before..].iter_mut() {
                    if run.target.is_none() {
                        run.target = target.clone();
                    }
                    for (key, value) in &attrs {
                        // An inner node wins over its container, the way an
                        // inner mark does.
                        run.mark_attrs
                            .entry(key.clone())
                            .or_insert_with(|| value.clone());
                    }
                }
                // An inline node with no text of its own — an image, a
                // checkbox — is still a run, or the shell never hears about it.
                if runs.len() == before {
                    runs.push(InlineRun {
                        text: String::new(),
                        marks,
                        mark_attrs: attrs,
                        target,
                    });
                }
            }
            XmlOut::Fragment(_) => {}
        }
    }
}

/// Where an inline node points, by the attribute its own type uses.
pub(super) fn inline_target<T: ReadTxn>(element: &XmlElementRef, txn: &T) -> Option<String> {
    for name in ["target", "href", "url", "tag", "date", "src", "noteId"] {
        if let Some(value) = attribute(element, txn, name) {
            return Some(value);
        }
    }
    None
}

/// An inline node's attributes, keyed `tag.attribute`.
pub(super) fn node_attrs<T: ReadTxn>(
    element: &XmlElementRef,
    txn: &T,
    tag: &str,
) -> HashMap<String, String> {
    element
        .attributes(txn)
        .map(|(name, value)| (format!("{tag}.{name}"), value.to_string(txn)))
        .collect()
}

/// One `XmlText`'s deltas, as runs. Marks are y-prosemirror's text attributes.
pub(super) fn runs_of_text<T: ReadTxn>(text: &XmlTextRef, txn: &T) -> Vec<InlineRun> {
    let mut runs = Vec::new();
    for chunk in text.diff(txn, YChange::identity) {
        let mut marks: Vec<String> = Vec::new();
        let mut mark_attrs: HashMap<String, String> = HashMap::new();
        if let Some(attrs) = chunk.attributes {
            // Sorted, for the same reason `props_of` sorts: a Yjs map's
            // iteration order is not stable across runs, and a shell diffing
            // two reads of one block must not see a change that is not one.
            let mut entries: Vec<(&str, &Any)> = attrs
                .iter()
                .map(|(key, value)| (key.as_ref(), value))
                .collect();
            entries.sort_by(|left, right| left.0.cmp(right.0));
            for (key, value) in entries {
                let mark = mark_name(key);
                flatten_mark_attrs(mark, value, &mut mark_attrs);
                if !marks.iter().any(|seen| seen == mark) {
                    marks.push(mark.to_owned());
                }
            }
        }
        let target = link_target(&marks, &mark_attrs);
        runs.push(InlineRun {
            text: unquote(&chunk.insert.to_string(txn)),
            marks,
            mark_attrs,
            target,
        });
    }
    runs
}

/// The mark a y-prosemirror text attribute stands for.
///
/// y-prosemirror keys a mark that does not exclude itself as
/// `name--<8 character hash>` so two of them can overlap on one run
/// (`sync-plugin.js`'s `hashedMarkNameRegex`), and strips the suffix again on
/// the way back with `yattr2markname`. A reader that skipped that step would
/// hand the shell `textColor--AbCd1234`, which matches nothing.
pub(super) fn mark_name(attribute: &str) -> &str {
    let Some((name, hash)) = attribute.rsplit_once("--") else {
        return attribute;
    };
    let is_hash = hash.len() == 8
        && hash
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='));
    // An empty name is what the reference regex would produce for a bare
    // `--AbCd1234`; the original key is more use to a shell than nothing.
    if is_hash && !name.is_empty() {
        name
    } else {
        attribute
    }
}

/// One mark's attribute value, flattened into `out`. See [`InlineRun::mark_attrs`].
pub(super) fn flatten_mark_attrs(mark: &str, value: &Any, out: &mut HashMap<String, String>) {
    match value {
        // A boolean style carries an empty attribute object. Its name is the
        // whole fact, and an entry saying nothing would only invite a shell to
        // read it.
        Any::Map(entries) if entries.is_empty() => {}
        Any::Map(entries) if entries.len() == 1 && entries.contains_key(STRING_VALUE_ATTR) => {
            if let Some(inner) = entries.get(STRING_VALUE_ATTR) {
                out.insert(mark.to_owned(), scalar(inner));
            }
        }
        Any::Map(entries) => {
            for (key, inner) in entries.iter() {
                // ProseMirror spells "this attribute is not set" as null, and
                // a link's unused `target` and `rel` arrive that way on every
                // link in the document.
                if matches!(inner, Any::Null | Any::Undefined) {
                    continue;
                }
                out.insert(format!("{mark}.{key}"), scalar(inner));
            }
        }
        Any::Null | Any::Undefined => {}
        other => {
            out.insert(mark.to_owned(), scalar(other));
        }
    }
}

/// One attribute value as a string; a structure keeps its JSON rather than
/// being flattened away.
pub(super) fn scalar(value: &Any) -> String {
    match value {
        Any::String(text) => text.to_string(),
        Any::Map(_) | Any::Array(_) => {
            let mut json = String::new();
            value.to_json(&mut json);
            json
        }
        other => other.to_string(),
    }
}

/// A link mark's address, which is an attribute rather than the mark's value.
pub(super) fn link_target(marks: &[String], attrs: &HashMap<String, String>) -> Option<String> {
    marks
        .iter()
        .filter(|mark| *mark == "link" || *mark == "href")
        .find_map(|mark| {
            attrs
                .get(&format!("{mark}.href"))
                .or_else(|| attrs.get(mark))
                .cloned()
        })
}

/// `yrs::Out`'s `to_string` quotes a string value; the text itself is wanted.
pub(super) fn unquote(value: &str) -> String {
    value
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
        .map(|inner| inner.replace("\\\"", "\""))
        .unwrap_or_else(|| value.to_owned())
}

pub(super) fn merge(inherited: &[String], own: &[String]) -> Vec<String> {
    let mut marks = inherited.to_vec();
    let mut seen: HashMap<&str, ()> = inherited.iter().map(|mark| (mark.as_str(), ())).collect();
    for mark in own {
        if seen.insert(mark.as_str(), ()).is_none() {
            marks.push(mark.clone());
        }
    }
    marks
}
