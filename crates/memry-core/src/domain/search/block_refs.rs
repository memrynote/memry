//! References into another note's blocks: `memry-portal` fences (`portal_refs`) and links to
//! a block (`block_link_refs`), derived from a note's document by the reindex beside its wiki
//! links, and the edges a graph or a usage list reads back.
//!
//! Electron's `portal-refs` and `block-link-refs` projectors are the reference
//! (`portal-fences.ts` `derivePortalRefs`, `wiki-target.ts` `extractBlockLinks`). They read the
//! file's markdown; this reads the same constructs from the document's blocks:
//!
//! - A portal is a `codeBlock` whose `language` is `memry-portal`. Its `ordinal` counts every
//!   such block in document order, the unreadable ones too, so an edit elsewhere keeps it.
//!   A blocks portal has a row per root and per shown child, a note or search portal one row.
//!   Shown children are taken in anchor order, where Electron took the JSON's key order; `root`
//!   only keeps the rows apart. A source that cannot be a note id gets no rows (Electron kept
//!   them), so one long string is never stored once per anchor.
//! - A link to a block is a wiki target (a `wikiLink` node, or `[[…]]` left as
//!   text) or a link mark whose address is a note (`memry://note/<id>` or a path with no
//!   scheme), with a `#^anchor`. Its note half is stored as first written, keyed by
//!   [`name_key`], and resolved when read, the way a wiki link resolves.

use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet};

use rusqlite::{Connection, params};

use crate::api::errors::StorageError;
use crate::crdt::blocks::Block;
use crate::domain::notes::names::name_key;
use crate::domain::wiki_target::{self, WikiNames};
use crate::markdown::shared::critic_markup::uri::decode_uri_component;
use crate::portal::{PortalOpen, PortalTarget, parse_portal_definition};

use super::failed;

const PORTAL_LANGUAGE: &str = "memry-portal";
const MEMRY_NOTE: &str = "memry://note/";
const MAX_NOTE_ID: usize = 128;

thread_local! {
    static STEPS: Cell<usize> = const { Cell::new(0) };
}

/// Blocks, runs and portal anchors this thread's derivations visited, for the complexity tests.
#[doc(hidden)]
pub fn steps() -> usize {
    STEPS.with(Cell::get)
}

fn step(n: usize) {
    STEPS.with(|steps| steps.set(steps.get() + n));
}

/// One readable `memry-portal` fence of a host note: a `portal_refs` row per anchor, or one
/// row with no anchor for a note or search portal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PortalRef {
    pub ordinal: u32,
    /// `note`, `blocks` or `search`.
    pub kind: &'static str,
    /// `None` for a search portal.
    pub source: Option<String>,
    /// A blocks portal's roots, then the children it shows; empty for the other kinds.
    pub anchors: Vec<String>,
}

/// One link to a block: the note half as written (an id link as `memry://note/<id>`) and the
/// anchor without its caret.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockLink {
    pub target: String,
    pub anchor: String,
}

/// What a body refers to in other notes' blocks.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BlockRefs {
    pub portals: Vec<PortalRef>,
    pub links: Vec<BlockLink>,
}

/// The portals and block links in a body's blocks, in document order, each link once per
/// target key and anchor.
pub fn derive(blocks: &[Block]) -> BlockRefs {
    let mut refs = BlockRefs::default();
    let mut ordinal = 0;
    let mut seen = BTreeSet::new();
    for block in blocks {
        step(1);
        if is_portal(block) {
            portal_rows(block, ordinal, &mut refs.portals);
            ordinal += 1;
            continue;
        }
        for target in wiki_targets(block).chain(note_addresses(block)) {
            if let Some(link) = block_link(&target)
                && let Some(key) = name_key(&link.target)
                && seen.insert((key, link.anchor.clone()))
            {
                refs.links.push(link);
            }
        }
    }
    refs
}

fn is_portal(block: &Block) -> bool {
    block.kind == "codeBlock"
        && block
            .props
            .iter()
            .any(|prop| prop.name == "language" && prop.value == PORTAL_LANGUAGE)
}

