//! Local wall-clock time without a date crate. Unix asks `localtime_r`, Windows
//! `GetLocalTime`; both give the offset in force at that instant.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stamp {
    pub year: i32,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    pub second: u32,
    pub millis: u32,
}

impl Stamp {
    /// `YYYY-MM-DD HH:MM:SS.mmm`, the prefix every log line starts with.
    pub fn render(&self) -> String {
        format!(
            "{:04}-{:02}-{:02} {:02}:{:02}:{:02}.{:03}",
            self.year, self.month, self.day, self.hour, self.minute, self.second, self.millis
        )
    }
}

#[cfg(unix)]
pub fn now() -> Stamp {
    let since_epoch = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let seconds = since_epoch.as_secs() as libc::time_t;
    // SAFETY: `tm` is plain data that `localtime_r` fills, and `seconds` outlives the call.
    let tm = unsafe {
        let mut tm: libc::tm = std::mem::zeroed();
        if libc::localtime_r(&seconds, &mut tm).is_null() {
            return utc(since_epoch);
        }
        tm
    };
    Stamp {
        year: tm.tm_year + 1900,
        month: (tm.tm_mon + 1) as u32,
        day: tm.tm_mday as u32,
        hour: tm.tm_hour as u32,
        minute: tm.tm_min as u32,
        second: tm.tm_sec as u32,
        millis: since_epoch.subsec_millis(),
    }
}

#[cfg(windows)]
pub fn now() -> Stamp {
    use windows::Win32::System::SystemInformation::GetLocalTime;
    // SAFETY: `GetLocalTime` takes no input and returns a value.
    let time = unsafe { GetLocalTime() };
    Stamp {
        year: i32::from(time.wYear),
        month: u32::from(time.wMonth),
        day: u32::from(time.wDay),
        hour: u32::from(time.wHour),
        minute: u32::from(time.wMinute),
        second: u32::from(time.wSecond),
        millis: u32::from(time.wMilliseconds),
    }
}

/// UTC civil time, the fallback when the OS cannot answer.
pub fn utc(since_epoch: std::time::Duration) -> Stamp {
    let secs = since_epoch.as_secs();
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // Civil-from-days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = (yoe + era * 400 + i64::from(month <= 2)) as i32;
    Stamp {
        year,
        month,
        day,
        hour: (rem / 3_600) as u32,
        minute: (rem % 3_600 / 60) as u32,
        second: (rem % 60) as u32,
        millis: since_epoch.subsec_millis(),
    }
}

/// Days since 1970-01-01 of a civil date (Howard Hinnant).
pub fn days_from_civil(year: i32, month: u32, day: u32) -> i64 {
    let y = i64::from(year) - i64::from(month <= 2);
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = (i64::from(month) + 9) % 12;
    let doy = (153 * mp + 2) / 5 + i64::from(day) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

impl Stamp {
    /// Whole minutes since the epoch of this civil time, read as if it were UTC.
    pub fn epoch_minutes(&self) -> i64 {
        days_from_civil(self.year, self.month, self.day) * 1_440
            + i64::from(self.hour) * 60
            + i64::from(self.minute)
    }
}

/// `Date.prototype.getTimezoneOffset()`: minutes the local clock is **behind** UTC, so UTC+2
/// is -120.
pub fn timezone_offset_minutes() -> i32 {
    let local = now();
    let since_epoch = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let offset = utc(since_epoch).epoch_minutes() - local.epoch_minutes();
    // A clock tick between the two reads can move the difference by one minute; the real
    // offsets are multiples of 15.
    ((offset + 7).div_euclid(15) * 15).clamp(-840, 840) as i32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stamp_renders_in_the_log_format() {
        let stamp = Stamp {
            year: 2026,
            month: 3,
            day: 9,
            hour: 4,
            minute: 5,
            second: 6,
            millis: 7,
        };
        assert_eq!(stamp.render(), "2026-03-09 04:05:06.007");
    }

    #[test]
    fn the_offset_is_a_quarter_hour_multiple_in_range() {
        let offset = timezone_offset_minutes();
        assert_eq!(offset % 15, 0);
        assert!((-840..=840).contains(&offset));
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(2000, 3, 1), 11_017);
    }

    #[test]
    fn now_is_a_plausible_date() {
        let stamp = now();
        assert!(
            stamp.year >= 2026 && (1..=12).contains(&stamp.month) && (1..=31).contains(&stamp.day)
        );
        assert_eq!(stamp.render().len(), 23);
    }
}
