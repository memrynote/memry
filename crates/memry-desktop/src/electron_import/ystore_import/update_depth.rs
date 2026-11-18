//! A walk over a document's lib0 v1 updates that bounds what `yrs` 0.27.4 would do decoding
//! and integrating them, before it does. Four things in it are unsafe on bytes we did not
//! write:
//!
//! - `Any::decode` recurses once per nested array or map with no limit, so a few hundred
//!   kilobytes of `[[[[` overflow a 2 MiB stack and abort the process.
//! - Deleting a type deletes the types inside it by recursion (`TransactionMut::delete`,
//!   `ItemContent::gc`), so 20,000 nested arrays (123 KB) and a 6-byte delete abort it too.
//!   Type items nest through parent ids across a document's updates, so the walk tracks the
//!   nesting over all of them: an item named under a root is at depth 1, one whose parent is
//!   the type item `p` is at `p`'s depth plus one, and one placed by an origin takes the depth
//!   of the item it follows (else of the item it precedes), as `yrs` takes their parent. That
//!   tracker is a fast refusal, not the bound: `yrs` gives a clock to the first item that
//!   integrates, which the walk cannot predict, so the fold also runs each document on a
//!   stack sized from its type-item count ([`check`]'s result), which the nesting can never
//!   exceed, and refuses a document of more than [`MAX_TYPE_ITEMS`]. A later item that claims
//!   clocks an earlier different item already holds is refused too: the same item sent twice
//!   has the same origins at every clock, and a document whose updates disagree on an item is
//!   damaged or crafted.
//! - `read_string` takes the bytes with `from_utf8_unchecked`, so a string that is not UTF-8 is
//!   undefined behaviour.
//! - `read_var_i64` shifts an `i64` by up to 69 bits, which panics in a debug build.
//!
//! The walk reads the block section exactly as `Update::decode` (`update.rs`), `decode_block`
//! and `ItemContent::decode` (`block.rs`) read it, so on bytes `yrs` decodes it stops where `yrs`
//! stops. The delete set after the blocks holds no strings and no `Any`, so the walk ends at it.
//! Anything the walk cannot follow is refused: the fold then reports the document instead of
//! handing `yrs` bytes the walk did not vouch for.

use std::cell::Cell;
use std::collections::{BTreeMap, HashMap};

/// Deepest `Any` nesting accepted: the 128 levels `serde_json` allows the JSON strings of the
/// same update (`Any::from_json`). BlockNote's attribute values nest two or three levels.
pub const MAX_ANY_DEPTH: usize = 128;
/// Deepest type nesting accepted. A BlockNote body nests two types per list level (a block
/// group in a block container), so this is over 120 list levels, past the 100 the markdown
/// converter keeps (`memry_core::markdown::limits::MAX_NESTING_DEPTH`). Measured on a 2 MiB
/// stack (macOS, 17 Nov): a debug build of `yrs` deletes 1,024 levels and overflows at 1,536;
/// a release build deletes 5,000.
pub const MAX_TYPE_DEPTH: u32 = 256;
/// Most type items (blocks of type content, over all of a document's updates) accepted; the
/// fold sizes its stack from the count. A BlockNote block is three or four types, so this is
/// over 60,000 blocks ever written to one note. A note past it re-seeds from its markdown.
pub const MAX_TYPE_ITEMS: usize = 250_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// An `Any` nests deeper than [`MAX_ANY_DEPTH`], or a type deeper than [`MAX_TYPE_DEPTH`].
    TooDeep,
    /// More than [`MAX_TYPE_ITEMS`] type items.
    TooManyTypes,
    /// Not a v1 update this walk can follow (truncated, a bad tag, a string that is not UTF-8,
    /// an over-long varint, a clock past `u32::MAX`, two different items at one clock).
    Malformed,
}

const BLOCK_GC: u8 = 0;
const BLOCK_SKIP: u8 = 10;
const HAS_ORIGIN: u8 = 0b1000_0000;
const HAS_RIGHT_ORIGIN: u8 = 0b0100_0000;
const HAS_PARENT_SUB: u8 = 0b0010_0000;

const TYPE_REF_XML_ELEMENT: u8 = 3;

thread_local! {
    static STEPS: Cell<usize> = const { Cell::new(0) };
}

/// Blocks, `Any` values and type-depth resolutions visited on this thread, for the
/// complexity tests.
#[cfg(test)]
pub(crate) fn steps() -> usize {
    STEPS.with(Cell::get)
}

fn step() {
    STEPS.with(|s| s.set(s.get() + 1));
}

