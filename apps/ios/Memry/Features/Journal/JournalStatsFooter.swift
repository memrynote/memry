import MemryCore
import SwiftUI

// JP051 (J03). Desktop's stats footer: words, characters, reading time at
// 200 words a minute and the modified date, under the Day section, only
// when the device-local switch is on (D9, `JournalPreferences`) and the day
// has an entry (desktop renders it only with `documentStats`).

struct JournalStatsFooter: View {
    let day: JournalDayRecord?
    @AppStorage private var isOn: Bool

    init(day: JournalDayRecord?, vaultId: String) {
        self.day = day
        _isOn = AppStorage(wrappedValue: false, JournalPreferences.statsFooterKey(vaultId: vaultId))
    }

    var body: some View {
        if isOn, let day {
            let line = JournalCopy.statsLine(
                words: day.wordCount,
                characters: day.characterCount,
                modifiedAt: day.modifiedAt,
                createdAt: day.createdAt
            )
            Text(line)
                .font(Tokens.Typography.caption.font)
                .foregroundStyle(Tokens.Text.tertiary.color)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
                .padding(.top, Tokens.Space.medium)
                .accessibilityLabel(JournalCopy.documentStatistics)
                .accessibilityValue(line)
                .accessibilityIdentifier("journal.day.stats")
        }
    }
}
