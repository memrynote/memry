//! The sync engine's states and the edges data-model §C.3 draws between them.
//!
//! Kept apart from [`super::engine`] so the diagram is one readable table
//! rather than a shape inferred from control flow. [`is_drawn`] is the table;
//! the engine asserts against it on every transition and a test walks a whole
//! pass's trail through it.
//!
//! **The three blocked states are distinct and must not be collapsed.** They
//! have different explanations and different exits: a kill switch clears
//! server side, an upgrade needs an App Store update, and an entitlement needs
//! a plan. FR-075 requires the same vocabulary as desktop for each, and a
//! client that showed one of them for another tells the user to do the wrong
//! thing.

/// Every state in data-model §C.3.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SyncState {
    Idle,
    Pulling,
    Applying,
    Pushing,
    /// Reachability says no. Reads are not gated by this — there is nothing to
    /// read from.
    Offline,
    /// 403 `PLATFORM_WRITES_DISABLED`, or the same fact learned from
    /// `clientPolicy` without attempting a write (chapter 11 §11.8).
    ReadOnly,
    /// 426 `CLIENT_UPGRADE_REQUIRED`, or a version below the policy floor.
    BlockedUpgrade,
    /// The account has no active plan.
    Unentitled,
    /// Transport or server error. Exits to `Idle` after backoff.
    Failed,
    /// The page breaker tripped (chapter 05 §5.14). **Not `Failed`**: the
    /// cursor advanced, so a retry cannot loop forever, and the run is marked
    /// unsuccessful so no success state is written. Also entered when a
    /// `/sync/pull` body is not a pull envelope (#2285); there the cursor
    /// holds, because the fault is the server's and the page must re-pull.
    Refused,
}

impl SyncState {
    /// Whether the outbox is parked here: no attempt, no backoff, no row
    /// removed (chapter 11 §11.9, §C.3).
    pub fn parks_outbox(self) -> bool {
        matches!(
            self,
            SyncState::ReadOnly | SyncState::BlockedUpgrade | SyncState::Unentitled
        )
    }

    /// Whether reads continue from here. **Every state except `Offline`.**
    /// The server does not gate `GET`, `HEAD` or `OPTIONS` either
    /// (chapter 11 §11.4), so this is the client agreeing with the server
    /// rather than compensating for it.
    pub fn reads_continue(self) -> bool {
        self != SyncState::Offline
    }
}

/// Whether §C.3 draws an edge from `from` to `to`.
///
/// Read this against the diagram line by line; it is a transcription, not a
/// generalisation, which is why there is no "any state may reach `Failed`"
/// catch-all.
pub fn is_drawn(from: SyncState, to: SyncState) -> bool {
    use SyncState::*;
    match from {
        Idle => matches!(
            to,
            Pulling | Pushing | Offline | ReadOnly | BlockedUpgrade | Unentitled
        ),
        Pulling => matches!(to, Applying | Idle | Offline | Failed),
        Applying => matches!(to, Pulling | Idle | Refused),
        // §C.3 draws `Pushing -> ReadOnly` and `Pushing -> BlockedUpgrade`
        // for a mid-wave 403 and 426 but no `Pushing -> Unentitled`, which
        // chapter 11 §11.7.1 makes reachable: a `402 SYNC_PAYMENT_REQUIRED`
        // arrives from **any** `/sync/*` route, and `/sync/push` is one. The
        // edge is drawn here because the alternative is reporting a billing
        // fact as `Failed`, which accrues backoff against a condition the
        // user cannot retry away (§11.9).
        Pushing => matches!(to, Idle | ReadOnly | BlockedUpgrade | Unentitled | Failed),
        // Reads continue, always; or the policy cleared on the next status poll.
        ReadOnly | BlockedUpgrade | Unentitled => matches!(to, Pulling | Idle),
        Offline => to == Idle,
        Failed => to == Idle,
        Refused => to == Idle,
    }
}

/// What started a pass. Recorded rather than acted on: §C.3 draws one entry
/// edge into `Pulling` for all four.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PassTrigger {
    Timer,
    Foreground,
    SocketHint,
    Explicit,
}

/// The write gate, learned from `clientPolicy` on `GET /sync/status`
/// **without attempting a write** (chapter 11 §11.8, FR-035).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WriteGate {
    Open,
    ReadOnly,
    BlockedUpgrade { min_version: Option<String> },
    Unentitled,
}

