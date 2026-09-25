//! The records the `Inbox` surface hands the shell (spec 006 IB013).
//!
//! Instants cross as epoch milliseconds; `metadata` crosses as JSON text, the
//! shell reads the few keys it shows (`duration`, `pageCount`, `siteName`, ...)
//! because the shape is per type and open (`z.unknown()` on the wire).

use crate::domain::inbox::panel::{Panel, PanelEntry};
use crate::domain::inbox::stats::{CapturePattern, InboxStats};
use crate::domain::inbox::{self, InboxItem};

/// One capture.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct InboxItemRecord {
    pub id: String,
    /// `link | note | image | voice | video | clip | pdf | social | reminder`,
    /// or what a newer build wrote.
    pub item_type: String,
    pub title: String,
    pub content: Option<String>,
    pub metadata_json: Option<String>,
    pub filed_at_ms: Option<i64>,
    pub filed_to: Option<String>,
    pub filed_action: Option<String>,
    pub snoozed_until_ms: Option<i64>,
    pub snooze_reason: Option<String>,
    pub archived_at_ms: Option<i64>,
    pub viewed_at_ms: Option<i64>,
    pub source_url: Option<String>,
    pub source_title: Option<String>,
    pub capture_source: Option<String>,
    pub processing_status: Option<String>,
    pub transcription: Option<String>,
    pub transcription_status: Option<String>,
    /// Vault-relative; the file exists only on the capturing device.
    pub attachment_path: Option<String>,
    pub thumbnail_path: Option<String>,
    pub created_at_ms: i64,
    pub modified_at_ms: Option<i64>,
    pub tags: Vec<String>,
    /// Desktop's `isNoteOnlyType`: no task, event or reminder.
    pub is_note_only: bool,
    /// Desktop's `isBinaryType`: the capture is a file.
    pub is_binary: bool,
}

impl From<InboxItem> for InboxItemRecord {
    fn from(item: InboxItem) -> Self {
        let is_note_only = inbox::NOTE_ONLY_TYPES.contains(&item.item_type.as_str());
        let is_binary = inbox::BINARY_TYPES.contains(&item.item_type.as_str());
        Self {
            metadata_json: item.metadata.as_ref().map(ToString::to_string),
            id: item.id,
            item_type: item.item_type,
            title: item.title,
            content: item.content,
            filed_at_ms: item.filed_at,
            filed_to: item.filed_to,
            filed_action: item.filed_action,
            snoozed_until_ms: item.snoozed_until,
            snooze_reason: item.snooze_reason,
            archived_at_ms: item.archived_at,
            viewed_at_ms: item.viewed_at,
            source_url: item.source_url,
            source_title: item.source_title,
            capture_source: item.capture_source,
            processing_status: item.processing_status,
            transcription: item.transcription,
            transcription_status: item.transcription_status,
            attachment_path: item.attachment_path,
            thumbnail_path: item.thumbnail_path,
            created_at_ms: item.created_at,
            modified_at_ms: item.modified_at,
            tags: item.tags,
            is_note_only,
            is_binary,
        }
    }
}

/// A type and how many active captures have it.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct InboxTypeCount {
    pub item_type: String,
    pub count: i64,
}

/// Desktop's `InboxStats` plus the Insights rate and the Inbox Zero week.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct InboxStatsRecord {
    pub total_items: i64,
    pub stale_count: i64,
    pub snoozed_count: i64,
    pub captured_today: i64,
    pub processed_today: i64,
    pub avg_time_to_process_minutes: i64,
    pub captured_this_week: i64,
    pub processed_this_week: i64,
    pub capture_process_ratio_tenths: i64,
    pub process_rate: i64,
    pub age_fresh: i64,
    pub age_aging: i64,
    pub age_stale: i64,
    pub oldest_item_days: i64,
    pub current_streak: i64,
    pub filed_this_week: i64,
    /// Active captures still fetching link metadata.
    pub fetching: i64,
    /// Active captures minus viewed reminder captures.
    pub reviewable: i64,
}

impl InboxStatsRecord {
    pub(crate) fn new(stats: InboxStats, fetching: i64, reviewable: i64) -> Self {
        Self {
            total_items: stats.total_items,
            stale_count: stats.stale_count,
            snoozed_count: stats.snoozed_count,
            captured_today: stats.captured_today,
            processed_today: stats.processed_today,
            avg_time_to_process_minutes: stats.avg_time_to_process,
            captured_this_week: stats.captured_this_week,
            processed_this_week: stats.processed_this_week,
            capture_process_ratio_tenths: stats.capture_process_ratio_tenths,
            process_rate: stats.process_rate,
            age_fresh: stats.age_fresh,
            age_aging: stats.age_aging,
            age_stale: stats.age_stale,
            oldest_item_days: stats.oldest_item_days,
            current_streak: stats.current_streak,
            filed_this_week: stats.filed_this_week,
            fetching,
            reviewable,
        }
    }
}

/// One bar of the By type chart.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct InboxTypeShare {
    pub item_type: String,
    pub count: i64,
    pub percentage: i64,
}

/// The capture heatmap: 24 rows of 7 (Monday first), UTC.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct InboxPatternRecord {
    pub heatmap: Vec<Vec<i64>>,
    pub types: Vec<InboxTypeShare>,
    /// Monday = 0.
    pub peak_day: Option<u32>,
    pub peak_hour: Option<u32>,
}

impl From<CapturePattern> for InboxPatternRecord {
    fn from(pattern: CapturePattern) -> Self {
        Self {
            heatmap: pattern.heatmap,
            types: pattern
                .types
                .into_iter()
                .map(|(item_type, count, percentage)| InboxTypeShare {
                    item_type,
                    count,
                    percentage,
                })
                .collect(),
            peak_day: pattern.peak.map(|(day, _)| day),
            peak_hour: pattern.peak.map(|(_, hour)| hour),
        }
    }
}

/// One row of Snoozed & reminders.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct InboxPanelEntry {
    pub key: String,
    pub time_ms: i64,
    /// `note | journal | task | highlight | note_date`, or `None` for a
    /// snoozed capture that opens its own detail.
    pub target_type: Option<String>,
    pub target_id: Option<String>,
    pub target_title: Option<String>,
    pub project_id: Option<String>,
    pub item: Option<InboxItemRecord>,
}

impl From<PanelEntry> for InboxPanelEntry {
    fn from(entry: PanelEntry) -> Self {
        let target = entry.target;
        Self {
            key: entry.key,
            time_ms: entry.time_ms,
            target_type: target.as_ref().map(|t| t.target_type.clone()),
            target_id: target.as_ref().map(|t| t.target_id.clone()),
            target_title: target.as_ref().and_then(|t| t.target_title.clone()),
            project_id: target.and_then(|t| t.project_id),
            item: entry.item.map(InboxItemRecord::from),
        }
    }
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct InboxPanelRecord {
    pub upcoming: Vec<InboxPanelEntry>,
    pub past: Vec<InboxPanelEntry>,
}

impl From<Panel> for InboxPanelRecord {
    fn from(panel: Panel) -> Self {
        Self {
            upcoming: panel.upcoming.into_iter().map(Into::into).collect(),
            past: panel.past.into_iter().map(Into::into).collect(),
        }
    }
}
