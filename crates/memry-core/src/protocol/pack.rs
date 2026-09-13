//! The MPAK pack container, chapter 08.
//!
//! **Reader only.** §8.1 is normative that a client is never a writer: the
//! writer lives server-side and is deliberately not ported, so there is no
//! `pack()` here and there must never be one. The committed vector class is
//! reader-only for the same reason — it records container bytes and asserts
//! this reader against them (`packages/contracts/test-vectors/README.md`
//! rule 1).
//!
//! A pack is a **derived cache** (§8.0): every byte in it also exists as an
//! individual blob. Nothing in this module is allowed to be load-bearing. A
//! bad pack is treated as absent and the caller falls back to the
//! item-granular endpoints of chapters 05 and 07, which is why every failure
//! below is an ordinary `Err` and none of them is fatal to a sync.
//!
//! The layout, all integers big-endian (§8.2):
//!
//! ```text
//!   0    4  magic, ASCII `MPAK`
//!   4    1  format version, PACK_VERSION
//!   5    1  reserved, 0
//!   6    2  flags, currently 0 — MUST be ignored, never rejected (§8.7)
//!   8    *  payload region: entry bytes concatenated, no separators
//!   *    *  index block: `entryCount` records (§8.3), at `indexOffset`
//! end-53  32  SHA-256 of the whole payload region
//!         8  entryCount
//!         8  indexOffset, an ABSOLUTE file offset
//!         4  magic `MPAK`
//!         1  version echo
//! ```
//!
//! Two traps the chapter calls out, both encoded here rather than left to a
//! comment. An index entry's `offset` is **relative to the payload region**,
//! so the absolute position is `PACK_HEADER_SIZE + offset` (§8.3) — the
//! off-by-eight a reader gets wrong first. And per-entry digests are **not**
//! skipped when the whole-payload digest passes (§8.5): a pack whose payload
//! hash is intact can still carry an entry whose own hash is not, and the
//! vector class has a case that proves it.

use serde_json::Value as Json;
use sha2::{Digest as _, Sha256};

mod index;

pub use index::{decode_index, sort_key_from_u64};

use index::Cursor;

/// ASCII `MPAK`, in the header and echoed in the footer (§8.2).
pub const PACK_MAGIC: [u8; 4] = *b"MPAK";
/// The only format version this reader accepts (§8.2). Any other version is
/// rejected, which is what makes `flags` safe to ignore: an incompatible
/// change bumps this instead of setting a flag (§8.7).
pub const PACK_VERSION: u8 = 1;
/// magic(4) + version(1) + reserved(1) + flags(2) (§8.2).
pub const PACK_HEADER_SIZE: usize = 8;
/// payloadSha256(32) + entryCount(8) + indexOffset(8) + magic(4) + version(1).
/// Derived, never written as the literal 53 (§8.2).
pub const PACK_FOOTER_SIZE: usize = 32 + 8 + 8 + 4 + 1;
/// Ceiling on one index record (§8.6).
pub const PACK_MAX_INDEX_ENTRY_BYTES: usize = 4096;
/// Hard ceiling on `entryCount`, whatever the footer claims (§8.6).
pub const PACK_MAX_ENTRIES: u64 = 4096;
/// Absolute ceiling on the index block (§8.6).
pub const PACK_MAX_INDEX_BYTES: usize = PACK_MAX_ENTRIES as usize * PACK_MAX_INDEX_ENTRY_BYTES;

/// Which magic-or-version check failed, so a caller can tell a corrupt header
/// from a corrupt footer without parsing a message (§8.5 lists both).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PackRegion {
    /// Bytes 0..8.
    Header,
    /// The last `PACK_FOOTER_SIZE` bytes.
    Footer,
}

impl std::fmt::Display for PackRegion {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Header => "header",
            Self::Footer => "footer",
        })
    }
}

