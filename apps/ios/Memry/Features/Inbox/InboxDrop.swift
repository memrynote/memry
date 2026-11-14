import Foundation
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
    }

    /// The composer's "Choose File" types.
    static let fileTypes: [UTType] = [.image, .audio, .movie, .pdf]
    /// What the Inbox takes: those files, a link, or text.
    static let types: [UTType] = fileTypes + [.url, .plainText]

    /// Each provider's item, in drop order. A file first (an image dragged
    /// from Safari also carries its address), then a web address, then text.
    static func read(_ providers: [NSItemProvider]) async -> [Item] {
        var items: [Item] = []
        for provider in providers {
            if let item = await read(provider) { items.append(item) }
        }
        return items
    }

    private static func read(_ provider: NSItemProvider) async -> Item? {
        if let type = provider.registeredContentTypes.first(where: { type in fileTypes.contains { type.conforms(to: $0) } }),
           let file = await copy(provider, type: type) {
            return file
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

    /// Copies the file out of the provider's short-lived location.
    private static func copy(_ provider: NSItemProvider, type: UTType) async -> Item? {
        let copied: (URL, String)? = await withCheckedContinuation { continuation in
            _ = provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, _ in
                guard let url else {
                    continuation.resume(returning: nil)
                    return
                }
                let target = FileManager.default.temporaryDirectory
                    .appendingPathComponent(UUID().uuidString)
                    .appendingPathExtension(url.pathExtension)
                let moved = (try? FileManager.default.copyItem(at: url, to: target)) != nil
                continuation.resume(returning: moved ? (target, url.lastPathComponent) : nil)
            }
        }
        guard let (url, name) = copied else {
            Log.core.error("a dropped file could not be read", .code("inbox.drop"))
            return nil
        }
        let filename = provider.suggestedName.map { $0.contains(".") ? $0 : "\($0).\(url.pathExtension)" } ?? name
        return .file(url, filename: filename, mimeType: type.preferredMIMEType ?? "application/octet-stream")
    }
}

extension InboxStore {
    /// Captures every dropped item. Answers how many were captured.
    @discardableResult
    func captureDropped(_ providers: [NSItemProvider]) async -> Int {
        var captured = 0
        for item in await InboxDrop.read(providers) {
            let result: InboxCaptureResult
            switch item {
            case let .link(text), let .text(text):
                result = await capture(text)
            case let .file(url, filename, mimeType):
                defer { try? FileManager.default.removeItem(at: url) }
                // Mapped, not read: a file over the limit is refused by its
                // size without being loaded into memory.
                guard let data = try? Data(contentsOf: url, options: .mappedIfSafe) else {
                    fail(InboxErrors.unsupportedType)
                    continue
                }
                result = await captureFile(data: data, filename: filename, mimeType: mimeType)
            }
            switch result {
            case .captured: captured += 1
            case .duplicate: showToast(InboxCopy.sharedAlreadyCaptured)
            case .failed: break
            }
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
            .onDrop(of: isEnabled ? InboxDrop.types : [], isTargeted: $isTargeted) { providers in
                Task { await store.captureDropped(providers) }
                return true
            }
    }
}
