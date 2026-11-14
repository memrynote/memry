import Foundation
import MemryCore
import SwiftUI
import UniformTypeIdentifiers

// #4357. Text, links, images and files dropped on the Inbox, from another app
// in Split View or Slide Over or from inside this one. Each dropped item is a
// capture through the composer's own path (`InboxStore.capture` and
// `captureFile`), so a drop meets the same type and size limits as a picked
// file, and a refusal shows the same failure row.

@MainActor
enum InboxDrop {
    /// What one dropped item holds.
    enum Item: Equatable, Sendable {
        case link(String)
        case text(String)
        /// A copy in this app's temporary folder, removed once captured.
        case file(URL, filename: String, mimeType: String)
        /// A file refused or lost before it reached the capture.
        case failed(UserFacingError)
    }

    /// `checkFile`'s refusal for a file of a MIME type and a size, or `nil`.
    typealias FileCheck = @Sendable (_ mimeType: String, _ size: UInt64) -> UserFacingError?

    /// The composer's "Choose File" types.
    static let fileTypes: [UTType] = [.image, .audio, .movie, .pdf]
    /// What the Inbox takes: those files, a link, or text.
    static let types: [UTType] = fileTypes + [.url, .plainText]

    /// Whether the Inbox takes a hovering drag, given what its items conform
    /// to. A task drag also carries text, and is not something to capture.
    static func takes(_ hasItems: ([UTType]) -> Bool) -> Bool {
        hasItems(types) && !hasItems([.memryTasks])
    }

    /// Each provider's item, in drop order. A file first (an image dragged
    /// from Safari also carries its address), then a web address, then text.
    static func read(_ providers: [NSItemProvider], check: @escaping FileCheck) async -> [Item] {
        var items: [Item] = []
        for provider in providers {
            if let item = await read(provider, check: check) { items.append(item) }
        }
        return items
    }

    private static func read(_ provider: NSItemProvider, check: @escaping FileCheck) async -> Item? {
        if let type = provider.registeredContentTypes.first(where: { type in fileTypes.contains { type.conforms(to: $0) } }) {
            return await copy(provider, type: type, check: check)
        }
        if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
           let url = await link(provider),
           !url.isFileURL, let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" {
            return .link(url.absoluteString)
        }
        if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
           let text = await text(provider) {
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            // A dragged task row's ids are not text to keep.
            if !trimmed.isEmpty, TaskDragPayload.decode(trimmed).isEmpty { return .text(trimmed) }
        }
        return nil
    }

    private static func link(_ provider: NSItemProvider) async -> URL? {
        await withCheckedContinuation { continuation in
            _ = provider.loadObject(ofClass: NSURL.self) { object, _ in
                continuation.resume(returning: (object as? NSURL) as URL?)
            }
        }
    }

    private static func text(_ provider: NSItemProvider) async -> String? {
        await withCheckedContinuation { continuation in
            _ = provider.loadObject(ofClass: NSString.self) { object, _ in
                continuation.resume(returning: (object as? NSString) as String?)
            }
        }
    }

    /// Copies the file out of the provider's short-lived location, once
    /// `check` takes its size: a file over the limit is never copied.
    private static func copy(_ provider: NSItemProvider, type: UTType, check: @escaping FileCheck) async -> Item {
        let mimeType = type.preferredMIMEType ?? "application/octet-stream"
        let suggested = provider.suggestedName
        let item: Item = await withCheckedContinuation { continuation in
            _ = provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, _ in
                guard let url else {
                    continuation.resume(returning: .failed(InboxErrors.dropUnreadable))
                    return
                }
                if let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize,
                   let refusal = check(mimeType, UInt64(size)) {
                    continuation.resume(returning: .failed(refusal))
                    return
                }
                let target = FileManager.default.temporaryDirectory
                    .appendingPathComponent(UUID().uuidString)
                    .appendingPathExtension(url.pathExtension)
                do {
                    try FileManager.default.copyItem(at: url, to: target)
                } catch {
                    continuation.resume(returning: .failed(InboxErrors.dropUnreadable))
                    return
                }
                let named = suggested.map { $0.contains(".") ? $0 : "\($0).\(url.pathExtension)" }
                let filename = named ?? url.lastPathComponent
                continuation.resume(returning: .file(target, filename: filename, mimeType: mimeType))
            }
        }
        if case let .failed(error) = item {
            Log.core.error("a dropped file was not copied", .code(error.code))
        }
        return item
    }
}

