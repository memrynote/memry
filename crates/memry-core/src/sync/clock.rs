//! The vector-clock algebra, chapter 06 §6.1, §6.2 and §6.6.
//!
//! Five operations and one reserved key. Everything in [`super::field_merge`]
//! is built from these, and nothing here knows what a field is.
//!
//! **`_offline` gets no special treatment in the algebra.** It is an ordinary
//! key in [`increment`], [`merge`] and [`compare`] (§6.1). It is special in
//! exactly two places, both elsewhere: the merge tie-break, which is a
//! *key-presence* test (§6.3), and rebinding, which acts only on a tick `> 0`
//! (§6.6). The asymmetry is deliberate and load-bearing — a zero-valued
//! `_offline` key survives rebinding **and** still wins ties — so the two
//! thresholds are written out separately rather than shared.
//!
//! **Nothing prunes a clock** (§6.10). A key for a device this client has
//! never heard of is kept: dropping it lowers [`clock_total`] and therefore
//! changes the winner.

use std::collections::{BTreeMap, BTreeSet};

/// The reserved pseudo device id edits tick while the sync runtime is down
/// (§6.1, `packages/contracts/src/sync-api.ts:173`).
pub const OFFLINE_CLOCK_DEVICE_ID: &str = "_offline";

/// A map from device id to a non-negative tick count. **A missing key reads as
/// 0** (§6.1).
///
/// `BTreeMap` rather than `HashMap` because the whole tier is compared against
/// committed vectors: a deterministic iteration order makes a failing
/// assertion read the same way twice. Key order is irrelevant to every
/// operation here.
pub type VectorClock = BTreeMap<String, u64>;

/// `clock[deviceId] ?? 0` (§6.1).
pub fn get_tick(clock: &VectorClock, device_id: &str) -> u64 {
    clock.get(device_id).copied().unwrap_or(0)
}

/// Adds exactly 1 to `device_id`'s tick. Non-mutating (§6.1).
pub fn increment(clock: &VectorClock, device_id: &str) -> VectorClock {
    let mut next = clock.clone();
    next.insert(device_id.to_owned(), get_tick(clock, device_id) + 1);
    next
}

/// The pointwise maximum, over the union of both key sets. Commutative (§6.1).
pub fn merge(a: &VectorClock, b: &VectorClock) -> VectorClock {
    let mut merged = a.clone();
    for (device, tick) in b {
        let entry = merged.entry(device.clone()).or_insert(0);
        *entry = (*entry).max(*tick);
    }
    merged
}

/// The clock a local write ticks from, given the id's last known tombstone
/// clock (#2409, chapter 05 §5.8).
///
/// Only a write that (re)creates the row — a create, or a first write to a
/// clockless row — absorbs the tombstone, so the re-create happens strictly
/// after the delete. A clocked row that survived a delete never absorbs it:
/// that would turn a concurrent edit into one that dominates the delete. With
/// no tombstone the result is `current`, unchanged. The TypeScript twin is
/// `recreateBaseClock`; `recreate-clock.json` pins both.
pub fn recreate_base(
    current: &VectorClock,
    tombstone: Option<&VectorClock>,
    is_create: bool,
) -> VectorClock {
    match tombstone {
        Some(tombstone) if is_create || current.is_empty() => merge(current, tombstone),
        _ => current.clone(),
    }
}

/// How two clocks relate (§6.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClockOrder {
    Equal,
    /// `a` happened before `b`.
    Before,
    /// `a` dominates `b`.
    After,
    Concurrent,
}

impl ClockOrder {
    /// The wire spelling the `field-merge` vectors use.
    pub fn as_str(self) -> &'static str {
        match self {
            ClockOrder::Equal => "equal",
            ClockOrder::Before => "before",
            ClockOrder::After => "after",
            ClockOrder::Concurrent => "concurrent",
        }
    }
}

/// Compares two clocks over the **union** of both key sets (§6.1).
///
/// Short-circuits to `Concurrent` as soon as both directions are seen, which
/// is what the reference loop does; the result is the same either way, and
/// matching the shape keeps the two readable side by side.
pub fn compare(a: &VectorClock, b: &VectorClock) -> ClockOrder {
    let mut a_ahead = false;
    let mut b_ahead = false;
    let union: BTreeSet<&String> = a.keys().chain(b.keys()).collect();
    for device in union {
        let left = get_tick(a, device);
        let right = get_tick(b, device);
        if left > right {
            a_ahead = true;
        } else if left < right {
            b_ahead = true;
        }
        if a_ahead && b_ahead {
            return ClockOrder::Concurrent;
        }
    }
    match (a_ahead, b_ahead) {
        (false, false) => ClockOrder::Equal,
        (true, false) => ClockOrder::After,
        (false, true) => ClockOrder::Before,
        (true, true) => ClockOrder::Concurrent,
    }
}