/// Every way a pack is refused (§8.5, plus the §8.6 bounds).
///
/// One variant per **cause**, not one per message: a caller decides whether to
/// log, re-fetch or blacklist a pack key, and it must not have to match on
/// English to do it. The `Display` strings reproduce §8.5's table because that
/// table is normative, but the variant is the contract.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PackError {
    /// Shorter than a header plus a footer, or a footer slice shorter than
    /// `PACK_FOOTER_SIZE` (§8.5).
    #[error("pack too small: {bytes} bytes, minimum {minimum}")]
    TooSmall { bytes: usize, minimum: usize },

    /// Header magic is not `MPAK` (§8.5). Rejected before any hashing.
    #[error("pack header magic mismatch")]
    HeaderMagicMismatch,

    /// Footer magic is not `MPAK` (§8.5).
    #[error("pack footer magic mismatch")]
    FooterMagicMismatch,

    /// A version byte that is not [`PACK_VERSION`] (§8.5). `region` separates
    /// the header check from the footer echo; both print the same message.
    #[error("unsupported pack version {version}")]
    UnsupportedVersion { version: u8, region: PackRegion },

    /// A read ran past the end of the buffer (§8.5).
    #[error("pack truncated: wanted {wanted} bytes, {remaining} remain")]
    Truncated { wanted: usize, remaining: usize },

    /// The footer claims more entries than §8.6's ceiling allows.
    ///
    /// **Checked before any allocation and before any hashing.** The reference
    /// reader has no such check and fails such a pack as `pack truncated`
    /// after running out of index bytes (§8.6), which it can afford because it
    /// already holds the whole file. A streaming reader cannot, so §8.6 makes
    /// this check mandatory and this variant is the one the vector's
    /// over-ceiling case lands on.
    #[error("pack claims {count} entries, over the {max} entry ceiling")]
    EntryCountTooLarge { count: u64, max: u64 },

    /// The index block, or one record in it, is over §8.6's byte ceiling.
    #[error("pack index is {bytes} bytes, over the {max} byte ceiling")]
    IndexTooLarge { bytes: u64, max: u64 },

    /// `indexOffset` does not land between the header and the footer, so the
    /// payload region it implies is not a region at all.
    #[error("pack index offset {index_offset} is outside the payload region")]
    IndexOffsetOutOfRange { index_offset: u64 },

    /// An index entry's kind byte is not a [`PackKind`] (§8.5).
    #[error("unknown pack entry kind {code}")]
    UnknownEntryKind { code: u8 },

    /// `metaBytes` is not parseable JSON (§8.3). The pack is discarded.
    #[error("pack entry metadata is not JSON: {id}")]
    EntryMetaInvalid { id: String },

    /// An entry's `offset`/`length` reach outside the payload region.
    #[error("pack entry is outside the payload region: {id}")]
    EntryOutOfBounds { id: String },

    /// The whole-payload digest did not match the footer (§8.5).
    #[error("pack payload checksum mismatch")]
    PayloadChecksumMismatch,

    /// One entry's digest did not match its index record (§8.5). Reported
    /// even when [`Self::PayloadChecksumMismatch`] did not fire.
    #[error("pack entry checksum mismatch: {id}")]
    EntryChecksumMismatch { id: String },
}

/// `PackKindCode`: `record = 0`, `crdt_snapshot = 1`, `crdt_update = 2`
/// (§8.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PackKind {
    /// Identity is `type:id`; `sortKey` is a `server_cursor` (§8.4).
    Record,
    /// Identity is the document id; `sortKey` is `created_at` in epoch
    /// seconds. Carries `{sequenceNum, revision}` in `metaBytes`, the
    /// freshness token a client checks against `snapshotMeta` before trusting
    /// the bytes (§8.4).
    CrdtSnapshot,
    /// Reserved: no writer produces it today (§8.4.1). A conforming reader
    /// MUST still accept it structurally — rejecting would be a gratuitous
    /// incompatibility with a future writer — and MAY decline to use it.
    CrdtUpdate,
}

