//
//  AttachmentBlock.swift
//  The block an uploaded attachment becomes in the body, in desktop's shape.
//
//  Desktop references: `use-editor-file-upload.ts` and
//  `attachment-picker-dialog.tsx` (`buildInsertedAttachmentBlock`) for the
//  props, `vault/attachments.ts` `getFileType` for image-or-file, and
//  `resolve-note-relative-url.ts` for the url: a mobile-written block names
//  its file root-relative as `attachments/<noteId>/<filename>`, which desktop
//  resolves directly and the core binds by basename (`resolve_for_block`).
//

import Foundation
import UIKit
import UniformTypeIdentifiers

/// Where an attachment's bytes come from: the paperclip menu and the
/// catalog's media rows.
enum EditorAttachmentSource: Equatable, Sendable {
    case photos
    case videos
    case camera
    case files
    case audio
    case scan
}

struct AttachmentBlock: Equatable {
    /// `image` or `file`.
    let kind: String
    /// Written with `SetProp` after the insert, in this order.
    let props: [Prop]

    struct Prop: Equatable {
        let name: String
        let value: String
    }

    /// Desktop's `ALLOWED_IMAGE_EXTENSIONS`: what it draws as an image block.
    static let imageExtensions: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "svg"]
    /// `DEFAULT_IMAGE_PREVIEW_WIDTH` (`packages/editor-schema/src/blocks/image-width.ts`).
    static let defaultPreviewWidth = 600

    static func isImage(filename: String) -> Bool {
        imageExtensions.contains((filename as NSString).pathExtension.lowercased())
    }

    /// `attachments/<noteId>/<filename>`, the filename percent-encoded as a
    /// path segment (desktop and the core both decode it).
    static func url(noteId: String, filename: String) -> String {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/?#")
        let encoded = filename.addingPercentEncoding(withAllowedCharacters: allowed) ?? filename
        return "attachments/\(noteId)/\(encoded)"
    }

    /// `audio` or `video` for a block that plays in place: BlockNote's own
    /// audio and video blocks, and a file block of an `audio/*` or `video/*`
    /// type, which is what desktop writes for both (`file-block.tsx`).
    static func media(kind: String, mimeType: String?) -> String? {
        if kind == "audio" || kind == "video" { return kind }
        guard kind == "file", let mimeType else { return nil }
        return ["audio", "video"].first { mimeType.hasPrefix("\($0)/") }
    }

    /// An image block `{url, caption, previewWidth}` for a picture desktop
    /// can draw, otherwise a file block `{url, name, size, mimeType}`.
    static func make(noteId: String, filename: String, mimeType: String, size: Int) -> AttachmentBlock {
        let url = url(noteId: noteId, filename: filename)
        if isImage(filename: filename) {
            return AttachmentBlock(kind: "image", props: [
                Prop(name: "url", value: url),
                Prop(name: "caption", value: filename),
                Prop(name: "previewWidth", value: String(defaultPreviewWidth)),
            ])
        }
        return AttachmentBlock(kind: "file", props: [
            Prop(name: "url", value: url),
            Prop(name: "name", value: filename),
            Prop(name: "size", value: String(size)),
            Prop(name: "mimeType", value: mimeType),
        ])
    }
}

/// Bytes ready to upload, named and typed.
struct AttachmentPayload: Equatable {
    let filename: String
    let mimeType: String
    let bytes: Data

    /// A video from the photo library, named as a capture is. It becomes a
    /// file block, which desktop plays in place for a `video/*` type.
    static func video(_ bytes: Data, type: UTType?, at date: Date = .now) -> AttachmentPayload {
        AttachmentPayload(
            filename: NoteAttachmentComposer.capturedName("video", at: date, extension: type?.preferredFilenameExtension ?? "mov"),
            mimeType: type?.preferredMIMEType ?? "video/quicktime",
            bytes: bytes
        )
    }

    /// A picture desktop cannot draw as an image block (HEIC from the photo
    /// library, most of all) is re-encoded as JPEG, so it arrives as a picture
    /// rather than a file card. Anything that does not decode is left as is.
    static func picture(_ bytes: Data, type: UTType?, at date: Date = .now) -> AttachmentPayload {
        let ext = type?.preferredFilenameExtension?.lowercased() ?? "jpg"
        if AttachmentBlock.imageExtensions.contains(ext) {
            return AttachmentPayload(
                filename: NoteAttachmentComposer.capturedName(at: date, extension: ext),
                mimeType: type?.preferredMIMEType ?? "image/jpeg",
                bytes: bytes
            )
        }
        if let jpeg = UIImage(data: bytes)?.jpegData(compressionQuality: 0.9) {
            return AttachmentPayload(
                filename: NoteAttachmentComposer.capturedName(at: date, extension: "jpg"),
                mimeType: "image/jpeg",
                bytes: jpeg
            )
        }
        return AttachmentPayload(
            filename: NoteAttachmentComposer.capturedName(at: date, extension: ext),
            mimeType: type?.preferredMIMEType ?? "application/octet-stream",
            bytes: bytes
        )
    }

    /// Scanned pages as one PDF, one page per scan at the scan's own size.
    static func scan(_ pages: [UIImage], at date: Date = .now) -> AttachmentPayload? {
        guard let first = pages.first else { return nil }
        let renderer = UIGraphicsPDFRenderer(bounds: CGRect(origin: .zero, size: first.size))
        let data = renderer.pdfData { context in
            for page in pages {
                context.beginPage(withBounds: CGRect(origin: .zero, size: page.size), pageInfo: [:])
                page.draw(in: CGRect(origin: .zero, size: page.size))
            }
        }
        let name = NoteAttachmentComposer.capturedName("scan", at: date, extension: "pdf")
        return AttachmentPayload(filename: name, mimeType: "application/pdf", bytes: data)
    }
}
