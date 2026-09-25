import MemryCore
import SwiftUI

// IB07 / IB08. What a row can do, and the two gestures that reach it.
//
// Swipe (Paper 07): leading = File (the File sheet; no suggestions on iOS,
// §6 IB001/F8), trailing = Snooze (presets) and Archive (Undo toast).
// Long press (Paper 08): a quick-file row of recent folders, File…, Convert
// to ›, Snooze ›, Rename (not for notes or reminders, desktop's rule), Open
// link (when there is one), Select, Archive.

/// The sheets and modes a row asks the screen for.
struct InboxRowIntents {
    var file: (InboxItemRecord) -> Void = { _ in }
    var quickFile: (InboxItemRecord, String) -> Void = { _, _ in }
    var convert: (InboxItemRecord) -> Void = { _ in }
    var pickSnooze: ([String]) -> Void = { _ in }
    var rename: (InboxItemRecord) -> Void = { _ in }
    var select: (InboxItemRecord) -> Void = { _ in }
}

extension EnvironmentValues {
    @Entry var inboxRowIntents = InboxRowIntents()
}

struct InboxRowActionsModifier: ViewModifier {
    let item: InboxItemRecord
    let store: InboxStore
    let enabled: Bool
    @Environment(\.inboxRowIntents) private var intents
    @Environment(\.openURL) private var openURL

    func body(content: Content) -> some View {
        if enabled {
            content
                .swipeActions(edge: .leading, allowsFullSwipe: true) {
                    Button { intents.file(item) } label: {
                        Label(InboxCopy.file, systemImage: "folder")
                    }
                    .tint(Tokens.Inbox.link.color)
                    .accessibilityIdentifier("inbox.swipe.file")
                }
                .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                    Button {
                        Task { await store.archive(item) }
                    } label: {
                        Label(InboxCopy.archive, systemImage: "archivebox")
                    }
                    .tint(Tokens.Text.secondary.color)
                    .accessibilityIdentifier("inbox.swipe.archive")
                    Menu {
                        InboxSnoozeMenuItems(now: store.clock()) { date in
                            Task { await store.snooze([item.id], until: date) }
                        } pickDate: {
                            intents.pickSnooze([item.id])
                        }
                    } label: {
                        Label(InboxCopy.snooze, systemImage: "moon.zzz")
                    }
                    .tint(Tokens.Inbox.voice.color)
                    .accessibilityIdentifier("inbox.swipe.snooze")
                }
                .contextMenu { menu }
                .accessibilityAction(named: InboxCopy.file) { intents.file(item) }
                .accessibilityAction(named: InboxCopy.snooze) { intents.pickSnooze([item.id]) }
                .accessibilityAction(named: InboxCopy.archive) { Task { await store.archive(item) } }
        } else {
            content
        }
    }

    @ViewBuilder private var menu: some View {
        if !store.recentFolders.isEmpty {
            Section(InboxCopy.quickFileRecent) {
                ControlGroup {
                    ForEach(store.recentFolders.prefix(3), id: \.self) { folder in
                        Button {
                            intents.quickFile(item, folder)
                        } label: {
                            Label(InboxFolderName.display(folder), systemImage: "folder")
                        }
                    }
                }
                .controlGroupStyle(.compactMenu)
            }
        }
        Button(InboxCopy.fileEllipsis, systemImage: "folder") { intents.file(item) }
            .accessibilityIdentifier("inbox.menu.file")
        if !item.isNoteOnly {
            Button(InboxCopy.convertTo, systemImage: "arrow.triangle.2.circlepath") { intents.convert(item) }
                .accessibilityIdentifier("inbox.menu.convert")
        }
        Menu {
            InboxSnoozeMenuItems(now: store.clock()) { date in
                Task { await store.snooze([item.id], until: date) }
            } pickDate: {
                intents.pickSnooze([item.id])
            }
        } label: {
            Label(InboxCopy.snooze, systemImage: "moon.zzz")
        }
        .accessibilityIdentifier("inbox.menu.snooze")
        Section {
            if item.itemType != "note", item.itemType != "reminder" {
                Button(InboxCopy.rename, systemImage: "pencil") { intents.rename(item) }
                    .accessibilityIdentifier("inbox.menu.rename")
            }
            if let link = item.sourceUrl, let url = URL(string: link) {
                Button(InboxCopy.openLink, systemImage: "safari") { openURL(url) }
                    .accessibilityIdentifier("inbox.menu.openLink")
            }
            Button(InboxCopy.select, systemImage: "checkmark.circle") { intents.select(item) }
                .accessibilityIdentifier("inbox.menu.select")
        }
        Button(InboxCopy.archive, systemImage: "archivebox", role: .destructive) {
            Task { await store.archive(item) }
        }
        .accessibilityIdentifier("inbox.menu.archive")
    }
}

extension View {
    func inboxRowActions(_ item: InboxItemRecord, store: InboxStore, enabled: Bool = true) -> some View {
        modifier(InboxRowActionsModifier(item: item, store: store, enabled: enabled))
    }
}

/// A folder path as a person reads it: the vault root is "Notes", a nested
/// folder shows its path with slashes (Paper 13 "Product / Research").
enum InboxFolderName {
    static func display(_ path: String) -> String {
        path.isEmpty ? InboxCopy.notesRoot : path.split(separator: "/").joined(separator: " / ")
    }

    static func leaf(_ path: String) -> String {
        path.isEmpty ? InboxCopy.notesRoot : String(path.split(separator: "/").last ?? Substring(path))
    }
}
