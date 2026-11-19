//! Feedback on filing suggestions (parity row inv04#30): Electron's
//! `trackSuggestionFeedback` and `getSuggestionStats`
//! (`apps/desktop/src/main/inbox/suggestions.ts:840-919`), over the local
//! `inbox_suggestion_feedback` table (data migration 0041).

use rusqlite::{Connection, params};

use crate::api::errors::StorageError;
use crate::domain::notes::failed;

use super::write::mint_id;

/// One choice the user made after seeing a suggestion.
#[derive(Debug, Clone, PartialEq)]
pub struct Feedback<'a> {
    pub item_id: &'a str,
    pub item_type: &'a str,
    pub suggested_to: &'a str,
    pub actual_to: &'a str,
    /// The suggestion's confidence, 0..1.
    pub confidence: f64,
    pub suggested_tags: &'a [String],
    pub actual_tags: &'a [String],
}

/// `getSuggestionStats`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FeedbackStats {
    pub total: i64,
    pub accepted: i64,
    pub rejected: i64,
    /// `accepted / total`, 0 with no feedback.
    pub acceptance_rate: f64,
}

/// `trackSuggestionFeedback`: accepted when the user filed where suggested;
/// the confidence is stored as `Math.round(confidence * 100)`.
pub fn track(conn: &Connection, feedback: &Feedback<'_>, now_ms: i64) -> Result<(), StorageError> {
    let accepted = feedback.suggested_to == feedback.actual_to;
    // `Math.round` and `f64::round` agree on a confidence, which is never negative.
    let confidence = (feedback.confidence * 100.0).round() as i64;
    // A `Vec<String>` always serialises.
    let json = |tags: &[String]| serde_json::to_string(tags).unwrap_or_else(|_| "[]".to_owned());
    conn.execute(
        "INSERT INTO inbox_suggestion_feedback
           (id, item_id, item_type, suggested_to, actual_to, accepted, confidence,
            suggested_tags, actual_tags, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            mint_id(),
            feedback.item_id,
            feedback.item_type,
            feedback.suggested_to,
            feedback.actual_to,
            accepted,
            confidence,
            json(feedback.suggested_tags),
            json(feedback.actual_tags),
            now_ms,
        ],
    )
    .map_err(failed)?;
    Ok(())
}

/// `getSuggestionStats` over every recorded choice.
pub fn stats(conn: &Connection) -> Result<FeedbackStats, StorageError> {
    let (total, accepted): (i64, i64) = conn
        .query_row(
            "SELECT count(*), coalesce(sum(accepted = 1), 0) FROM inbox_suggestion_feedback",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(failed)?;
    Ok(FeedbackStats {
        total,
        accepted,
        rejected: total - accepted,
        acceptance_rate: if total > 0 {
            accepted as f64 / total as f64
        } else {
            0.0
        },
    })
}
