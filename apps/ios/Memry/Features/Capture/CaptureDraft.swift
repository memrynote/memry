import Foundation
import Observation

// #4482. What a capture sheet holds before it is saved. The sheet is only a
// view of it: on iPad a picker closes when the window crosses compact and
// regular width, and a swipe closes it anywhere. The draft lives on with the
// vault's `QuickCapture`, so reopening shows the text again, like desktop's
// capture. Only a save that lands clears it.

@MainActor
@Observable
final class CaptureDraft {
    var text = ""
    /// The chip last picked; `nil` until one is.
    var kind: CaptureKind?
    /// A save is in flight. It outlives the sheet, so a reopened sheet
    /// cannot send the same text twice.
    private(set) var saving = false
    private(set) var failed = false

    var canSave: Bool {
        !saving && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Files the text through `file`. A landed save clears the text unless it
    /// changed while saving; a failed one keeps it and says so.
    func save(
        as kind: CaptureKind,
        through file: (String, CaptureKind) async -> CaptureReceipt?
    ) async -> CaptureReceipt? {
        guard canSave else { return nil }
        saving = true
        failed = false
        let sent = text
        let receipt = await file(sent, kind)
        saving = false
        guard let receipt else {
            failed = true
            return nil
        }
        if text == sent {
            text = ""
            self.kind = nil
        }
        return receipt
    }
}
