import Foundation
import MemryCore

// JP049, D4. The three locale strings a template's `{{date}}`, `{{time}}` and
// `{{day-of-week}}` tokens take. The token substitution is the core's; only
// the formatting happens here, as on desktop (`applyJournalTemplate` in
// `hooks/use-journal-entry.ts`), which formats with `Intl.DateTimeFormat` in
// the app language (default `en-US`):
//
// - `longDate`: `{weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'}`,
//   "Monday, June 15, 2099".
// - `time`: `{hour: 'numeric', minute: '2-digit'}` of the current instant, "9:05 AM".
// - `dayOfWeek`: `{weekday: 'long'}`, "Monday".
//
// The phone has no app language setting, so the locale is the user's
// `Locale.current` (the phone's language and region). For an en-US phone the
// output matches desktop's `en-US` output; other locales get their own
// ordering, as desktop does for its other app languages. The skeletons below
// are the CLDR equivalents of those `Intl` options.
enum JournalSeedStrings {
    static func make(date: String, now: Date, locale: Locale = .current) -> JournalTemplateStrings? {
        guard let day = JournalDates.date(date) else { return nil }
        return JournalTemplateStrings(
            longDate: format(day, skeleton: "EEEEyMMMMd", locale: locale),
            time: format(now, skeleton: "jmm", locale: locale),
            dayOfWeek: format(day, skeleton: "EEEE", locale: locale)
        )
    }

    private static func format(_ date: Date, skeleton: String, locale: Locale) -> String {
        let formatter = DateFormatter()
        formatter.locale = locale
        // The zone the day key was parsed in, so the weekday is the key's.
        formatter.timeZone = JournalDates.calendar.timeZone
        formatter.setLocalizedDateFormatFromTemplate(skeleton)
        return formatter.string(from: date)
    }
}
