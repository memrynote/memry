import CryptoKit
import Foundation

// IB22 / D7. The hand-off between the Share extension and the app, through
// the app group. Compiled into both targets.
//
// The extension cannot open the vault (its database lives in the app's own
// container and needs the keychain), so it only leaves a drop here; the app
// captures it on its next load with an unlocked vault, through the same path
// the composer uses (`captureSource: "quick-capture"`, duplicate check
// included). A drop made while the vault is locked simply waits.
//
// Every file here carries the vault's protection class
// (`completeUntilFirstUserAuthentication`), and the duplicate notice reads
// SHA-256 digests of the inbox's link addresses, never the addresses.

/// One shared thing waiting to be captured.
struct ShareDrop: Codable, Equatable, Sendable {
    enum Kind: String, Codable, Sendable {
        /// A web address (`text` holds it).
        case link
        /// Plain text (`text` holds it).
        case text
        /// A photo, PDF, audio or video file (`payload` holds its bytes).
        case file
    }

    var id: String
    var kind: Kind
    var text: String?
    var filename: String?
    var mimeType: String?
    /// "Capture anyway" was chosen on the duplicate notice.
    var force: Bool
    var createdAt: Date
}

enum ShareQueue {
    static let appGroup = "group.com.memry.app"
    static let payloadName = "payload"

    /// The app group container, or nil where the entitlement is missing.
    static func groupRoot() -> URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
    }

    static func queueDirectory(root: URL) -> URL {
        root.appendingPathComponent("inbox-share", isDirectory: true)
    }

    // MARK: Writing (extension)

    /// Leaves a drop. The payload is moved in first and the manifest written
    /// last, so the app never reads a drop whose file is still arriving.
    static func enqueue(_ drop: ShareDrop, payload: URL?, root: URL) throws {
        let folder = queueDirectory(root: root).appendingPathComponent(drop.id, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: protection)
        if let payload {
            let target = folder.appendingPathComponent(payloadName)
            try FileManager.default.moveItem(at: payload, to: target)
            try FileManager.default.setAttributes(protection, ofItemAtPath: target.path)
        }
        let data = try JSONEncoder().encode(drop)
        try data.write(to: folder.appendingPathComponent("drop.json"), options: [.atomic, protectionOption])
    }

    // MARK: Reading (app)

    /// Complete drops, oldest first.
    static func pending(root: URL) -> [(drop: ShareDrop, payload: URL?)] {
        let base = queueDirectory(root: root)
        let folders = (try? FileManager.default.contentsOfDirectory(at: base, includingPropertiesForKeys: nil)) ?? []
        let drops: [(drop: ShareDrop, payload: URL?)] = folders.compactMap { folder in
            guard let data = try? Data(contentsOf: folder.appendingPathComponent("drop.json")),
                  let drop = try? JSONDecoder().decode(ShareDrop.self, from: data) else { return nil }
            let payload = folder.appendingPathComponent(payloadName)
            return (drop, FileManager.default.fileExists(atPath: payload.path) ? payload : nil)
        }
        return drops.sorted { $0.drop.createdAt < $1.drop.createdAt }
    }

    static func remove(_ id: String, root: URL) {
        try? FileManager.default.removeItem(at: queueDirectory(root: root).appendingPathComponent(id, isDirectory: true))
    }

    // MARK: Duplicate notice

    static func knownLinksFile(root: URL) -> URL {
        root.appendingPathComponent("inbox-known-links.json")
    }

    /// The app's live link captures, as digests (their `sourceUrl`s).
    static func publishKnownLinks(_ addresses: [String], root: URL) {
        let digests = Array(Set(addresses.map(digest))).sorted()
        guard let data = try? JSONEncoder().encode(digests) else { return }
        try? data.write(to: knownLinksFile(root: root), options: [.atomic, protectionOption])
    }

    /// Whether the inbox already holds this exact address (the core's own
    /// duplicate rule is an exact `sourceUrl` match).
    static func isKnown(_ address: String, root: URL) -> Bool {
        guard let data = try? Data(contentsOf: knownLinksFile(root: root)),
              let digests = try? JSONDecoder().decode([String].self, from: data) else { return false }
        return digests.contains(digest(address))
    }

    static func digest(_ text: String) -> String {
        SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private static var protection: [FileAttributeKey: Any] {
        [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
    }
    private static let protectionOption = Data.WritingOptions.completeFileProtectionUntilFirstUserAuthentication
}
