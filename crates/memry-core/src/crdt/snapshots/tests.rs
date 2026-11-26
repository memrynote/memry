use super::*;

#[test]
fn the_watermark_never_walks_forward_once_a_snapshot_exists() {
    // §7.6: the server reuses the existing sequence number, so the two
    // agree and nothing moves.
    assert_eq!(stable_watermark(Some(12), Some(12)), 12);
    // A server that answered higher is not believed: believing it would
    // hide updates 13..=30 from `load_plan` forever.
    assert_eq!(stable_watermark(Some(12), Some(30)), 12);
    // The first snapshot for a document takes whatever the server gave it.
    assert_eq!(stable_watermark(None, Some(7)), 7);
    // A server that answered nothing, on a fresh document, keeps every
    // update pullable.
    assert_eq!(stable_watermark(None, None), 0);
    assert_eq!(stable_watermark(Some(4), None), 4);
}

#[test]
fn every_refusal_carries_its_own_reason() {
    let reasons: Vec<&str> = [
        Refusal::UnmergedRemoteState,
        Refusal::LocalOnly,
        Refusal::Purged,
        Refusal::EmptyState,
        Refusal::PurgedSinceLoad,
    ]
    .iter()
    .map(Refusal::reason)
    .collect();
    // Each refusal clears its own way; a shared message names the wrong one.
    let mut unique = reasons.clone();
    unique.sort_unstable();
    unique.dedup();
    assert_eq!(unique.len(), reasons.len());
}