/// `Ok` with the number of type items when `yrs` can decode `updates` without deep recursion,
/// unchecked UTF-8 or a debug panic in its varint reader. Integrating them nests types at most
/// that many levels deep.
pub fn check(updates: &[&[u8]]) -> Result<usize, Refusal> {
    let mut tree = Tree::default();
    for update in updates {
        walk(update, &mut tree)?;
    }
    tree.check_depth()?;
    Ok(tree.type_items)
}

fn walk(update: &[u8], tree: &mut Tree) -> Result<(), Refusal> {
    let mut r = Reader { buf: update, at: 0 };
    let clients = r.var_u32()?;
    for _ in 0..clients {
        let blocks = r.var_u32()?;
        let client = r.var_u64()?;
        let mut clock = r.var_u32()?;
        for _ in 0..blocks {
            step();
            let len = block(&mut r, Id { client, clock }, tree)?;
            // `clock += block.len()`, which panics in a debug build past `u32::MAX`.
            clock = clock.checked_add(len).ok_or(Refusal::Malformed)?;
        }
    }
    Ok(())
}

/// One block; its clock length.
fn block(r: &mut Reader<'_>, id: Id, tree: &mut Tree) -> Result<u32, Refusal> {
    let info = r.u8()?;
    if matches!(info, BLOCK_SKIP | BLOCK_GC) {
        return r.var_u32();
    }
    let origin = if info & HAS_ORIGIN != 0 {
        Some(r.id()?)
    } else {
        None
    };
    let right = if info & HAS_RIGHT_ORIGIN != 0 {
        Some(r.id()?)
    } else {
        None
    };
    let mut parent = Parent::Unknown;
    if info & (HAS_ORIGIN | HAS_RIGHT_ORIGIN) == 0 {
        parent = if r.var_u32()? == 1 {
            r.string()?;
            Parent::Root
        } else {
            Parent::Type(r.id()?)
        };
        if info & HAS_PARENT_SUB != 0 {
            r.string()?;
        }
    }
    let (len, is_type) = content(r, info & 0b1111)?;
    if is_type {
        tree.type_items += 1;
        if tree.type_items > MAX_TYPE_ITEMS {
            return Err(Refusal::TooManyTypes);
        }
    }
    tree.insert(
        id,
        len,
        Node {
            origin,
            right,
            parent,
            is_type,
        },
    )?;
    Ok(len)
}

/// `ItemContent::decode`: the content's clock length (UTF-16 units for a string) and whether
/// it is a type.
fn content(r: &mut Reader<'_>, kind: u8) -> Result<(u32, bool), Refusal> {
    match kind {
        // Deleted: a length.
        1 => Ok((r.var_u32()?, false)),
        // JSON: `yrs` reads one string more than the length says (`while remaining >= 0`), and a
        // length past `i32::MAX` fails its reservation.
        2 => {
            let len = r.var_u32()?;
            if i32::try_from(len).is_err() {
                return Err(Refusal::Malformed);
            }
            for _ in 0..=len {
                r.string()?;
            }
            Ok((len + 1, false))
        }
        // Binary: a buffer.
        3 => r.buf().map(|_| (1, false)),
        // String.
        4 => {
            let utf16 = r.string()?.encode_utf16().count();
            Ok((u32::try_from(utf16).map_err(|_| Refusal::Malformed)?, false))
        }
        // Embed (a JSON string `serde_json` parses within its own depth limit).
        5 => r.string().map(|_| (1, false)),
        // Format: a key and a JSON string.
        6 => {
            r.string()?;
            r.string().map(|_| (1, false))
        }
        // Type: a type ref byte, and an XML element's name. Weak links (7) are off in this build
        // and fail the decode.
        7 => match r.u8()? {
            TYPE_REF_XML_ELEMENT => r.string().map(|_| (1, true)),
            0..=6 | 9 | 15 => Ok((1, true)),
            _ => Err(Refusal::Malformed),
        },
        // Any: a count of values.
        8 => {
            let len = r.var_u32()?;
            for _ in 0..len {
                any(r, 1)?;
            }
            Ok((len, false))
        }
        // Doc: a guid and the options as one `Any`.
        9 => {
            r.string()?;
            any(r, 1).map(|()| (1, false))
        }
        _ => Err(Refusal::Malformed),
    }
}

