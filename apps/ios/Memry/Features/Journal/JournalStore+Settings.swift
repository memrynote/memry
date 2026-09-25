import Foundation
import MemryCore

// JP048, D9. Settings › Journal writes: the default template and one template
// per absolute weekday (0 = Sunday). Both are synced settings the core merges
// with per-field clocks; neither touches a day, so they go through
// `perform(date: nil)` and then re-read the settings.
extension JournalStore {
    /// Sets the default template, or clears it with `nil`. `true` when the
    /// core took the write.
    @discardableResult
    func setDefaultTemplate(_ templateId: String?) async -> Bool {
        let written = await perform(date: nil) { core in
            try core.setDefaultTemplate(templateId: templateId)
        }
        await loadSettings()
        return written != nil
    }

    /// Sets the template of one absolute weekday (0 = Sunday), or writes an
    /// explicit `null` with `nil`, as desktop's `setWeekdayTemplate` does: the
    /// entry is what the per-day sync clock refers to.
    @discardableResult
    func setWeekdayTemplate(_ weekday: Int, templateId: String?) async -> Bool {
        guard let day = UInt8(exactly: weekday), day < 7 else { return false }
        let written = await perform(date: nil) { core in
            try core.setWeekdayTemplate(weekday: day, templateId: templateId)
        }
        await loadSettings()
        return written != nil
    }
}
