//! The index block of a pack, chapter 08 §8.3.
//!
//! Split out of `pack.rs` at the 600-line ceiling, along the seam the chapter
//! already draws: everything here is **structural only**. No payload byte is
//! touched and no digest is computed, which is exactly the property that lets
//! a streaming reader hold nothing but the index block — kilobytes — and then
//! verify each entry against a slice it reads one at a time.
//!
//! The §8.6 memory bounds therefore live here too. They have to be applied
//! before an allocation, not after, and every allocation this reader makes
//! from pack-controlled numbers is made in this file.

use super::{
    PACK_MAX_INDEX_BYTES, PACK_MAX_INDEX_ENTRY_BYTES, PackEntry, PackError, PackKind,
    check_entry_count,
};

/// Big-endian reads with one bounds check, the `ByteReader` behind §8.5's
/// `pack truncated` row.
pub(super) struct Cursor<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Cursor<'a> {
    pub(super) fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, at: 0 }
    }

    pub(super) fn take(&mut self, n: usize) -> Result<&'a [u8], PackError> {
        let remaining = self.bytes.len() - self.at;
        if n > remaining {
            return Err(PackError::Truncated {
                wanted: n,
                remaining,
            });
        }
        let slice = &self.bytes[self.at..self.at + n];
        self.at += n;
        Ok(slice)
    }

    pub(super) fn u8(&mut self) -> Result<u8, PackError> {
        Ok(self.take(1)?[0])
    }

    pub(super) fn u16(&mut self) -> Result<u16, PackError> {
        let b = self.take(2)?;
        Ok(u16::from_be_bytes([b[0], b[1]]))
    }

    pub(super) fn u64(&mut self) -> Result<u64, PackError> {
        let b = self.take(8)?;
        Ok(u64::from_be_bytes(b.try_into().expect("8 bytes")))
    }

    pub(super) fn array32(&mut self) -> Result<[u8; 32], PackError> {
        Ok(self.take(32)?.try_into().expect("32 bytes"))
    }
}

/// Decodes a `sortKey` exactly as the reference reader does, **including its
/// precision loss** (§8.3).
///
/// `ByteReader.i64` reconstructs the 64-bit value through a double —
/// `u32() * 2**32 + u32()`, then a subtraction of `2**64` above the signed
/// midpoint — so `0xFFFF_FFFF_FFFF_FFFF` rounds to `2**64` on the way in and
/// comes back out as `0` rather than as `-1`. Reading it as a plain `i64`
/// here would be *more* correct and would still be wrong: two readers of the
/// same pack would then disagree about the order of its entries, which is the
/// one thing a sort key may not do.
///
/// §8.3 is normative that a writer MUST NOT emit a negative `sortKey` and a
/// reader MUST NOT be given one, so the loss is unreachable against a
/// conforming writer. The behaviour is pinned anyway, recorded as the reader
/// actually behaves rather than as it ought to.
pub fn sort_key_from_u64(raw: u64) -> i64 {
    const TWO_POW_32: f64 = 4_294_967_296.0;
    const TWO_POW_63: f64 = 9_223_372_036_854_775_808.0;
    const TWO_POW_64: f64 = 18_446_744_073_709_551_616.0;

    let high = (raw >> 32) as f64;
    let low = (raw & 0xFFFF_FFFF) as f64;
    let value = high * TWO_POW_32 + low;
    let signed = if value >= TWO_POW_63 {
        value - TWO_POW_64
    } else {
        value
    };
    signed as i64
}