impl PackKind {
    /// The wire code of §8.4.
    pub fn code(self) -> u8 {
        match self {
            Self::Record => 0,
            Self::CrdtSnapshot => 1,
            Self::CrdtUpdate => 2,
        }
    }

    /// Decodes a kind byte. An unknown code is a hard error (§8.5), so this
    /// returns `None` rather than a catch-all variant.
    pub fn from_code(code: u8) -> Option<Self> {
        match code {
            0 => Some(Self::Record),
            1 => Some(Self::CrdtSnapshot),
            2 => Some(Self::CrdtUpdate),
            _ => None,
        }
    }

    /// The chapter's spelling, which is also the `itemKind` of §8.9.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Record => "record",
            Self::CrdtSnapshot => "crdt_snapshot",
            Self::CrdtUpdate => "crdt_update",
        }
    }
}

/// The footer, readable from the tail slice alone (§8.5) so a streaming reader
/// never has to hold the file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackFooter {
    pub version: u8,
    pub entry_count: u64,
    /// An **absolute** file offset (§8.2).
    pub index_offset: u64,
    pub payload_sha256: [u8; 32],
}

/// One decoded index record (§8.3).
///
/// The digest survives the decode on purpose: a streaming reader verifies each
/// entry against it while reading that entry's slice off disk, so dropping it
/// here would force the whole file into memory to check anything.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackEntry {
    pub kind: PackKind,
    /// `type:id` for records, the document id for the CRDT kinds (§8.4).
    pub id: String,
    /// The source R2 key: provenance plus a per-item fallback (§8.3).
    pub source_key: String,
    /// `server_cursor` or an epoch second (§8.4). See
    /// [`sort_key_from_u64`] for the one value that does not survive.
    pub sort_key: i64,
    /// Absent when `metaLen` is 0 — which is **not** the same as an empty
    /// object (§8.3).
    pub meta: Option<Json>,
    /// **Relative to the payload region**: the absolute position is
    /// `PACK_HEADER_SIZE + offset` (§8.3).
    pub offset: u64,
    pub length: u64,
    /// Digest of this entry's payload bytes.
    pub sha256: [u8; 32],
}

/// A pack whose payload digest and every entry digest matched.
///
/// The reference reader returns `integrityVerified: true` as a field (§8.5);
/// here the type is the claim. It has no public constructor, so a value of
/// this type cannot exist without [`parse_pack`] having checked every digest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedPack {
    pub version: u8,
    pub entries: Vec<PackEntry>,
}

/// Rejects anything whose first bytes are not this format at this version
/// (§8.5).
///
/// `flags` at offset 6 is **not** read: §8.7 is normative that a reader MUST
/// ignore it and MUST NOT reject a non-zero value, because a writer that set a
/// flag could otherwise never ship.
pub fn read_header(bytes: &[u8]) -> Result<(), PackError> {
    if bytes.len() < PACK_HEADER_SIZE {
        return Err(PackError::TooSmall {
            bytes: bytes.len(),
            minimum: PACK_HEADER_SIZE,
        });
    }
    if bytes[..4] != PACK_MAGIC {
        return Err(PackError::HeaderMagicMismatch);
    }
    if bytes[4] != PACK_VERSION {
        return Err(PackError::UnsupportedVersion {
            version: bytes[4],
            region: PackRegion::Header,
        });
    }
    Ok(())
}

/// Reads the footer from the **last** `PACK_FOOTER_SIZE` bytes of `bytes`.
///
/// `bytes` may be the whole file or just that tail slice (§8.5), which is what
/// lets a streaming reader probe a pack before deciding to fetch it.
pub fn read_footer(bytes: &[u8]) -> Result<PackFooter, PackError> {
    if bytes.len() < PACK_FOOTER_SIZE {
        return Err(PackError::TooSmall {
            bytes: bytes.len(),
            minimum: PACK_FOOTER_SIZE,
        });
    }
    let mut cursor = Cursor::new(&bytes[bytes.len() - PACK_FOOTER_SIZE..]);
    let payload_sha256 = cursor.array32()?;
    let entry_count = cursor.u64()?;
    let index_offset = cursor.u64()?;
    let magic = cursor.take(4)?;
    let version = cursor.u8()?;

    if magic != PACK_MAGIC {
        return Err(PackError::FooterMagicMismatch);
    }
    if version != PACK_VERSION {
        return Err(PackError::UnsupportedVersion {
            version,
            region: PackRegion::Footer,
        });
    }
    Ok(PackFooter {
        version,
        entry_count,
        index_offset,
        payload_sha256,
    })
}