/// `Any::decode`, with the depth `yrs` would reach counted instead of recursed into.
fn any(r: &mut Reader<'_>, depth: usize) -> Result<(), Refusal> {
    step();
    if depth > MAX_ANY_DEPTH {
        return Err(Refusal::TooDeep);
    }
    match r.u8()? {
        120 | 121 | 126 | 127 => Ok(()),
        125 => r.var_i64(),
        124 => r.skip(4),
        122 | 123 => r.skip(8),
        119 => r.string().map(drop),
        116 => r.buf().map(drop),
        118 => {
            let len = r.var_u64()?;
            for _ in 0..len {
                r.string()?;
                any(r, depth + 1)?;
            }
            Ok(())
        }
        117 => {
            let len = r.var_u64()?;
            for _ in 0..len {
                any(r, depth + 1)?;
            }
            Ok(())
        }
        _ => Err(Refusal::Malformed),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Id {
    client: u64,
    clock: u32,
}

/// Where `decode_block` says an item lives, when it has no origin to copy it from.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Parent {
    /// Placed by an origin: the parent is the origin's (`TypePtr::Unknown`).
    Unknown,
    /// A named root type.
    Root,
    /// The type item with this id.
    Type(Id),
}

#[derive(Clone, Copy)]
struct Node {
    origin: Option<Id>,
    right: Option<Id>,
    parent: Parent,
    is_type: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Depth {
    Unvisited,
    InProgress,
    /// `None`: `yrs` cannot place it (a missing, GC'd or cyclic reference), so it never
    /// integrates.
    Known(Option<u32>),
}

/// Every item of a document's updates, keyed by the clock range it covers.
#[derive(Default)]
struct Tree {
    nodes: Vec<Node>,
    /// Per client: start clock -> (end clock, node), the ranges disjoint.
    clients: HashMap<u64, BTreeMap<u32, (u32, usize)>>,
    type_items: usize,
}

impl Tree {
    /// Records `node` at `id..id + len`. Clocks an earlier item holds must be the same item:
    /// at each such clock the effective origin (the item's own at its first clock, the clock
    /// before inside it), the right origin and, without either, the parent agree, as they do
    /// when `yrs` re-encodes an item split, merged or deleted. Each overlapped piece is checked
    /// once and replaced by `node`, so the walk visits a piece at most once.
    fn insert(&mut self, id: Id, len: u32, mut node: Node) -> Result<(), Refusal> {
        let (start, end) = (id.clock, id.clock.saturating_add(len));
        if start == end {
            return Ok(());
        }
        let items = self.clients.entry(id.client).or_default();
        let origin_at = |clock: u32, piece_start: u32, origin: Option<Id>| {
            if clock == piece_start {
                origin
            } else {
                Some(Id {
                    client: id.client,
                    clock: clock - 1,
                })
            }
        };
        let first = match items.range(..start).next_back() {
            Some((&s, &(e, _))) if e > start => s,
            _ => start,
        };
        let overlapped: Vec<(u32, u32, usize)> = items
            .range(first..end)
            .map(|(&s, &(e, n))| (s, e, n))
            .collect();
        for (s, e, n) in overlapped {
            step();
            let old = self.nodes[n];
            let at = s.max(start);
            let new_origin = origin_at(at, start, node.origin);
            let same = new_origin == origin_at(at, s, old.origin)
                && node.right == old.right
                && (new_origin.is_some() || node.right.is_some() || node.parent == old.parent);
            if !same {
                return Err(Refusal::Malformed);
            }
            // A deleted copy of a type keeps the type's children placeable.
            node.is_type |= old.is_type;
            items.remove(&s);
            if s < start {
                items.insert(s, (start, n));
            }
            if e > end {
                let mut tail = old;
                tail.origin = origin_at(end, s, old.origin);
                items.insert(end, (e, self.nodes.len()));
                self.nodes.push(tail);
            }
        }
        items.insert(start, (end, self.nodes.len()));
        self.nodes.push(node);
        Ok(())
    }

    fn find(&self, id: Id) -> Option<usize> {
        let (_, &(end, node)) = self
            .clients
            .get(&id.client)?
            .range(..=id.clock)
            .next_back()?;
        (id.clock < end).then_some(node)
    }

    /// Resolves every item's depth with an explicit stack: an origin chain is as long as the
    /// document, far deeper than recursion allows.
    fn check_depth(&self) -> Result<(), Refusal> {
        let mut depth = vec![Depth::Unvisited; self.nodes.len()];
        let mut stack = Vec::new();
        for root in 0..self.nodes.len() {
            if depth[root] != Depth::Unvisited {
                continue;
            }
            depth[root] = Depth::InProgress;
            stack.push(root);
            while let Some(&at) = stack.last() {
                step();
                match self.resolve(at, &depth)? {
                    Resolved::Depth(d) => {
                        depth[at] = Depth::Known(d);
                        stack.pop();
                    }
                    Resolved::Needs(next) => {
                        depth[next] = Depth::InProgress;
                        stack.push(next);
                    }
                }
            }
        }
        Ok(())
    }

    /// `repair` in `update.rs`: the parent is the origin's, else the right origin's, else the
    /// decoded one; a parent id must name a type item.
    fn resolve(&self, at: usize, depth: &[Depth]) -> Result<Resolved, Refusal> {
        let node = &self.nodes[at];
        for neighbour in [node.origin, node.right].into_iter().flatten() {
            let Some(next) = self.find(neighbour) else {
                continue;
            };
            match depth[next] {
                Depth::Unvisited => return Ok(Resolved::Needs(next)),
                Depth::Known(Some(d)) => return Ok(Resolved::Depth(Some(d))),
                Depth::Known(None) | Depth::InProgress => {}
            }
        }
        let parent = match node.parent {
            Parent::Unknown => return Ok(Resolved::Depth(None)),
            Parent::Root => return Ok(Resolved::Depth(Some(1))),
            Parent::Type(id) => match self.find(id) {
                Some(parent) if self.nodes[parent].is_type => parent,
                _ => return Ok(Resolved::Depth(None)),
            },
        };
        match depth[parent] {
            Depth::Unvisited => Ok(Resolved::Needs(parent)),
            Depth::Known(Some(d)) if d >= MAX_TYPE_DEPTH => Err(Refusal::TooDeep),
            Depth::Known(Some(d)) => Ok(Resolved::Depth(Some(d + 1))),
            Depth::Known(None) | Depth::InProgress => Ok(Resolved::Depth(None)),
        }
    }
}

enum Resolved {
    Depth(Option<u32>),
    Needs(usize),
}

struct Reader<'a> {
    buf: &'a [u8],
    at: usize,
}

impl Reader<'_> {
    fn u8(&mut self) -> Result<u8, Refusal> {
        let byte = *self.buf.get(self.at).ok_or(Refusal::Malformed)?;
        self.at += 1;
        Ok(byte)
    }

    fn skip(&mut self, len: usize) -> Result<(), Refusal> {
        let end = self.at.checked_add(len).ok_or(Refusal::Malformed)?;
        if end > self.buf.len() {
            return Err(Refusal::Malformed);
        }
        self.at = end;
        Ok(())
    }

    /// `read_var_u64` / `read_var_u32`: 7 bits a byte, refused after 70 bits. The value wraps
    /// as `yrs` lets it wrap.
    fn var_u64(&mut self) -> Result<u64, Refusal> {
        let mut num = 0u64;
        let mut len = 0u32;
        loop {
            let byte = self.u8()?;
            num |= u64::wrapping_shl(u64::from(byte & 0x7f), len);
            len += 7;
            if byte < 0x80 {
                return Ok(num);
            }
            if len > 70 {
                return Err(Refusal::Malformed);
            }
        }
    }

    fn var_u32(&mut self) -> Result<u32, Refusal> {
        let mut num = 0u32;
        let mut len = 0u32;
        loop {
            let byte = self.u8()?;
            num |= u32::wrapping_shl(u32::from(byte & 0x7f), len);
            len += 7;
            if byte < 0x80 {
                return Ok(num);
            }
            if len > 70 {
                return Err(Refusal::Malformed);
            }
        }
    }

    /// `read_var_i64` shifts an `i64` left by 6, 13, ... bits; the eleventh byte would shift by
    /// 69, which panics in a debug build and wraps in release. Refused from the shift past 63.
    fn var_i64(&mut self) -> Result<(), Refusal> {
        let mut byte = self.u8()?;
        let mut len = 6u32;
        while byte >= 0x80 {
            if len > 63 {
                return Err(Refusal::Malformed);
            }
            byte = self.u8()?;
            len += 7;
        }
        Ok(())
    }

    fn id(&mut self) -> Result<Id, Refusal> {
        Ok(Id {
            client: self.var_u64()?,
            clock: self.var_u32()?,
        })
    }

    fn buf(&mut self) -> Result<&[u8], Refusal> {
        let len = self.var_u32()? as usize;
        let start = self.at;
        self.skip(len)?;
        Ok(&self.buf[start..self.at])
    }

    fn string(&mut self) -> Result<&str, Refusal> {
        std::str::from_utf8(self.buf()?).map_err(|_| Refusal::Malformed)
    }
}