/// Decodes `entry_count` index records from the index block (§8.3).
///
/// Both §8.6 caps are applied before the `Vec` is sized, because both numbers
/// come out of the pack itself.
pub fn decode_index(index_bytes: &[u8], entry_count: u64) -> Result<Vec<PackEntry>, PackError> {
    check_entry_count(entry_count)?;
    if index_bytes.len() > PACK_MAX_INDEX_BYTES {
        return Err(PackError::IndexTooLarge {
            bytes: index_bytes.len() as u64,
            max: PACK_MAX_INDEX_BYTES as u64,
        });
    }

    let mut cursor = Cursor::new(index_bytes);
    // Safe only now: `entry_count` is past the ceiling.
    let mut entries = Vec::with_capacity(entry_count as usize);
    for _ in 0..entry_count {
        entries.push(decode_entry(&mut cursor)?);
    }
    Ok(entries)
}

/// One index record, in the field order of §8.3.
fn decode_entry(cursor: &mut Cursor<'_>) -> Result<PackEntry, PackError> {
    let start = cursor.at;

    let code = cursor.u8()?;
    let kind = PackKind::from_code(code).ok_or(PackError::UnknownEntryKind { code })?;

    let id = take_text(cursor, start)?;
    let source_key = take_text(cursor, start)?;
    let sort_key = sort_key_from_u64(cursor.u64()?);
    let meta_json = take_text(cursor, start)?;
    let offset = cursor.u64()?;
    let length = cursor.u64()?;
    let sha256 = cursor.array32()?;

    // `metaLen` 0 means no metadata at all, not an empty object (§8.3).
    let meta = if meta_json.is_empty() {
        None
    } else {
        Some(
            serde_json::from_str(&meta_json)
                .map_err(|_| PackError::EntryMetaInvalid { id: id.clone() })?,
        )
    };

    Ok(PackEntry {
        kind,
        id,
        source_key,
        sort_key,
        meta,
        offset,
        length,
        sha256,
    })
}

/// A `uint16` length followed by that many bytes of UTF-8 (§8.3).
///
/// `idLen` and `keyLen` are **byte** counts, not character counts. The bytes
/// are decoded leniently, as the reference `TextDecoder` does: a malformed
/// sequence becomes U+FFFD and simply matches no local id, where rejecting it
/// would discard a whole pack over a field this reader only ever compares.
///
/// `entry_start` is where the current record began, so one record cannot
/// outgrow `PACK_MAX_INDEX_ENTRY_BYTES` (§8.6) — checked before the copy,
/// never after it.
fn take_text(cursor: &mut Cursor<'_>, entry_start: usize) -> Result<String, PackError> {
    let len = cursor.u16()? as usize;
    let consumed = cursor.at - entry_start;
    if consumed + len > PACK_MAX_INDEX_ENTRY_BYTES {
        return Err(PackError::IndexTooLarge {
            bytes: (consumed + len) as u64,
            max: PACK_MAX_INDEX_ENTRY_BYTES as u64,
        });
    }
    Ok(String::from_utf8_lossy(cursor.take(len)?).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::pack::PACK_MAX_ENTRIES;

    #[test]
    fn a_sort_key_decodes_through_the_reference_readers_doubles() {
        assert_eq!(sort_key_from_u64(0), 0);
        assert_eq!(sort_key_from_u64(42), 42);
        assert_eq!(sort_key_from_u64(1_760_000_000), 1_760_000_000);
        // §8.3: `-1` does not survive the reference reader, and this reader
        // agrees with it rather than being right on its own.
        assert_eq!(sort_key_from_u64(u64::MAX), 0);
    }

    #[test]
    fn an_over_ceiling_entry_count_never_reaches_with_capacity() {
        assert_eq!(
            decode_index(&[], u64::MAX),
            Err(PackError::EntryCountTooLarge {
                count: u64::MAX,
                max: PACK_MAX_ENTRIES,
            })
        );
    }

    #[test]
    fn a_truncated_index_block_is_named_as_truncation() {
        assert!(matches!(
            decode_index(&[0u8, 0, 4], 1),
            Err(PackError::Truncated { .. })
        ));
    }

    #[test]
    fn an_unknown_kind_byte_is_a_hard_error() {
        assert_eq!(
            decode_index(&[7u8], 1),
            Err(PackError::UnknownEntryKind { code: 7 })
        );
    }
}
