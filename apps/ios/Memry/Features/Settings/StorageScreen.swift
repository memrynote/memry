import MemryCore
import SwiftUI

// Spec 006 ST32, artboard 03. Usage bar and legend from `GET /sync/storage`,
// the plan's limits, and the notes near the sync limit (desktop
// `note-size.ts`: over 3.6 MB stops syncing, 80 % of it is "approaching").
struct StorageScreen: View {
    let context: SettingsContext
    @State private var large: [LargeNote] = []
    @State private var failure: UserFacingError?

    var body: some View {
        List {
            if let storage = context.account.storage {
                Section {
                    VStack(alignment: .leading, spacing: Tokens.Space.small) {
                        HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.small) {
                            Text(ByteCountFormatter.memry(storage.used))
                                .font(Tokens.Typography.sectionTitle.font)
                                .foregroundStyle(Tokens.Text.primary.color)
                            Text(SettingsCopy.usedOf(ByteCountFormatter.memry(storage.limit)))
                                .font(Tokens.Typography.supporting.font)
                                .foregroundStyle(Tokens.Text.secondary.color)
                        }
                        StorageBar(segments: segments(storage), limit: storage.limit)
                    }
                    .padding(.vertical, Tokens.Space.small)
                    .accessibilityElement(children: .combine)
                    ForEach(legend(storage), id: \.0) { name, bytes, color in
                        HStack(spacing: Tokens.Space.medium) {
                            Circle().fill(color).frame(width: Tokens.Space.small, height: Tokens.Space.small)
                                .accessibilityHidden(true)
                            LabeledContent(name, value: ByteCountFormatter.memry(bytes))
                        }
                    }
                } header: {
                    Text(SettingsCopy.account)
                } footer: {
                    if let billing = context.account.billing {
                        SettingsFooter(SettingsCopy.planLimits(
                            plan: SettingsLabels.plan(billing.plan),
                            maxFile: ByteCountFormatter.memry(billing.maxFileSize),
                            vaults: billing.maxVaults,
                            days: billing.versionHistoryDays
                        ))
                    }
                }
            } else if let failure = context.account.failure {
                Section { ErrorNotice(error: failure, code: nil) }
            } else {
                Section { ProgressView() }
            }
            Section {
                if large.isEmpty {
                    Text(SettingsCopy.noLargeNotes)
                        .font(Tokens.Typography.body.font)
                        .foregroundStyle(Tokens.Text.secondary.color)
                }
                ForEach(large, id: \.id) { note in
                    NavigationLink(value: NoteRoute(id: note.id)) {
                        SettingsRowLabel(
                            title: note.title.isEmpty ? "Untitled" : note.title,
                            detail: note.overLimit
                                ? SettingsCopy.notSyncing(ByteCountFormatter.memry(note.bytes))
                                : SettingsCopy.approaching(ByteCountFormatter.memry(note.bytes))
                        )
                    }
                }
            } header: {
                Text(SettingsCopy.nearLimit)
            } footer: {
                SettingsFooter(SettingsCopy.limitFooter(ByteCountFormatter.memry(3_826_919)))
            }
            if let failure { Section { ErrorNotice(error: failure, code: nil) } }
        }
        .settingsList()
        .navigationTitle(SettingsCopy.storage)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await context.account.load()
            await context.account.loadStorage()
            let notes = context.notes
            do {
                large = try await context.executor.run { try notes.largeNotes() }
            } catch {
                failure = ErrorMapping.userFacing(error)
            }
        }
    }

    private func legend(_ storage: StorageUsage) -> [(String, Int64, Color)] {
        [
            (SettingsCopy.notes, storage.notes, Tokens.Tint.base.color),
            (SettingsCopy.attachments, storage.attachments, Tokens.Task.progress.color),
            (SettingsCopy.editHistory, storage.crdt, Tokens.Task.tokenTag.color),
            (SettingsCopy.other, storage.other, Tokens.Text.tertiary.color)
        ]
    }

    private func segments(_ storage: StorageUsage) -> [StorageBar.Segment] {
        legend(storage).map { StorageBar.Segment(id: $0.0, bytes: $0.1, color: $0.2) }
    }
}
