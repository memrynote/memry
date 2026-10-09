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
    /// The local row holding the day is foreign and leaves before anything is written.
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
    JournalDayApplyPlan {
        apply_incoming: incoming_id == canonical,
        owe_merge,
        remove_holder: holder_foreign,
    }
}