fn portal_rows(block: &Block, ordinal: u32, rows: &mut Vec<PortalRef>) {
    step(block.inline.len());
    let text: String = block.inline.iter().map(|run| run.text.as_str()).collect();
    let Some(definition) = parse_portal_definition(&text) else {
        return;
    };
    let (kind, source, anchors) = match definition.target {
        PortalTarget::Search => ("search", None, Vec::new()),
        PortalTarget::Note { note, .. } => ("note", Some(note), Vec::new()),
        PortalTarget::Blocks { note, blocks, open } => {
            // A child the portal shows is on screen in the host as much as a root is, so a
            // delete of it must find the host. Hide lists are exclusions and add nothing.
            let open: BTreeMap<_, _> = open.into_iter().collect();
            let shown = open.into_values().flat_map(|entry| match entry {
                PortalOpen::Show(ids) => ids,
                PortalOpen::Hide(_) => Vec::new(),
            });
            let mut seen = BTreeSet::new();
            let anchors = blocks
                .into_iter()
                .chain(shown)
                .filter(|anchor| {
                    step(1);
                    seen.insert(anchor.clone())
                })
                .collect();
            ("blocks", Some(note), anchors)
        }
    };
    // A source no note id can be (`NoteIdSchema`, chapter 07) names no note: its rows would
    // only repeat a long string once per anchor.
    if source.as_deref().is_some_and(|id| !is_note_id(id)) {
        return;
    }
    rows.push(PortalRef {
        ordinal,
        kind,
        source,
        anchors,
    });
}

/// `/^[a-zA-Z0-9_-]+$/`, at most 128 characters.
fn is_note_id(id: &str) -> bool {
    (1..=MAX_NOTE_ID).contains(&id.len())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

/// Wiki targets: the `wikiLink` nodes' and the literal `[[…]]` runs'. A `linkMention` is a URL
/// mention (Electron writes it as `((mention:<url>))`) and `extractBlockLinks` never reads it.
fn wiki_targets(block: &Block) -> impl Iterator<Item = String> + '_ {
    let nodes = block.inline.iter().filter_map(|run| {
        step(1);
        let is_link = run.marks.iter().any(|mark| mark == "wikiLink");
        run.target.clone().filter(|_| is_link)
    });
    nodes.chain(super::literal_links::targets(block))
}

/// Link marks whose address is another note: `memry://note/<id>` or a path with no scheme.
fn note_addresses(block: &Block) -> impl Iterator<Item = String> + '_ {
    block.inline.iter().filter_map(|run| {
        let wiki = run
            .marks
            .iter()
            .any(|mark| mark == "wikiLink" || mark == "linkMention");
        if wiki || !run.marks.iter().any(|mark| mark == "link") {
            return None;
        }
        let href = run.target.as_deref()?;
        step(href.len());
        let address = decode_uri_component(href).unwrap_or_else(|| href.to_owned());
        is_note_address(&address).then_some(address)
    })
}

fn is_note_address(address: &str) -> bool {
    starts_with_memry_note(address) || !has_scheme(address)
}

