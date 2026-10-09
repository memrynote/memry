//! Inbound `[[wiki link]]` repair when a note is renamed or moved, or a folder
//! above it is (#1711).
//!
//! A link names its note by title or by vault path, never by id, so a rename
//! disconnects every `[[Old Title]]` and a move every `[[Folder/Old]]`.
//! Desktop's `rewriteWikiLinksToNote` (`packages/shared/src/rewrite-wiki-links.ts`)
//! decides which links follow; [`rewrite_target`] is the same decision:
//!
//!   * a title-form link follows the title, and a path-form link the path;
//!   * a leading `/` and everything from the first `#` on are kept
//!     byte-for-byte, and the node's `alias` is never touched;
//!   * `[[Sprint #4]]` follows a renamed `Sprint #4` only when no other note
//!     is titled `Sprint`, because split resolution would have won;
//!   * `[[#Heading]]` names the note it sits in and is never rewritten.
//!
//! **Sources are found by scanning bodies, not `note_links`.** The index is a
//! cache in `index.db`, which a writer never opens and which lags any write
//! made since the last reindex. The update log in `data.db` is the authority,
//! so every live markdown note and journal is a candidate, and a byte search
//! of its log for the old title or path skips the ones that cannot hold a
//! matching link before any document is replayed: a link target is one
//! attribute string, stored whole in some update.
//!
//! **Only the `target` attribute is set**, on the existing `wikiLink` element,
//! through the same author-and-append path every body edit takes
//! ([`body_write`]), so the update is logged and queued for the other devices
//! and a concurrent edit to the same paragraph survives the merge.
//!
//! The rename already committed, so a source that fails is reported on
//! stderr and skipped: repairing nine links of ten beats failing a rename.

use rusqlite::{Connection, OptionalExtension as _, params};
use yrs::{ReadTxn as _, TransactionMut, Xml as _, XmlElementRef, XmlFragment as _, XmlOut};

use crate::api::errors::StorageError;
use crate::crdt::errors::CrdtError;
use crate::crdt::{BODY_FRAGMENT, update_log};
use crate::domain::{body_write, journal, wiki_target};

use super::failed;

/// What a link can name a note by.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LinkNames {
    pub title: String,
    /// `None` is the vault root.
    pub folder: Option<String>,
    /// Only a markdown note has a path stem a link spells: an attachment's
    /// extension is not projected, so its path form cannot be rebuilt.
    pub markdown: bool,
}

impl LinkNames {
    /// The names a live note has now, or `None` when there is no such note.
    pub(crate) fn of(conn: &Connection, note_id: &str) -> Result<Option<Self>, StorageError> {
        conn.query_row(
            "SELECT title, folder_path, file_type FROM notes \
             WHERE id = ?1 AND deleted_at IS NULL",
            params![note_id],
            |row| {
                Ok(Self {
                    title: row.get(0)?,
                    folder: row
                        .get::<_, Option<String>>(1)?
                        .filter(|folder| !folder.is_empty()),
                    markdown: row.get::<_, String>(2)? == "markdown",
                })
            },
        )
        .optional()
        .map_err(failed)
    }

    /// Desktop's `noteLinkStem`: the vault-relative path without `.md`, or
    /// empty when the note has no path form to follow.
    fn path_stem(&self) -> String {
        match (&self.folder, self.markdown) {
            (_, false) => String::new(),
            (Some(folder), true) => format!("{folder}/{}", self.title),
            (None, true) => self.title.clone(),
        }
    }
}

/// One note whose names changed.
#[derive(Debug, Clone)]
pub(crate) struct Renamed {
    pub note_id: String,
    pub from: LinkNames,
    pub to: LinkNames,
}

/// The names a link is compared against, once per pass.
struct Rule<'a> {
    note_id: &'a str,
    from_title: String,
    to_title: String,
    from_stem: String,
    to_stem: String,
}

impl Rule<'_> {
    fn title_changed(&self) -> bool {
        !self.from_title.is_empty() && self.from_title != self.to_title
    }

    fn stem_changed(&self) -> bool {
        !self.from_stem.is_empty() && self.from_stem != self.to_stem
    }
}

