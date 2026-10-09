//! One journal item per day (protocol §1.9, #2939). Mirrors
//! `planJournalDayApply` in `packages/domain-notes/src/journal/day-identity.ts`,
//! pinned by the `dayIdentity` section of `journal.json`.

/// What apply does with an incoming journal item for a day.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JournalDayApplyPlan {
    /// Apply the incoming item as the day's row. Only the canonical id is applied.
    pub apply_incoming: bool,
    /// Foreign ids whose body is owed to the canonical day, then a tombstone.
    pub owe_merge: Vec<String>,
    /// The local row holding the day is foreign and gives the path to the
    /// incoming canonical item. Only when the incoming item is applied: a
    /// foreign row stays until the drain sweeps it.
    pub remove_holder: bool,
}

/// The canonical id of a day: `j<YYYY-MM-DD>`.
pub fn canonical_journal_id(date: &str) -> String {
    format!("j{date}")
}

/// `planJournalDayApply(incomingId, date, holderId)`.
pub fn plan_journal_day_apply(
    incoming_id: &str,
    date: &str,
    holder_id: Option<&str>,
) -> JournalDayApplyPlan {
    let canonical = canonical_journal_id(date);
    let holder_foreign = holder_id.is_some_and(|holder| holder != canonical);
    let mut owe_merge = Vec::new();
    if incoming_id != canonical {
        owe_merge.push(incoming_id.to_owned());
    }
    if let Some(holder) = holder_id.filter(|h| holder_foreign && *h != incoming_id) {
        owe_merge.push(holder.to_owned());
    }
    let apply_incoming = incoming_id == canonical;
    JournalDayApplyPlan {
        apply_incoming,
        owe_merge,
        remove_holder: holder_foreign && apply_incoming,
    }
}

/// What the drain does next with one owed merge `F -> D` (§1.9.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JournalDayMergeAction {
    /// Stays owed: the body has not fully arrived, or a live `F` has none.
    Wait,
    /// Settles without folding or tombstoning.
    Forget,
    /// `j<D>` is deleted here: it is not re-created, `F` is dropped.
    Drop,
    /// Ensure `j<D>`, relink tasks, fold `F` into it.
    Merge,
}

impl JournalDayMergeAction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Wait => "wait",
            Self::Forget => "forget",
            Self::Drop => "drop",
            Self::Merge => "merge",
        }
    }
}

/// The inputs of [`plan_journal_day_merge`]; see `JournalDayMergeState`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct JournalDayMergeState {
    pub deleted: bool,
    pub body_pulled: bool,
    pub has_body: bool,
    pub day_deleted: bool,
    pub clocked: bool,
}

/// `planJournalDayMerge(state)`: the action, and whether `F`'s tombstone is
/// owed at `increment(F.clock, self)`.
pub fn plan_journal_day_merge(state: JournalDayMergeState) -> (JournalDayMergeAction, bool) {
    let tombstone = !state.deleted && state.clocked;
    if !state.deleted && !state.body_pulled {
        return (JournalDayMergeAction::Wait, false);
    }
    if !state.has_body {
        let action = if state.deleted {
            JournalDayMergeAction::Forget
        } else {
            JournalDayMergeAction::Wait
        };
        return (action, false);
    }
    let action = if state.day_deleted {
        JournalDayMergeAction::Drop
    } else {
        JournalDayMergeAction::Merge
    };
    (action, tombstone)
}
