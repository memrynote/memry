//! A CalDAV update that met a 412 (`push-conflict-retry.ts`): the shell fetched what the server
//! holds now, and the core merges it into the item before the shell's one retry.

use crate::api::calendar::VaultCalendar;
use crate::api::calendar_provider_sync::CalendarCaldavObject;
use crate::api::calendar_providers::CalendarFeedZones;
use crate::api::errors::StorageError;
use crate::domain::calendar_items::ical::IcalZones;
use crate::domain::calendar_items::ics;
use crate::domain::calendar_items::providers::{Target, caldav, caldav_bound};

impl VaultCalendar {
    /// Merges `object`, the server's copy of the item's bound object, into the item
    /// ([`caldav_bound::merge_remote`]). Answers the item's queue stamp afterwards: the retry's
    /// `push_done` takes it, since the merge itself queued the item again.
    pub fn caldav_merge_conflict(
        &self,
        source_type: String,
        source_id: String,
        object: CalendarCaldavObject,
        zones: CalendarFeedZones,
    ) -> Result<Option<i64>, StorageError> {
        let target = Target {
            source_type,
            source_id,
        };
        self.write(move |conn, device, now| {
            let zones: IcalZones = zones.into();
            let object = caldav::Object {
                href: object.href,
                etag: object.etag,
                data: object.data,
            };
            caldav_bound::merge_remote(
                conn,
                &target,
                &object,
                ics::window(now),
                &zones,
                device,
                now,
            )
        })
    }
}