extension InboxStore {
    /// Captures every dropped item, then shows the drop's failures once: one
    /// by its own row, several by their count. A capture's write clears the
    /// failure row, so a failure shown mid-loop would vanish behind a later
    /// success. Answers how many were captured.
    @discardableResult
    func captureDropped(_ providers: [NSItemProvider]) async -> Int {
        let core = core
        // The core serialises its own state, so the provider's thread may ask
        // it; `captureFile` checks a HEIC photo as the JPEG it turns it into.
        let items = await InboxDrop.read(providers) { mimeType, size in
            let checked = mimeType == "image/heic" || mimeType == "image/heif" ? "image/jpeg" : mimeType
            let allowed = (try? core.checkFile(mimeType: checked, size: size)) != nil
            return allowed ? nil : InboxErrors.fileRefusal(size: size)
        }
        return await capture(dropped: items)
    }

    @discardableResult
    func capture(dropped items: [InboxDrop.Item]) async -> Int {
        var captured = 0
        var failed = 0
        /// The first failure that has a row; a capture's own path sets it.
        var first: UserFacingError?
        clearFailure()
        for item in items {
            let result: InboxCaptureResult
            switch item {
            case let .link(text), let .text(text):
                result = await capture(text)
            case let .file(url, filename, mimeType):
                defer { try? FileManager.default.removeItem(at: url) }
                // Mapped, not read: the file is not loaded into memory whole.
                guard let data = try? Data(contentsOf: url, options: .mappedIfSafe) else {
                    Log.core.error("a dropped file could not be opened", .code(InboxErrors.dropUnopenable.code))
                    first = first ?? InboxErrors.dropUnopenable
                    failed += 1
                    continue
                }
                result = await captureFile(data: data, filename: filename, mimeType: mimeType)
            case let .failed(error):
                first = first ?? error
                failed += 1
                continue
            }
            switch result {
            case .captured: captured += 1
            case .duplicate: showToast(InboxCopy.sharedAlreadyCaptured)
            case .failed:
                first = first ?? failure
                failed += 1
            }
        }
        if failed > 1 {
            fail(InboxErrors.dropFailed(failed, first: first))
        } else if let first {
            fail(first)
        }
        return captured
    }
}

/// The Inbox screen as a drop target: the tint outlines it while something it
/// takes hovers.
struct InboxDropTarget: ViewModifier {
    let store: InboxStore
    /// The Inbox view, outside select mode: where a capture shows up.
    let isEnabled: Bool

    @State private var isTargeted = false

    func body(content: Content) -> some View {
        // No types rather than no modifier: swapping the view would rebuild
        // the list under it, and lose its scroll, on entering select mode.
        content
            .overlay {
                if isTargeted {
                    RoundedRectangle(cornerRadius: Tokens.Radius.container)
                        .strokeBorder(Tokens.Tint.base.color, lineWidth: 2)
                        .padding(Tokens.Space.tight)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
            }
            .onDrop(of: isEnabled ? InboxDrop.types : [], delegate: Delegate(store: store, isTargeted: $isTargeted))
    }

    private struct Delegate: DropDelegate {
        let store: InboxStore
        @Binding var isTargeted: Bool

        func validateDrop(info: DropInfo) -> Bool { InboxDrop.takes(info.hasItemsConforming(to:)) }

        func dropEntered(info: DropInfo) { isTargeted = validateDrop(info: info) }

        func dropExited(info: DropInfo) { isTargeted = false }

        func performDrop(info: DropInfo) -> Bool {
            isTargeted = false
            guard validateDrop(info: info) else { return false }
            let providers = info.itemProviders(for: InboxDrop.types)
            Task { await store.captureDropped(providers) }
            return true
        }
    }
}