/// The §8.6 ceiling on `entryCount`, applied **before** anything is allocated
/// or hashed.
///
/// Split out so the structural probe is callable on its own: a streaming
/// reader that has only the footer can refuse a pack here, which is the whole
/// point of the cap (a corrupt 8-byte `entryCount` must not turn into 4097
/// allocations).
pub fn check_entry_count(entry_count: u64) -> Result<(), PackError> {
    if entry_count > PACK_MAX_ENTRIES {
        return Err(PackError::EntryCountTooLarge {
            count: entry_count,
            max: PACK_MAX_ENTRIES,
        });
    }
    Ok(())
}

/// Full parse and integrity verification of a pack held in one buffer (§8.5).
///
/// The order is the cheap structural probes first — length, header magic,
/// header version, footer magic, footer version, the entry-count ceiling —
/// and only then the two rounds of hashing. A corrupt header never costs a
/// digest, and a corrupt `entryCount` never costs an allocation.
///
/// On any error the caller treats the pack as absent and falls back to the
/// item-granular endpoints (§8.0): a derived cache may vanish, source blobs
/// never do.
pub fn parse_pack(bytes: &[u8]) -> Result<VerifiedPack, PackError> {
    let minimum = PACK_HEADER_SIZE + PACK_FOOTER_SIZE;
    if bytes.len() < minimum {
        return Err(PackError::TooSmall {
            bytes: bytes.len(),
            minimum,
        });
    }
    read_header(bytes)?;
    let footer = read_footer(bytes)?;
    check_entry_count(footer.entry_count)?;

    // The payload region runs from the header end to the ABSOLUTE
    // `indexOffset` (§8.2). A corrupt offset is refused rather than clamped:
    // the reference reader's `subarray` silently clamps, which turns a
    // structural failure into a digest failure and loses the cause.
    let index_at = usize::try_from(footer.index_offset)
        .ok()
        .filter(|at| (PACK_HEADER_SIZE..=bytes.len() - PACK_FOOTER_SIZE).contains(at))
        .ok_or(PackError::IndexOffsetOutOfRange {
            index_offset: footer.index_offset,
        })?;

    let payload = &bytes[PACK_HEADER_SIZE..index_at];
    if Sha256::digest(payload).as_slice() != footer.payload_sha256 {
        return Err(PackError::PayloadChecksumMismatch);
    }

    let entries = decode_index(
        &bytes[index_at..bytes.len() - PACK_FOOTER_SIZE],
        footer.entry_count,
    )?;

    // Not skipped because the payload digest passed (§8.5): the whole-payload
    // hash and the per-entry hashes are independent claims, and the vector
    // class carries a pack where the first holds and the second does not.
    for entry in &entries {
        if Sha256::digest(entry_payload(payload, entry)?).as_slice() != entry.sha256 {
            return Err(PackError::EntryChecksumMismatch {
                id: entry.id.clone(),
            });
        }
    }

    Ok(VerifiedPack {
        version: footer.version,
        entries,
    })
}

/// One entry's slice of the payload region, bounds-checked.
fn entry_payload<'a>(payload: &'a [u8], entry: &PackEntry) -> Result<&'a [u8], PackError> {
    let out_of_bounds = || PackError::EntryOutOfBounds {
        id: entry.id.clone(),
    };
    let start = usize::try_from(entry.offset).map_err(|_| out_of_bounds())?;
    let length = usize::try_from(entry.length).map_err(|_| out_of_bounds())?;
    let end = start.checked_add(length).ok_or_else(out_of_bounds)?;
    payload.get(start..end).ok_or_else(out_of_bounds)
}

