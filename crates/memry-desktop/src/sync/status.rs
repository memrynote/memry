//! The sync status the renderer shows (`GetSyncStatusResult` in `ipc-sync-ops.ts`), derived from
//! what the supervisor knows. Electron reports a sync that never started as `idle`
//! (`sync-core-handlers.ts:205-216`) and demotes an unpaid account to `local_only` (#2201,
//! `sync-state-manager.ts:79-89`); both are kept.

use memry_core::sync::state::SyncState;
use serde::Serialize;

use super::error_category::SyncErrorCategory;
use super::gate::{GateDecision, SyncNotStartedReason};

/// `SyncStatusValue`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum SyncStatusValue {
    Idle,
    Syncing,
    Offline,
    Error,
    LocalOnly,
    Paused,
}

/// `GetSyncStatusResult`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub status: SyncStatusValue,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_sync_at: Option<i64>,
    pub pending_count: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_category: Option<SyncErrorCategory>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offline_since: Option<i64>,
}

/// What the status is derived from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusFacts {
    pub gate: GateDecision,
    pub paused: bool,
    pub online: bool,
    pub syncing: bool,
    /// Where the last pass left the engine.
    pub engine: Option<SyncState>,
    /// The last pass's failure, as shown and as categorized.
    pub last_error: Option<(String, SyncErrorCategory)>,
    pub last_sync_at: Option<i64>,
    pub pending: u32,
    pub offline_since: Option<i64>,
}

pub fn derive(facts: &StatusFacts) -> SyncStatus {
    use SyncStatusValue as V;
    let mut error = None;
    let status = match facts.gate {
        GateDecision::NotStarted(SyncNotStartedReason::Unavailable) => V::Idle,
        GateDecision::NotStarted(_) => V::LocalOnly,
        GateDecision::Start if facts.paused => V::Paused,
        GateDecision::Start if !facts.online => V::Offline,
        GateDecision::Start if facts.syncing => V::Syncing,
        GateDecision::Start => match facts.engine {
            Some(SyncState::Unentitled) => V::LocalOnly,
            Some(SyncState::ReadOnly) => {
                error = Some((
                    "Sync writes are turned off for this app right now".to_owned(),
                    SyncErrorCategory::ServerError,
                ));
                V::Error
            }
            Some(SyncState::BlockedUpgrade) => {
                error = Some((
                    "Update Memry to keep syncing changes".to_owned(),
                    SyncErrorCategory::VersionIncompatible,
                ));
                V::Error
            }
            _ if facts.last_error.is_some() => {
                error.clone_from(&facts.last_error);
                V::Error
            }
            _ => V::Idle,
        },
    };
    let (error, error_category) = error.unzip();
    SyncStatus {
        status,
        last_sync_at: facts.last_sync_at,
        pending_count: facts.pending,
        error,
        error_category,
        offline_since: (status == V::Offline)
            .then_some(facts.offline_since)
            .flatten(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use SyncStatusValue as V;

    fn started() -> StatusFacts {
        StatusFacts {
            gate: GateDecision::Start,
            paused: false,
            online: true,
            syncing: false,
            engine: Some(SyncState::Idle),
            last_error: None,
            last_sync_at: Some(5),
            pending: 2,
            offline_since: None,
        }
    }

    #[test]
    fn a_sync_that_never_started_is_idle_and_a_gated_one_local_only() {
        let not = |reason| StatusFacts {
            gate: GateDecision::NotStarted(reason),
            ..started()
        };
        assert_eq!(
            derive(&not(SyncNotStartedReason::Unavailable)).status,
            V::Idle
        );
        for reason in [
            SyncNotStartedReason::VaultBinding,
            SyncNotStartedReason::VaultForeign,
            SyncNotStartedReason::Entitlement,
        ] {
            assert_eq!(derive(&not(reason)).status, V::LocalOnly, "{reason:?}");
        }
    }

    #[test]
    fn paused_offline_and_syncing_in_that_order() {
        let all = StatusFacts {
            paused: true,
            online: false,
            syncing: true,
            offline_since: Some(9),
            ..started()
        };
        assert_eq!(derive(&all).status, V::Paused);
        let offline = derive(&StatusFacts {
            paused: false,
            ..all.clone()
        });
        assert_eq!(offline.status, V::Offline);
        assert_eq!(offline.offline_since, Some(9));
        assert_eq!(
            derive(&StatusFacts {
                paused: false,
                online: true,
                ..all
            })
            .status,
            V::Syncing
        );
    }

    #[test]
    fn blocked_engine_states_map_to_their_category() {
        let at = |state| {
            derive(&StatusFacts {
                engine: Some(state),
                ..started()
            })
        };
        assert_eq!(at(SyncState::Unentitled).status, V::LocalOnly);
        let read_only = at(SyncState::ReadOnly);
        assert_eq!(read_only.status, V::Error);
        assert_eq!(
            read_only.error_category,
            Some(SyncErrorCategory::ServerError)
        );
        let upgrade = at(SyncState::BlockedUpgrade);
        assert_eq!(
            upgrade.error_category,
            Some(SyncErrorCategory::VersionIncompatible)
        );
    }

    #[test]
    fn a_failed_pass_is_an_error_with_its_category_and_serializes_as_the_contract() {
        let failed = derive(&StatusFacts {
            engine: Some(SyncState::Failed),
            last_error: Some(("rate limited".into(), SyncErrorCategory::RateLimited)),
            ..started()
        });
        assert_eq!(
            serde_json::to_value(&failed).unwrap(),
            serde_json::json!({
                "status": "error",
                "lastSyncAt": 5,
                "pendingCount": 2,
                "error": "rate limited",
                "errorCategory": "rate_limited",
            })
        );
        let idle = serde_json::to_value(derive(&started())).unwrap();
        assert_eq!(
            idle,
            serde_json::json!({"status": "idle", "lastSyncAt": 5, "pendingCount": 2})
        );
    }
}
