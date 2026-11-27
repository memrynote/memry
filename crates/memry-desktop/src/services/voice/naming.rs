//! How a finished transcript names a voice memo (`resolveVoiceMemoTitle` in `transcription.ts`):
//! the `memoNameMode` setting turned into core's [`VoiceMemoName`], which renames only a memo
//! that still has its default title.

use chrono::{TimeZone, Utc};
use memry_core::domain::inbox::enrich::VoiceMemoName;

use super::MemoNameMode;

/// `transcript` names the memo after the first sentence, `timestamp` after its creation time in
/// `zone` (`titleFromTimestamp`, the local time), `none` keeps the title.
pub fn memo_name<Tz: TimeZone>(mode: MemoNameMode, created_at_ms: i64, zone: &Tz) -> VoiceMemoName
where
    Tz::Offset: std::fmt::Display,
{
    match mode {
        MemoNameMode::Transcript => VoiceMemoName::Transcript,
        MemoNameMode::None => VoiceMemoName::Keep,
        MemoNameMode::Timestamp => match Utc.timestamp_millis_opt(created_at_ms).single() {
            Some(created) => VoiceMemoName::Title(
                created
                    .with_timezone(zone)
                    .format("Voice memo %Y-%m-%d %H:%M")
                    .to_string(),
            ),
            None => VoiceMemoName::Keep,
        },
    }
}
