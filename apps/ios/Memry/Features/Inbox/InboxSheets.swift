import MemryCore
import SwiftUI

// The sheets and prompts the list, the detail and select mode share: File
// (13), Convert (14, 15), Pick date & time (09), Rename (08), Tag all and
// Archive all (16).

/// Which captures the File sheet files (one from a row or the detail, many
/// from select mode; bulk filing links no notes, desktop's rule).
struct InboxFileRequest: Identifiable, Equatable {
    let id = UUID()
    let ids: [String]
}

struct InboxIdList: Identifiable, Equatable {
    let id = UUID()
    let ids: [String]
}

/// Convert opened on one segment: the row menu's "Convert to ›" names the
/// target, the detail bar's Convert opens on Task.
struct InboxConvertRequest: Identifiable, Equatable {
    let item: InboxItemRecord
    var target: InboxConvertSheet.Target = .task
    var id: String { item.id }
}

struct InboxSheets: Equatable {
    var file: InboxFileRequest?
    var convert: InboxConvertRequest?
    /// Held as an identified list: a binding that wrapped bare ids made a
    /// new identity on every read, and the sheet re-presented itself.
    var snooze: InboxIdList?
    var rename: InboxItemRecord?
    var tag: InboxIdList?
    var archiveAll: [String]?
}

struct InboxSheetsModifier: ViewModifier {
    @Binding var sheets: InboxSheets
    let store: InboxStore
    var afterExit: () -> Void = {}
    @State private var renameText = ""

    func body(content: Content) -> some View {
        content
            .sheet(item: $sheets.file) { request in
                InboxFileSheet(store: store, ids: request.ids, done: afterExit)
            }
            .sheet(item: $sheets.convert) { request in
                InboxConvertSheet(store: store, item: request.item, start: request.target, done: afterExit)
            }
            .sheet(item: $sheets.snooze) { list in
                InboxSnoozeDateSheet(now: store.clock()) { date in
                    Task {
                        await store.snooze(list.ids, until: date)
                        afterExit()
                    }
                }
            }
            .sheet(item: $sheets.tag) { list in
                InboxTagSheet(store: store, ids: list.ids)
            }
            .alert(InboxCopy.renameLabel, isPresented: Binding(
                get: { sheets.rename != nil },
                set: { if !$0 { sheets.rename = nil } }
            )) {
                TextField(InboxCopy.rename, text: $renameText)
                    .accessibilityIdentifier("inbox.rename.field")
                Button(InboxCopy.cancel, role: .cancel) { sheets.rename = nil }
                Button(InboxCopy.rename) {
                    if let item = sheets.rename { Task { await store.rename(item.id, to: renameText) } }
                    sheets.rename = nil
                }
            }
            .onChange(of: sheets.rename) { _, item in renameText = item?.title ?? "" }
    }
}

extension View {
    func inboxSheets(_ sheets: Binding<InboxSheets>, store: InboxStore, afterExit: @escaping () -> Void = {}) -> some View {
        modifier(InboxSheetsModifier(sheets: sheets, store: store, afterExit: afterExit))
    }
}
