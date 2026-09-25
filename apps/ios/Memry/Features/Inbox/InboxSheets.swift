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

struct InboxSheets: Equatable {
    var file: InboxFileRequest?
    var convert: InboxItemRecord?
    var snoozeIds: [String]?
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
            .sheet(item: $sheets.convert) { item in
                InboxConvertSheet(store: store, item: item, done: afterExit)
            }
            .sheet(item: Binding(
                get: { sheets.snoozeIds.map { InboxIdList(ids: $0) } },
                set: { sheets.snoozeIds = $0?.ids }
            )) { list in
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
            .confirmationDialog(
                InboxCopy.archiveDialogTitle(sheets.archiveAll?.count ?? 0),
                isPresented: Binding(get: { sheets.archiveAll != nil }, set: { if !$0 { sheets.archiveAll = nil } }),
                titleVisibility: .visible
            ) {
                Button(InboxCopy.archiveDialogConfirm(sheets.archiveAll?.count ?? 0), role: .destructive) {
                    if let ids = sheets.archiveAll {
                        Task {
                            await store.archive(ids)
                            afterExit()
                        }
                    }
                    sheets.archiveAll = nil
                }
            } message: {
                Text(InboxCopy.archiveDialogBody)
            }
    }
}

extension View {
    func inboxSheets(_ sheets: Binding<InboxSheets>, store: InboxStore, afterExit: @escaping () -> Void = {}) -> some View {
        modifier(InboxSheetsModifier(sheets: sheets, store: store, afterExit: afterExit))
    }
}
