import Foundation
import LinkPresentation
import MemryCore
import PDFKit
import UIKit

// IB04 / IB05 / IB06 / IB20-IB22. Capturing: text, links (with the on-device
// preview, D3), files and voice memos. Files are written under
// `attachments/inbox/{id}/` in the vault directory, desktop's layout (§5 F3),
// before the core records the capture.

/// What a capture attempt produced.
enum InboxCaptureResult: Equatable {
    case captured(String)
    /// A live capture already holds this link or text (Paper 05).
    case duplicate(InboxItemRecord)
    case failed
}

extension InboxStore {
    /// The composer's send: a lone web address is a link, anything else text
    /// (desktop `capture-input.tsx`). `force` skips the duplicate check.
    func capture(_ text: String, force: Bool = false, source: String = "inline") async -> InboxCaptureResult {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return .failed }
        let isLink = InboxLinks.isWebAddress(trimmed)
        let outcome: InboxCaptureOutcome? = if isLink {
            await write { try $0.captureLink(url: trimmed, captureSource: source, force: force) }
        } else {
            await write { try $0.captureText(content: trimmed, title: nil, captureSource: source, force: force) }
        }
        guard let outcome else { return .failed }
        if outcome.duplicate { return .duplicate(outcome.item) }
        markFresh(outcome.item.id)
        showToast(InboxCopy.itemCaptured)
        if outcome.item.itemType == "link" { enrich(outcome.item) }
        return .captured(outcome.item.id)
    }

    /// D3: link metadata fetched on this device, the fields desktop's link job
    /// writes (title from `LPMetadataProvider`, description / hero image /
    /// site name / favicon from the page's tags), merged by the core without
    /// overwriting a richer value a peer wrote. A failure stays quiet, as on
    /// desktop.
    func enrich(_ item: InboxItemRecord) {
        guard let link = item.sourceUrl, let url = URL(string: link) else { return }
        let id = item.id
        Task { [weak self] in
            async let page = InboxLinkPage.fetch(url)
            let provider = LPMetadataProvider()
            provider.shouldFetchSubresources = false
            let fetched = try? await provider.startFetchingMetadata(for: url)
            let found = await page
            var patch: [String: Any] = ["url": link, "fetchStatus": fetched == nil && found == nil ? "failed" : "complete"]
            let host = url.host().map { $0.hasPrefix("www.") ? String($0.dropFirst(4)) : $0 }
            patch["siteName"] = found?.siteName ?? host
            patch["description"] = found?.description
            patch["heroImage"] = found?.heroImage
            patch["favicon"] = found?.favicon
            let json = (try? JSONSerialization.data(withJSONObject: patch)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
            let title = fetched?.title ?? found?.title
            let description = found?.description
            await self?.write { try $0.completeLink(id: id, title: title, description: description, metadataJson: json) }
        }
    }

    /// A photo, file, PDF or video: checked against desktop's limits, stored,
    /// then captured. HEIC photos are converted to JPEG first (§6 IB020).
    func captureFile(data: Data, filename: String, mimeType: String, source: String = "inline") async -> InboxCaptureResult {
        var data = data
        var filename = filename
        var mime = mimeType
        if mime == "image/heic" || mime == "image/heif", let jpeg = UIImage(data: data)?.jpegData(compressionQuality: 0.9) {
            data = jpeg
            mime = "image/jpeg"
            filename = ((filename as NSString).deletingPathExtension) + ".jpg"
        }
        let size = UInt64(data.count)
        let checkedMime = mime
        guard await read({ try $0.checkFile(mimeType: checkedMime, size: size) }) != nil else {
            clearFailure()
            fail(size > 50 * 1024 * 1024 ? InboxErrors.tooLarge : InboxErrors.unsupportedType)
            return .failed
        }
        let id = core.newId()
        guard let stored = store(data, id: id, filename: filename, mime: mime) else {
            fail(InboxErrors.unsupportedType)
            return .failed
        }
        var metadata: [String: Any] = ["mimeType": mime]
        var thumbnail: String?
        if mime.hasPrefix("image/"), let image = UIImage(data: data) {
            metadata["width"] = Int(image.size.width * image.scale)
            metadata["height"] = Int(image.size.height * image.scale)
            metadata["format"] = (filename as NSString).pathExtension.lowercased()
            metadata["hasExif"] = false
            thumbnail = storeThumbnail(image, id: id)
        } else if mime == "application/pdf", let document = PDFDocument(data: data) {
            metadata["pageCount"] = document.pageCount
            metadata["hasText"] = !(document.string ?? "").isEmpty
        }
        let json = (try? JSONSerialization.data(withJSONObject: metadata)).flatMap { String(data: $0, encoding: .utf8) }
        let finalMime = mime
        let finalName = filename
        let finalThumbnail = thumbnail
        let item = await write {
            try $0.captureFile(
                id: id, mimeType: finalMime, filename: finalName, size: size, attachmentPath: stored,
                thumbnailPath: finalThumbnail, metadataJson: json, captureSource: source
            )
        }
        guard let item else { return .failed }
        markFresh(item.id)
        showToast(InboxCopy.itemCaptured)
        return .captured(item.id)
    }

    /// Writes `attachments/inbox/{id}/{prefix}-{safe}.{ext}` and returns the
    /// vault-relative path (`storeInboxAttachment`).
    private func store(_ data: Data, id: String, filename: String, mime: String) -> String? {
        guard let vaultDirectory else { return nil }
        let base = (filename as NSString).deletingPathExtension
        let safe = String(base.map { $0.isLetter || $0.isNumber || $0 == "." || $0 == "-" ? $0 : "_" }.prefix(100))
        let ext = (filename as NSString).pathExtension.isEmpty
            ? InboxFileTypes.fileExtension(forMime: mime) : (filename as NSString).pathExtension.lowercased()
        let prefix = String(UUID().uuidString.prefix(8)).lowercased()
        let relative = "attachments/inbox/\(id)/\(prefix)-\(safe.isEmpty ? "file" : safe).\(ext)"
        let url = vaultDirectory.appendingPathComponent(relative)
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            return relative
        } catch {
            Log.core.error("an inbox file could not be stored", .code("inbox.storeFile"))
            return nil
        }
    }

    /// `thumbnail.jpg` beside the image, at most 400 points on its long side.
    private func storeThumbnail(_ image: UIImage, id: String) -> String? {
        guard let vaultDirectory else { return nil }
        let longest = max(image.size.width, image.size.height)
        let scale = min(1, 400 / max(longest, 1))
        let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        let small = UIGraphicsImageRenderer(size: size).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
        guard let data = small.jpegData(compressionQuality: 0.8) else { return nil }
        let relative = "attachments/inbox/\(id)/thumbnail.jpg"
        do {
            try data.write(to: vaultDirectory.appendingPathComponent(relative), options: .atomic)
            return relative
        } catch {
            return nil
        }
    }

    /// A finished recording: moved under the capture's folder, captured, then
    /// transcribed on this device (D4) when `transcribe` is on.
    func captureVoice(file: URL, duration: TimeInterval, waveform: [Double], transcribe: Bool) async -> InboxCaptureResult {
        guard let vaultDirectory else { return .failed }
        let id = core.newId()
        let relative = "attachments/inbox/\(id)/voice-memo.m4a"
        let target = vaultDirectory.appendingPathComponent(relative)
        do {
            try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
            try FileManager.default.moveItem(at: file, to: target)
        } catch {
            fail(InboxErrors.recordingFailed)
            return .failed
        }
        let size = UInt64((try? FileManager.default.attributesOfItem(atPath: target.path)[.size] as? NSNumber)??.uint64Value ?? 0)
        let available = transcribe && InboxTranscriber.isAvailable
        let status: String? = transcribe ? (available ? "pending" : "failed") : nil
        let item = await write {
            try $0.captureVoice(
                id: id, durationSeconds: duration, format: "m4a", size: size, attachmentPath: relative,
                waveform: waveform, transcriptionStatus: status, captureSource: "inline"
            )
        }
        guard let item else { return .failed }
        markFresh(item.id)
        showToast(InboxCopy.itemCaptured)
        if available { await transcribeVoice(item.id, file: target) }
        return .captured(item.id)
    }

    /// Runs (or retries) on-device transcription for a voice memo.
    func transcribeVoice(_ id: String, file: URL? = nil) async {
        guard !transcribing.contains(id) else { return }
        transcribing.insert(id)
        defer { transcribing.remove(id) }
        var path = items.first { $0.id == id }?.attachmentPath
        if path == nil { path = await fetch(id)?.attachmentPath }
        let url = file ?? localFile(path)
        guard let url, InboxTranscriber.isAvailable else {
            await write { try $0.setTranscription(id: id, transcription: nil, status: "failed") }
            return
        }
        await write { try $0.setTranscription(id: id, transcription: nil, status: "pending") }
        let text = await InboxTranscriber.transcribe(url)
        await write { try $0.setTranscription(id: id, transcription: text, status: text == nil ? "failed" : "complete") }
    }
}

extension InboxFileTypes {
    static func fileExtension(forMime mime: String) -> String {
        switch mime {
        case "image/jpeg": "jpg"
        case "image/png": "png"
        case "image/gif": "gif"
        case "image/webp": "webp"
        case "application/pdf": "pdf"
        case "video/mp4": "mp4"
        case "video/quicktime": "mov"
        case "audio/mp4", "audio/x-m4a": "m4a"
        case "audio/mpeg": "mp3"
        case "audio/wav": "wav"
        default: "bin"
        }
    }
}

extension InboxLinks {
    /// A single absolute http(s) address (desktop `isUrl` for the capture bar).
    nonisolated static func isWebAddress(_ text: String) -> Bool {
        guard !text.contains(where: \.isWhitespace),
              let url = URL(string: text), let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https", url.host() != nil
        else { return false }
        return true
    }
}