/// One entry's payload bytes out of a whole pack buffer, after a successful
/// [`parse_pack`].
///
/// This is where §8.3's off-by-eight lives: the entry's `offset` is relative
/// to the payload region, so the absolute position is
/// `PACK_HEADER_SIZE + offset`.
pub fn extract_entry<'a>(bytes: &'a [u8], entry: &PackEntry) -> Result<&'a [u8], PackError> {
    if bytes.len() < PACK_HEADER_SIZE + PACK_FOOTER_SIZE {
        return Err(PackError::TooSmall {
            bytes: bytes.len(),
            minimum: PACK_HEADER_SIZE + PACK_FOOTER_SIZE,
        });
    }
    entry_payload(
        &bytes[PACK_HEADER_SIZE..bytes.len() - PACK_FOOTER_SIZE],
        entry,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_layout_constants_are_the_chapter_table() {
        assert_eq!(&PACK_MAGIC, b"MPAK");
        assert_eq!(PACK_VERSION, 1);
        assert_eq!(PACK_HEADER_SIZE, 8);
        assert_eq!(PACK_FOOTER_SIZE, 53);
        assert_eq!(PACK_MAX_ENTRIES, 4096);
        assert_eq!(PACK_MAX_INDEX_ENTRY_BYTES, 4096);
        assert_eq!(PACK_MAX_INDEX_BYTES, 4096 * 4096);
    }

    #[test]
    fn the_kind_codes_are_the_chapter_table() {
        assert_eq!(PackKind::Record.code(), 0);
        assert_eq!(PackKind::CrdtSnapshot.code(), 1);
        assert_eq!(PackKind::CrdtUpdate.code(), 2);
        assert_eq!(PackKind::from_code(3), None);
        // §8.4.1: reserved, but structurally accepted.
        assert_eq!(PackKind::from_code(2), Some(PackKind::CrdtUpdate));
    }

    #[test]
    fn a_short_buffer_is_refused_before_anything_else() {
        assert_eq!(
            parse_pack(&[0u8; 8]),
            Err(PackError::TooSmall {
                bytes: 8,
                minimum: PACK_HEADER_SIZE + PACK_FOOTER_SIZE,
            })
        );
    }

    #[test]
    fn the_entry_count_ceiling_costs_no_allocation() {
        assert_eq!(check_entry_count(PACK_MAX_ENTRIES), Ok(()));
        assert_eq!(
            check_entry_count(PACK_MAX_ENTRIES + 1),
            Err(PackError::EntryCountTooLarge {
                count: 4097,
                max: 4096,
            })
        );
    }

    #[test]
    fn flags_are_ignored_rather_than_rejected() {
        // §8.7: a non-zero `flags` MUST NOT be refused, or no writer could
        // ever set one.
        let mut header = [0u8; PACK_HEADER_SIZE];
        header[..4].copy_from_slice(&PACK_MAGIC);
        header[4] = PACK_VERSION;
        header[6] = 0xFF;
        header[7] = 0xFF;
        assert_eq!(read_header(&header), Ok(()));
    }

    #[test]
    fn a_footer_reads_from_the_tail_slice_alone() {
        let mut footer = [0u8; PACK_FOOTER_SIZE];
        footer[32 + 8 + 8..32 + 8 + 8 + 4].copy_from_slice(&PACK_MAGIC);
        footer[PACK_FOOTER_SIZE - 1] = PACK_VERSION;
        footer[32 + 7] = 3;
        footer[32 + 8 + 7] = 91;

        assert_eq!(
            read_footer(&footer),
            Ok(PackFooter {
                version: 1,
                entry_count: 3,
                index_offset: 91,
                payload_sha256: [0u8; 32],
            })
        );
    }
}
