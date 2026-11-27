import { PACK_MAX_ENTRIES } from '@memry/contracts/pack-format'

/**
 * Pack sizing (protocol 08 §8.14, #5229): how large a pack may be, when a
 * build may cut one, and how many packs a vault may list per kind.
 */

// Target payload size per pack. Workers isolates hard-cap at 128MB of memory,
// and assembly needs one contiguous buffer for the whole file plus one
// transient source blob while it is being copied in. A 64MB target left no
// safe headroom even after the single-buffer rewrite (buffer + an 8MB item +
// isolate baseline); 24MB keeps peak ≈ 24MB + ≤8MB + slack, comfortably under
// the cap. A rollup holds its input packs and the merged buffer at once, and
// it takes inputs only up to this target, so its peak is about twice it.
export const PACK_TARGET_BYTES = 24 * 1024 * 1024

/**
 * Minimum fill: a build cuts a pack only once the kind holds PACK_MIN_FILL_ROWS
 * unpacked rows (a full build window), its rows reach PACK_TARGET_BYTES, or its
 * oldest unpacked row is PACK_SETTLE_SECONDS old. Rows younger than that stay
 * item-granular on the tail. Without it every push listed one tiny pack and an
 * active vault passed the listing cap in days.
 */
export const PACK_MIN_FILL_ROWS = 256
export const PACK_SETTLE_SECONDS = 24 * 60 * 60

/** `row_time` is the epoch-second write time each selection query returns. */
export const packFillReady = (
  scanned: ReadonlyArray<{ row_time?: number | null }>,
  bytesFull: boolean,
  nowSeconds: number
): boolean =>
  bytesFull ||
  scanned.length >= PACK_MIN_FILL_ROWS ||
  scanned.some(
    (row) => typeof row.row_time === 'number' && row.row_time <= nowSeconds - PACK_SETTLE_SECONDS
  )

/**
 * The pack bound per kind: a vault lists at most
 * `2 * (ceil(entries / PACK_MAX_ENTRIES) + ceil(bytes / PACK_TARGET_BYTES)) + 2`
 * packs of one kind, where `entries` and `bytes` are what its listed packs of
 * that kind hold. A rollup runs while a kind is above it and merges adjacent
 * packs whose sum fits one pack. Above the bound such a pair always exists:
 * if every adjacent pair passed PACK_MAX_ENTRIES or PACK_TARGET_BYTES, the
 * `floor(n / 2)` disjoint pairs would hold more than the vault does. Each
 * run of mergeable packs needs `2 * (...) + 1`, and the second `+ 1` is the one
 * boundary between cache-only and covered packs, which a rollup never merges
 * across. After a rollup `entries` and `bytes` are live, so the bound tracks
 * the live vault.
 */
export const packCountBound = (entries: number, bytes: number): number =>
  2 * (Math.ceil(entries / PACK_MAX_ENTRIES) + Math.ceil(bytes / PACK_TARGET_BYTES)) + 2

/** packCountBound in SQL, over `SUM(item_count)` and `SUM(byte_size)` of one group. */
export const PACK_COUNT_BOUND_SQL = `(2 * ((SUM(item_count) + ${PACK_MAX_ENTRIES - 1}) / ${PACK_MAX_ENTRIES}
  + (SUM(byte_size) + ${PACK_TARGET_BYTES - 1}) / ${PACK_TARGET_BYTES}) + 2)`