/// The plain sum of **every** tick, `_offline` included; no key is filtered
/// (§6.2).
///
/// Accumulated in a 64-bit signed integer, as §6.2 requires. The device cap is
/// 50 keys (§6.10) so an overflow is unreachable, and `saturating_add` says so
/// without a panic path.
pub fn clock_total(clock: &VectorClock) -> i64 {
    clock
        .values()
        .fold(0i64, |total, tick| total.saturating_add(*tick as i64))
}

/// Moves `_offline`'s ticks onto a real device id (§6.6).
///
/// **Deletes** the key and **adds** its count to the target's existing tick —
/// it does not take a maximum. A no-op when the tick is `<= 0`, which is why a
/// `{_offline: 0}` key survives a rebind and still wins the §6.3 tie-break.
///
/// **A clock containing `_offline` MUST never reach the server**, and this MUST
/// run before the first push (§6.6). Desktop violates that today (#2179); the
/// core does not.
pub fn rebind_clock_device(clock: &VectorClock, target_device_id: &str) -> VectorClock {
    let offline = get_tick(clock, OFFLINE_CLOCK_DEVICE_ID);
    if offline == 0 {
        return clock.clone();
    }
    let mut rebound = clock.clone();
    rebound.remove(OFFLINE_CLOCK_DEVICE_ID);
    let carried = get_tick(clock, target_device_id) + offline;
    rebound.insert(target_device_id.to_owned(), carried);
    rebound
}

/// [`rebind_clock_device`] over every field clock (§6.6, `:49-57`).
pub fn rebind_field_clocks(
    field_clocks: &BTreeMap<String, VectorClock>,
    target_device_id: &str,
) -> BTreeMap<String, VectorClock> {
    field_clocks
        .iter()
        .map(|(field, clock)| (field.clone(), rebind_clock_device(clock, target_device_id)))
        .collect()
}

/// Whether a clock carries the reserved key at all, at any tick value.
///
/// The §6.3 tie-break and the §6.6 rebind threshold are different questions,
/// so they get different helpers rather than one with a flag.
pub fn has_offline_key(clock: &VectorClock) -> bool {
    clock.contains_key(OFFLINE_CLOCK_DEVICE_ID)
}

/// Builds a clock from `(device, tick)` pairs. Convenience for callers and
/// tests; the protocol has no opinion about it.
pub fn clock_of<const N: usize>(ticks: [(&str, u64); N]) -> VectorClock {
    ticks
        .into_iter()
        .map(|(device, tick)| (device.to_owned(), tick))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_key_reads_as_zero_so_the_first_tick_is_one() {
        let empty = VectorClock::new();
        assert_eq!(get_tick(&empty, "device-a"), 0);
        assert_eq!(increment(&empty, "device-a"), clock_of([("device-a", 1)]));
    }

    #[test]
    fn merge_is_the_pointwise_maximum_and_commutes() {
        let a = clock_of([("device-a", 2), ("device-b", 1)]);
        let b = clock_of([("device-b", 3), ("device-c", 1)]);
        let expected = clock_of([("device-a", 2), ("device-b", 3), ("device-c", 1)]);
        assert_eq!(merge(&a, &b), expected);
        assert_eq!(merge(&b, &a), expected);
    }

    #[test]
    fn compare_runs_over_the_union_of_both_key_sets() {
        let a = clock_of([("device-a", 1)]);
        assert_eq!(compare(&a, &clock_of([("device-a", 1)])), ClockOrder::Equal);
        assert_eq!(
            compare(&a, &clock_of([("device-a", 2)])),
            ClockOrder::Before
        );
        assert_eq!(compare(&clock_of([("device-a", 2)]), &a), ClockOrder::After);
        assert_eq!(
            compare(&a, &clock_of([("device-b", 1)])),
            ClockOrder::Concurrent
        );
    }

    #[test]
    fn offline_is_an_ordinary_key_in_the_algebra() {
        // §6.1: no special treatment, so carrying `_offline` makes `a` strictly
        // after `b` rather than concurrent with it.
        let a = clock_of([("device-a", 1), (OFFLINE_CLOCK_DEVICE_ID, 1)]);
        let b = clock_of([("device-a", 1)]);
        assert_eq!(compare(&a, &b), ClockOrder::After);
        assert_eq!(clock_total(&a), 2, "`_offline` is summed like any key");
    }

    #[test]
    fn rebinding_adds_the_ticks_rather_than_maxing_them() {
        let clock = clock_of([(OFFLINE_CLOCK_DEVICE_ID, 2), ("device-a", 5)]);
        assert_eq!(
            rebind_clock_device(&clock, "device-a"),
            clock_of([("device-a", 7)])
        );
    }

    #[test]
    fn a_zero_tick_offline_key_survives_rebinding() {
        // The asymmetry §6.3 depends on: rebinding needs `> 0`, the tie-break
        // needs only presence.
        let clock = clock_of([(OFFLINE_CLOCK_DEVICE_ID, 0), ("device-a", 1)]);
        assert_eq!(rebind_clock_device(&clock, "device-a"), clock);
        assert!(has_offline_key(&rebind_clock_device(&clock, "device-a")));
    }
}