/// `^[a-z][a-z0-9+.-]*:`, case-insensitive.
fn has_scheme(address: &str) -> bool {
    let mut chars = address.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars
            .find(|c| !(c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-')))
            .is_some_and(|c| c == ':')
}

fn starts_with_memry_note(text: &str) -> bool {
    text.get(..MEMRY_NOTE.len())
        .is_some_and(|head| head.eq_ignore_ascii_case(MEMRY_NOTE))
}

/// `Note#^anchor` as a link to a block, with an id link's query and path dropped.
fn block_link(target: &str) -> Option<BlockLink> {
    let (note, heading) = wiki_target::split(target);
    let anchor = heading?.strip_prefix('^')?.trim();
    if note.is_empty() || anchor.is_empty() {
        return None;
    }
    Some(BlockLink {
        target: canonical_note(note),
        anchor: anchor.to_owned(),
    })
}

/// `memry://note/<id>?label=…` names the note `<id>`; any other half stays as written.
fn canonical_note(note: &str) -> String {
    if starts_with_memry_note(note) {
        let id: String = note[MEMRY_NOTE.len()..]
            .chars()
            .take_while(|c| !matches!(c, '/' | '?' | '#') && !c.is_whitespace())
            .collect();
        if !id.is_empty() {
            return format!("{MEMRY_NOTE}{id}");
        }
    }
    note.to_owned()
}

/// Drops `id`'s rows, as a host and as a linking note.
pub(super) fn clear(index: &Connection, id: &str) -> Result<(), StorageError> {
    for sql in [
        "DELETE FROM portal_refs WHERE host_note_id = ?1",
        "DELETE FROM block_link_refs WHERE source_note_id = ?1",
    ] {
        index.execute(sql, params![id]).map_err(failed)?;
    }
    Ok(())
}

/// Writes `id`'s rows from its blocks, after [`clear`].
pub(super) fn write(index: &Connection, id: &str, blocks: &[Block]) -> Result<(), StorageError> {
    let refs = derive(blocks);
    let mut portal = index
        .prepare_cached(
            "INSERT INTO portal_refs (host_note_id, ordinal, root, source_note_id, anchor, kind)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )
        .map_err(failed)?;
    for fence in refs.portals {
        let anchors = fence.anchors.iter().map(Some);
        let anchors: Vec<Option<&String>> = if fence.anchors.is_empty() {
            vec![None]
        } else {
            anchors.collect()
        };
        for (root, anchor) in (0_i64..).zip(anchors) {
            portal
                .execute(params![
                    id,
                    fence.ordinal,
                    root,
                    fence.source,
                    anchor,
                    fence.kind
                ])
                .map_err(failed)?;
        }
    }
    for link in refs.links {
        index
            .execute(
                "INSERT INTO block_link_refs (source_note_id, target_key, anchor, target)
                 VALUES (?1, ?2, ?3, ?4)",
                params![id, name_key(&link.target), link.anchor, link.target],
            )
            .map_err(failed)?;
    }
    Ok(())
}

/// A note's reference rows as its readers' usage lists see them: a portal's source, anchor and
/// fence, or a block link's note half and anchor.
pub(super) type UsageRows = BTreeSet<(bool, String, Option<String>, Option<u32>)>;

pub(super) fn usage_rows(index: &Connection, id: &str) -> Result<UsageRows, StorageError> {
    let mut statement = index
        .prepare_cached(
            "SELECT 1, source_note_id, anchor, ordinal FROM portal_refs
               WHERE host_note_id = ?1 AND source_note_id IS NOT NULL
             UNION ALL
             SELECT 0, target, anchor, NULL FROM block_link_refs WHERE source_note_id = ?1",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map(params![id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .map_err(failed)?;
    rows.collect::<Result<_, _>>().map_err(failed)
}

/// The notes whose usage moved between a note's rows `before` and `after`: a portal's source,
/// and the note a block link resolves to.
pub(super) fn usage_targets(
    names: &WikiNames,
    before: &UsageRows,
    after: &UsageRows,
) -> BTreeSet<String> {
    before
        .symmetric_difference(after)
        .filter_map(
            |(portal, to, ..)| match (portal, to.strip_prefix(MEMRY_NOTE)) {
                (true, _) => Some(to.clone()),
                (false, Some(id)) => Some(id.to_owned()),
                (false, None) => super::links::target_id(names, to),
            },
        )
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum BlockRefKind {
    /// A `memry-portal` fence shows the note, or `to_block` of it.
    Portal,
    /// A link to `to_block`.
    Link,
}

/// One note's reference into another note, or into one of its blocks.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct BlockRefEdge {
    pub from_note: String,
    pub to_note: String,
    /// The anchor, `None` for a portal that shows the whole note.
    pub to_block: Option<String>,
    pub kind: BlockRefKind,
}

/// Every edge whose target note this vault holds, once each, sorted. A search portal names
/// no note and is no edge. A row whose note was deleted since the last reindex is the
/// reindex's to drop; reading it here is not "this note refers".
pub fn edges(data: &Connection, index: &Connection) -> Result<Vec<BlockRefEdge>, StorageError> {
    let names = WikiNames::load(data)?;
    let mut statement = index
        .prepare(
            "SELECT host_note_id, source_note_id, anchor, 1 FROM portal_refs
               WHERE source_note_id IS NOT NULL
             UNION ALL
             SELECT source_note_id, target, anchor, 0 FROM block_link_refs",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .map_err(failed)?;
    let mut edges = BTreeSet::new();
    for row in rows {
        let (from_note, to, to_block, portal): (String, String, Option<String>, bool) =
            row.map_err(failed)?;
        let (kind, to_note) = match (portal, to.strip_prefix(MEMRY_NOTE)) {
            (true, _) => (BlockRefKind::Portal, Some(to)),
            (false, Some(id)) => (BlockRefKind::Link, Some(id.to_owned())),
            (false, None) => (BlockRefKind::Link, super::links::target_id(&names, &to)),
        };
        if let Some(to_note) = to_note.filter(|id| names.holds(id) && names.holds(&from_note)) {
            edges.insert(BlockRefEdge {
                from_note,
                to_note,
                to_block,
                kind,
            });
        }
    }
    Ok(edges.into_iter().collect())
}