/// Re-points every inbound link to the `renamed` notes at their new names.
/// Never fails: see the module comment.
pub(crate) fn rewrite_inbound(
    conn: &Connection,
    renamed: &[Renamed],
    device_id: &str,
    now_ms: i64,
) {
    let rules: Vec<Rule<'_>> = renamed
        .iter()
        .map(|note| Rule {
            note_id: &note.note_id,
            from_title: note.from.title.trim().to_owned(),
            to_title: note.to.title.clone(),
            from_stem: note.from.path_stem(),
            to_stem: note.to.path_stem(),
        })
        .filter(|rule| rule.title_changed() || rule.stem_changed())
        .collect();
    if rules.is_empty() {
        return;
    }
    let needles: Vec<String> = rules
        .iter()
        .flat_map(|rule| {
            [
                rule.title_changed().then(|| rule.from_title.to_lowercase()),
                rule.stem_changed().then(|| rule.from_stem.to_lowercase()),
            ]
        })
        .flatten()
        .collect();

    let sources = match sources(conn) {
        Ok(sources) => sources,
        Err(error) => {
            eprintln!("memry-core: inbound wiki-link rewrite skipped, sources unreadable: {error}");
            return;
        }
    };
    for (id, item_type) in sources {
        if let Err(error) =
            rewrite_source(conn, &id, item_type, &rules, &needles, device_id, now_ms)
        {
            eprintln!(
                "memry-core: inbound wiki-link rewrite skipped {item_type}/{id} after a rename or move: {error}"
            );
        }
    }
}

/// Every live body a link can sit in: markdown notes and journal days.
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
                super::ITEM_TYPE
            } else {
                journal::ITEM_TYPE
            };
            Ok((row.get::<_, String>(0)?, kind))
        })
        .map_err(failed)?;
    rows.collect::<Result<_, _>>().map_err(failed)
}