impl WriteGate {
    /// The state a blocked gate parks in, or `None` when writes may proceed.
    pub fn blocked_state(&self) -> Option<SyncState> {
        match self {
            WriteGate::Open => None,
            WriteGate::ReadOnly => Some(SyncState::ReadOnly),
            WriteGate::BlockedUpgrade { .. } => Some(SyncState::BlockedUpgrade),
            WriteGate::Unentitled => Some(SyncState::Unentitled),
        }
    }
}

/// §11.7: **an unreadable policy degrades to allow, never to a lockout.**
///
/// Only `writesEnabled === false` and a strictly-below version comparison
/// deny. No row, a blank floor, and a floor that is not a plain
/// `major.minor.patch` triple all resolve to allowed.
pub fn evaluate_gate(
    writes_enabled: bool,
    min_write_version: Option<&str>,
    client_version: &str,
    entitled: bool,
) -> WriteGate {
    if !entitled {
        return WriteGate::Unentitled;
    }
    // §11.5: the kill switch is evaluated **before** the version floor.
    // Answering `CLIENT_UPGRADE_REQUIRED` when writes are off for the whole
    // platform sends users chasing an update that cannot help them.
    if !writes_enabled {
        return WriteGate::ReadOnly;
    }
    let Some(floor) = min_write_version.map(str::trim).filter(|v| !v.is_empty()) else {
        return WriteGate::Open;
    };
    // §11.2: the `+build` suffix is recorded and **never compared**, so it is
    // dropped before the triple compare rather than making the whole version
    // unparseable and silently degrading to allow.
    let client_version = client_version.split('+').next().unwrap_or(client_version);
    match (triple(floor), triple(client_version)) {
        (Some(floor_triple), Some(client_triple)) if client_triple < floor_triple => {
            WriteGate::BlockedUpgrade {
                min_version: Some(floor.to_owned()),
            }
        }
        _ => WriteGate::Open,
    }
}

/// A plain `major.minor.patch` triple, or `None`.
///
/// **Pre-release identifiers are rejected on purpose** (§11.2): the floor
/// comparison is numeric, so accepting `1.0.0-beta.1` would let a beta satisfy
/// a floor its release does not.
fn triple(version: &str) -> Option<(u64, u64, u64)> {
    let mut parts = version.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_continue_from_every_blocked_state() {
        for state in [
            SyncState::ReadOnly,
            SyncState::BlockedUpgrade,
            SyncState::Unentitled,
        ] {
            assert!(state.reads_continue());
            assert!(state.parks_outbox());
            assert!(is_drawn(state, SyncState::Pulling));
        }
        assert!(!SyncState::Offline.reads_continue());
    }

    #[test]
    fn refused_is_not_failed() {
        assert!(is_drawn(SyncState::Applying, SyncState::Refused));
        assert!(
            !is_drawn(SyncState::Applying, SyncState::Failed),
            "a breaker trip is not a transport failure"
        );
        assert!(is_drawn(SyncState::Refused, SyncState::Idle));
    }

    #[test]
    fn an_unreadable_policy_degrades_to_allow() {
        assert_eq!(evaluate_gate(true, None, "1.0.0", true), WriteGate::Open);
        assert_eq!(
            evaluate_gate(true, Some(""), "1.0.0", true),
            WriteGate::Open
        );
        assert_eq!(
            evaluate_gate(true, Some("not-a-version"), "1.0.0", true),
            WriteGate::Open
        );
        assert_eq!(
            evaluate_gate(true, Some("1.2.0"), "1.1.9", true),
            WriteGate::BlockedUpgrade {
                min_version: Some("1.2.0".to_owned())
            }
        );
        assert_eq!(
            evaluate_gate(true, Some("1.2.0"), "1.2.0", true),
            WriteGate::Open
        );
        // §11.2: the build suffix is dropped, not treated as unparseable.
        assert_eq!(
            evaluate_gate(true, Some("1.2.0"), "1.1.9+77", true),
            WriteGate::BlockedUpgrade {
                min_version: Some("1.2.0".to_owned())
            }
        );
    }

    #[test]
    fn the_kill_switch_outranks_the_version_floor_and_the_plan_outranks_both() {
        assert_eq!(
            evaluate_gate(false, Some("9.9.9"), "1.0.0", true),
            WriteGate::ReadOnly
        );
        assert_eq!(
            evaluate_gate(false, Some("9.9.9"), "1.0.0", false),
            WriteGate::Unentitled
        );
    }

    #[test]
    fn a_pre_release_identifier_does_not_satisfy_a_floor() {
        assert_eq!(triple("1.0.0-beta.1"), None);
        assert_eq!(triple("1.0.0"), Some((1, 0, 0)));
        assert_eq!(triple("1.0.0.1"), None);
    }
}
