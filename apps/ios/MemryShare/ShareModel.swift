import Foundation
import ImageIO
import Observation
import UIKit
import UniformTypeIdentifiers

// IB22. What the host app handed over, read once: a web address, plain text,
// or one file (photo, PDF, audio, video). Files are copied, never loaded
// whole, and the preview is a small ImageIO thumbnail, so a large photo stays
// inside the extension's memory limit.

@MainActor
@Observable
final class ShareModel {
    enum Shared: Equatable {
        case link(URL, title: String?)
        case text(String)
        case file(URL, filename: String, mimeType: String, thumbnail: UIImage?)
    }

    enum Phase: Equatable {
        case loading
        case ready(Shared)
        case failed(String)
    }

    /// Desktop's file limit.
    static let maxBytes = 50 * 1024 * 1024

    private(set) var phase: Phase = .loading
    /// The link is already a live capture (Paper 05's notice, here too).
    private(set) var duplicate = false
    var force = false

    private let context: NSExtensionContext?
    private let root: URL?

    init(context: NSExtensionContext?, root: URL? = ShareQueue.groupRoot()) {
        self.context = context
        self.root = root
    }

    var canSave: Bool {
        guard case .ready = phase else { return false }
        return !duplicate || force
    }

    func load() async {
        let items = context?.inputItems.compactMap { $0 as? NSExtensionItem } ?? []
        let providers = items.flatMap { $0.attachments ?? [] }
        let title = items.lazy.compactMap { $0.attributedContentText?.string ?? $0.attributedTitle?.string }.first
        guard let shared = await read(providers, title: title) else {
            // A refusal already said why (too large); otherwise it is a type
            // the inbox does not take.
            if phase == .loading { phase = .failed(ShareCopy.unsupported) }
            return
        }
        if case let .link(url, _) = shared, let root {
            duplicate = ShareQueue.isKnown(url.absoluteString, root: root)
        }
        phase = .ready(shared)
    }

    func save() {
        guard case let .ready(shared) = phase, let root else {
            phase = .failed(ShareCopy.unavailable)
            return
        }
        var drop = ShareDrop(id: UUID().uuidString, kind: .text, force: force, createdAt: Date())
        var payload: URL?
        switch shared {
        case let .link(url, _):
            drop.kind = .link
            drop.text = url.absoluteString
        case let .text(text):
            drop.text = text
        case let .file(url, filename, mime, _):
            drop.kind = .file
            drop.filename = filename
            drop.mimeType = mime
            payload = url
        }
        do {
            try ShareQueue.enqueue(drop, payload: payload, root: root)
            context?.completeRequest(returningItems: nil)
        } catch {
            phase = .failed(ShareCopy.unavailable)
        }
    }

    func cancel() {
        context?.cancelRequest(withError: CocoaError(.userCancelled))
    }

    // MARK: Reading the providers

    /// The first provider that holds something the inbox takes, in the order a
    /// page share offers them: a web address, a file, then text.
    private func read(_ providers: [NSItemProvider], title: String?) async -> Shared? {
        for provider in providers where provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
            if let url = try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL,
               !url.isFileURL, let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" {
                return .link(url, title: title)
            }
        }
        let fileTypes: [UTType] = [.pdf, .image, .movie, .audio]
        for provider in providers {
            guard let type = fileTypes.first(where: { provider.hasItemConformingToTypeIdentifier($0.identifier) }),
                  let exact = provider.registeredContentTypes.first(where: { $0.conforms(to: type) }) else { continue }
            return await copy(provider, type: exact)
        }
        for provider in providers where provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
            guard let text = try? await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String
            else { continue }
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if let url = URL(string: trimmed), !trimmed.contains(where: \.isWhitespace),
               let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https", url.host() != nil {
                return .link(url, title: title)
            }
            if !trimmed.isEmpty { return .text(trimmed) }
        }
        return nil
    }

    /// Copies the file out of the provider's short-lived location.
    private func copy(_ provider: NSItemProvider, type: UTType) async -> Shared? {
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
        guard let (url, name) = copied else { return nil }
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        guard size <= Self.maxBytes else {
            phase = .failed(ShareCopy.tooLarge)
            try? FileManager.default.removeItem(at: url)
            return nil
        }
        let filename = provider.suggestedName.map { name in
            name.contains(".") ? name : "\(name).\(url.pathExtension)"
        } ?? name
        let mime = type.preferredMIMEType ?? "application/octet-stream"
        return .file(url, filename: filename, mimeType: mime, thumbnail: type.conforms(to: .image) ? Self.thumbnail(url) : nil)
    }

    private static func thumbnail(_ url: URL) -> UIImage? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceThumbnailMaxPixelSize: 160,
            kCGImageSourceCreateThumbnailWithTransform: true
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        return UIImage(cgImage: image)
    }
}