fn rewrite_source(
    conn: &Connection,
    id: &str,
    item_type: &str,
    rules: &[Rule<'_>],
    needles: &[String],
    device_id: &str,
    now_ms: i64,
) -> Result<(), CrdtError> {
    let plan = update_log::load_plan(conn, id)?;
    let may_link = plan.blobs().iter().any(|blob| {
        let text = String::from_utf8_lossy(blob).to_lowercase();
        needles.iter().any(|needle| text.contains(needle.as_str()))
    });
    if !may_link {
        return Ok(());
    }
    let Some(update) = body_write::author_with(conn, id, device_id, |document| {
        document.write(|txn| rewrite_document(conn, txn, rules))?
    })?
    else {
        return Ok(());
    };
    let tx = conn.unchecked_transaction().map_err(failed)?;
    body_write::append_in(&tx, item_type, id, &update, now_ms)?;
    tx.commit().map_err(failed)?;
    Ok(())
}

/// Sets `target` on every `wikiLink` element a rule re-points.
fn rewrite_document(
    conn: &Connection,
    txn: &mut TransactionMut<'_>,
    rules: &[Rule<'_>],
) -> Result<(), CrdtError> {
    let Some(fragment) = txn.get_xml_fragment(BODY_FRAGMENT) else {
        return Ok(());
    };
    let mut links = Vec::new();
    for child in fragment.children(txn) {
        if let XmlOut::Element(element) = child {
            collect_links(txn, &element, &mut links);
        }
    }
    for (element, target) in links {
        let next = rules
            .iter()
            .map(|rule| rewrite_target(&target, rule, |title| claimed(conn, title, rule.note_id)))
            .find_map(Result::transpose)
            .transpose()?;
        if let Some(next) = next {
            element.insert_attribute(txn, "target", next);
        }
    }
    Ok(())
}

fn collect_links(
    txn: &TransactionMut<'_>,
    element: &XmlElementRef,
    out: &mut Vec<(XmlElementRef, String)>,
) {
    if element.tag().as_ref() == "wikiLink" {
        if let Some(target) = element.get_attribute(txn, "target") {
            out.push((element.clone(), target.to_string(txn)));
        }
        return;
    }
    for child in element.children(txn) {
        if let XmlOut::Element(inner) = child {
            collect_links(txn, &inner, out);
        }
    }
}

/// Whether a live note other than `renamed` holds `title` now.
fn claimed(conn: &Connection, title: &str, renamed: &str) -> Result<bool, StorageError> {
    Ok(wiki_target::by_path_or_title(conn, title)?.is_some_and(|id| id != renamed))
}

/// The target `target` becomes under `rule`, or `None` when it does not name
/// the renamed note. `other_claims` answers desktop's
/// `otherNoteWithTitleExists`.
fn rewrite_target(
    target: &str,
    rule: &Rule<'_>,
    other_claims: impl Fn(&str) -> Result<bool, StorageError>,
) -> Result<Option<String>, StorageError> {
    let raw = target.trim();
    let (note, heading) = wiki_target::split(raw);
    if note.is_empty() {
        return Ok(None);
    }
    let suffix = raw.find('#').map_or("", |at| &raw[at..]);

    if let Some(stem) = wiki_target::path_stem(note) {
        if !rule.stem_changed() {
            return Ok(None);
        }
        let lead = if note.starts_with('/') { "/" } else { "" };
        // Desktop compares the stem whole, so `[[Folder/Note.md]]` goes stale
        // there. It resolves to the same note here, so it follows, `.md` kept.
        let md_at = stem
            .len()
            .checked_sub(3)
            .filter(|&at| stem.is_char_boundary(at) && stem[at..].eq_ignore_ascii_case(".md"));
        let (bare, ext) = match md_at {
            Some(at) if !same(stem, &rule.from_stem) => stem.split_at(at),
            _ => (stem, ""),
        };
        return Ok(
            same(bare, &rule.from_stem).then(|| format!("{lead}{}{ext}{suffix}", rule.to_stem))
        );
    }

    if !rule.title_changed() {
        return Ok(None);
    }
    if heading.is_some() {
        if same(note, &rule.from_title) {
            return Ok(Some(format!("{}{suffix}", rule.to_title)));
        }
        if same(raw, &rule.from_title) && !other_claims(note)? {
            return Ok(Some(rule.to_title.clone()));
        }
        return Ok(None);
    }
    Ok(same(raw, &rule.from_title).then(|| rule.to_title.clone()))
}

fn same(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(from: (&str, Option<&str>), to: (&str, Option<&str>)) -> Rule<'static> {
        let names = |(title, folder): (&str, Option<&str>)| LinkNames {
            title: title.to_owned(),
            folder: folder.map(str::to_owned),
            markdown: true,
        };
        let (from, to) = (names(from), names(to));
        Rule {
            note_id: "renamed",
            from_title: from.title.clone(),
            to_title: to.title.clone(),
            from_stem: from.path_stem(),
            to_stem: to.path_stem(),
        }
    }

    fn rewrite(target: &str, rule: &Rule<'_>, claimed: bool) -> Option<String> {
        rewrite_target(target, rule, |_| Ok(claimed)).expect("no storage")
    }

    #[test]
    fn the_cases_desktop_pins() {
        let renamed = rule(("Old", Some("Work")), ("New", Some("Work")));
        assert_eq!(rewrite("old", &renamed, false).as_deref(), Some("New"));
        assert_eq!(
            rewrite("Old#H1#H2", &renamed, false).as_deref(),
            Some("New#H1#H2")
        );
        assert_eq!(rewrite("#Old", &renamed, false), None);
        assert_eq!(rewrite("Older", &renamed, false), None);
        assert_eq!(
            rewrite("/work/old#Goals", &renamed, false).as_deref(),
            Some("/Work/New#Goals")
        );
        assert_eq!(
            rewrite("Work/Old.MD", &renamed, false).as_deref(),
            Some("Work/New.MD")
        );
        assert_eq!(rewrite("Home/Old", &renamed, false), None);
    }

    #[test]
    fn a_hash_title_follows_only_when_split_resolution_would_miss() {
        let renamed = rule(("Sprint #4", None), ("Sprint #5", None));
        assert_eq!(
            rewrite("Sprint #4", &renamed, false).as_deref(),
            Some("Sprint #5")
        );
        assert_eq!(rewrite("Sprint #4", &renamed, true), None);
    }

    #[test]
    fn a_move_leaves_title_links_alone() {
        let moved = rule(("Plan", Some("Work")), ("Plan", Some("Archive")));
        assert_eq!(rewrite("Plan", &moved, false), None);
        assert_eq!(
            rewrite("Work/Plan", &moved, false).as_deref(),
            Some("Archive/Plan")
        );
    }
}
