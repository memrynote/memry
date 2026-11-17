//! A walk over a lib0 v1 update that bounds what `yrs` 0.27.4 would do decoding it, before it
//! does. Three things in that decoder are unsafe on bytes we did not write:
//!
//! - `Any::decode` recurses once per nested array or map with no limit, so a few hundred
//!   kilobytes of `[[[[` overflow a 2 MiB stack and abort the process.
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

/// Deepest `Any` nesting accepted: the 128 levels `serde_json` allows the JSON strings of the
/// same update (`Any::from_json`). BlockNote's attribute values nest two or three levels.
pub const MAX_ANY_DEPTH: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// An `Any` nests deeper than [`MAX_ANY_DEPTH`].
    TooDeep,
    /// Not a v1 update this walk can follow (truncated, a bad tag, a string that is not UTF-8,
    /// an over-long varint).
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

/// Blocks and `Any` values visited on this thread, for the complexity tests.
#[cfg(test)]
pub(crate) fn steps() -> usize {
    STEPS.with(Cell::get)
}

fn step() {
    STEPS.with(|s| s.set(s.get() + 1));
}

/// `Ok` when `yrs` can decode `update` without deep recursion, unchecked UTF-8 or a debug
/// panic in its varint reader.
pub fn check(update: &[u8]) -> Result<(), Refusal> {
    let mut r = Reader { buf: update, at: 0 };
    let clients = r.var_u32()?;
    for _ in 0..clients {
        let blocks = r.var_u32()?;
        r.var_u64()?; // client
        r.var_u32()?; // clock
        for _ in 0..blocks {
            step();
            block(&mut r)?;
        }
    }
    Ok(())
}

fn block(r: &mut Reader<'_>) -> Result<(), Refusal> {
    let info = r.u8()?;
    match info {
        BLOCK_SKIP | BLOCK_GC => {
            r.var_u32()?;
            return Ok(());
        }
        _ => {}
    }
    if info & HAS_ORIGIN != 0 {
        r.id()?;
    }
    if info & HAS_RIGHT_ORIGIN != 0 {
        r.id()?;
    }
    if info & (HAS_ORIGIN | HAS_RIGHT_ORIGIN) == 0 {
        if r.var_u32()? == 1 {
            r.string()?;
        } else {
            r.id()?;
        }
        if info & HAS_PARENT_SUB != 0 {
            r.string()?;
        }
    }
    content(r, info & 0b1111)
}

/// `ItemContent::decode`.
fn content(r: &mut Reader<'_>, kind: u8) -> Result<(), Refusal> {
    match kind {
        // Deleted: a length.
        1 => r.var_u32().map(drop),
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
            Ok(())
        }
        // Binary: a buffer.
        3 => r.buf().map(drop),
        // String; Embed (a JSON string `serde_json` parses within its own depth limit).
        4 | 5 => r.string().map(drop),
        // Format: a key and a JSON string.
        6 => {
            r.string()?;
            r.string().map(drop)
        }
        // Type: a type ref byte, and an XML element's name. Weak links (7) are off in this build
        // and fail the decode.
        7 => match r.u8()? {
            TYPE_REF_XML_ELEMENT => r.string().map(drop),
            0..=6 | 9 | 15 => Ok(()),
            _ => Err(Refusal::Malformed),
        },
        // Any: a count of values.
        8 => {
            let len = r.var_u32()?;
            for _ in 0..len {
                any(r, 1)?;
            }
            Ok(())
        }
        // Doc: a guid and the options as one `Any`.
        9 => {
            r.string()?;
            any(r, 1)
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

    fn id(&mut self) -> Result<(), Refusal> {
        self.var_u64()?;
        self.var_u32().map(drop)
    }

    fn buf(&mut self) -> Result<&[u8], Refusal> {
        let len = self.var_u32()? as usize;
        let start = self.at;
        self.skip(len)?;
        Ok(&self.buf[start..self.at])
    }

    fn string(&mut self) -> Result<(), Refusal> {
        std::str::from_utf8(self.buf()?)
            .map(drop)
            .map_err(|_| Refusal::Malformed)
    }
}
