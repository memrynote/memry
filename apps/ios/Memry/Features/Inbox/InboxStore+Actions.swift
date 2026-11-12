import Foundation
import MemryCore

// IB07, IB09, IB17, IB19, IB24. The one-capture exits and their toasts:
// archive (with Undo), snooze, restore, delete, rename, mark viewed.

extension InboxStore {
    /// Archive with the row leaving at once and an Undo toast (desktop's
    /// `archiveWithAnimation` + undo toast, Paper 17).
    func archive(_ item: InboxItemRecord) async {
        let id = item.id
        let title = InboxMeta.displayTitle(item)
        let archived = await writeRemoving([id], { try $0.archive(id: id) }) != nil
        trackArchived(ok: archived)
        guard archived else { return }
        showToast(InboxCopy.archived(title)) { [weak self] in
            await self?.write { try $0.unarchive(id: id) }
            self?.showToast(InboxCopy.changesUndone)
        }
    }

    func archive(_ ids: [String]) async {
        let result = await writeRemoving(ids, { try $0.bulkArchive(ids: ids) })
        trackBulk(.inboxArchived, "archived", processed: result.map { Int($0.processed) })
        guard let result else { return }
        let archived = ids.filter { !result.failedIds.contains($0) }
        showToast(InboxCopy.archivedItems(Int(result.processed))) { [weak self] in
            for id in archived { await self?.write { try $0.unarchive(id: id) } }
            self?.showToast(InboxCopy.changesUndone)
        }
    }

    /// Snoozes captures until `date`; the toast names the time (`toast.snoozed*`).
    func snooze(_ ids: [String], until date: Date) async {
        let until = Int64(date.timeIntervalSince1970 * 1000)
        let label = InboxSnoozeFormat.until(date, now: clock())
        if ids.count == 1, let id = ids.first {
            let snoozed = await writeRemoving(ids, { try $0.snooze(id: id, untilMs: until, reason: nil) }) != nil
            trackSnoozed("snoozed", ok: snoozed)
            guard snoozed else { return }
            showToast(InboxCopy.snoozedUntil(label)) { [weak self] in
                await self?.write { try $0.unsnooze(id: id) }
                self?.showToast(InboxCopy.changesUndone)
            }
        } else {
            let result = await writeRemoving(ids, { try $0.bulkSnooze(ids: ids, untilMs: until, reason: nil) })
            trackBulk(.inboxSnoozed, "snoozed", processed: result.map { Int($0.processed) })
            guard let result else { return }
            showToast(InboxCopy.snoozedItemsUntil(Int(result.processed), label))
        }
    }

    func unsnooze(_ id: String) async {
        let unsnoozed = await write { try $0.unsnooze(id: id) } != nil
        trackSnoozed("unsnoozed", ok: unsnoozed)
    }

    /// Archived → back in the inbox (`toast.restored`).
    func restore(_ item: InboxItemRecord) async {
        let id = item.id
        guard await writeRemoving([id], { try $0.unarchive(id: id) }) != nil else { return }
        showToast(InboxCopy.restored(InboxMeta.displayTitle(item)))
    }

    /// Delete permanently: the tombstone, then this device's files.
    func deletePermanently(_ item: InboxItemRecord) async {
        let id = item.id
        guard await writeRemoving([id], { try $0.deletePermanently(id: id) }) != nil else { return }
        if let directory = vaultDirectory?.appendingPathComponent("attachments/inbox/\(id)", isDirectory: true) {
            try? FileManager.default.removeItem(at: directory)
        }
    }

    func rename(_ id: String, to title: String) async {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        await write { try $0.rename(id: id, title: trimmed) }
    }

    /// A note capture's body, saved as the user types (debounced by the view).
    func setContent(_ id: String, _ content: String) async {
        await write { try $0.setContent(id: id, content: content.isEmpty ? nil : content) }
    }

    func markViewed(_ id: String) async {
        await write { try $0.markViewed(id: id) }
    }

    /// Tags on a selection (`handleBulkTag`, device-local).
    func tag(_ ids: [String], tags: [String]) async {
        guard !tags.isEmpty, let result = await write({ try $0.bulkTag(ids: ids, tags: tags) }) else { return }
        showToast(InboxCopy.appliedTags(tags.count, items: Int(result.processed)))
    }
}
