//
//  NoteCoverBandTests.swift
//  N703, held to desktop's `packages/shared/src/cover-image.ts`.
//

import Foundation
import Testing
import UIKit

@testable import Memry

struct NoteCoverBandTests {
    // MARK: reading `coverJson`

    @Test func readsDesktopsCoverShape() {
        let cover = NoteCoverValue.of(
            #"{"ref":"../attachments/n1/harbour.jpg","focus":42,"credit":"Ana","creditUrl":"https://unsplash.com/photos/x"}"#
        )
        #expect(cover?.kind == .image("../attachments/n1/harbour.jpg"))
        #expect(cover?.focus == 42)
        #expect(cover?.credit == "Ana")
        #expect(cover?.creditUrl == URL(string: "https://unsplash.com/photos/x"))
    }

    @Test func aWashRefReadsAsItsWash() {
        let cover = NoteCoverValue.of(#"{"ref":"wash:plum"}"#)
        #expect(cover?.kind == .wash(.plum))
        #expect(cover?.focus == NoteCoverValue.defaultFocus)
    }

    /// Desktop's value gate: `cover: Hardback` is a book's binding, not a
    /// picture, and an unknown wash is not a wash.
    @Test func proseAndUnknownWashesAreNotCovers() {
        #expect(NoteCoverValue.of(#"{"ref":"Hardback"}"#) == nil)
        #expect(NoteCoverValue.of(#"{"ref":"wash:teal"}"#) == nil)
        #expect(NoteCoverValue.of(#"{"ref":""}"#) == nil)
        #expect(NoteCoverValue.of(nil) == nil)
        #expect(NoteCoverValue.of("not json") == nil)
    }

    @Test func imageRefsFollowDesktopsExtensionList() {
        #expect(NoteCoverValue.kind(of: "a/b/Photo.JPG?x=1") == .image("a/b/Photo.JPG?x=1"))
        #expect(NoteCoverValue.kind(of: "https://example.com/page") == .image("https://example.com/page"))
        #expect(NoteCoverValue.kind(of: "attachments/n1/x.heic") == nil)
    }

    /// An older iOS build's `coverImage` held any attached picture, HEIC
    /// included; the core marks it `legacy`, and it still shows.
    @Test func aLegacyCoverImageRefIsNotHeldToTheExtensionList() {
        let cover = NoteCoverValue.of(#"{"ref":"attachments/n1/IMG_0001.heic","focus":25,"legacy":true}"#)
        #expect(cover?.kind == .image("attachments/n1/IMG_0001.heic"))
        #expect(cover?.focus == 25)
        #expect(NoteCoverValue.of(#"{"ref":"memry://cover/1","legacy":true}"#)?.kind == .image("memry://cover/1"))
        #expect(NoteCoverValue.of(#"{"ref":"","legacy":true}"#) == nil)
        #expect(NoteCoverValue.of(#"{"ref":"attachments/n1/IMG_0001.heic"}"#) == nil)
    }

    /// A credit without its link is not shown, as desktop shows neither.
    @Test func aCreditNeedsItsLink() {
        let cover = NoteCoverValue.of(#"{"ref":"wash:sage","credit":"Ana","creditUrl":"not a link"}"#)
        #expect(cover?.credit == nil)
        #expect(cover?.creditUrl == nil)
    }

    @Test func focusClampsAndRoundsLikeDesktop() {
        #expect(NoteCoverValue.clampFocus(-3) == 0)
        #expect(NoteCoverValue.clampFocus(140) == 100)
        #expect(NoteCoverValue.clampFocus(41.6) == 42)
        #expect(NoteCoverValue.clampFocus(.nan) == 50)
    }

    // MARK: washes

    /// The same table in the same order, so a seed picks the same wash on
    /// every device.
    @Test func washesMatchDesktopsTable() {
        #expect(NoteCoverWash.allCases.map(\.rawValue) == [
            "sage", "sand", "lilac", "clay", "ash", "fog",
            "wheat", "moss", "slate", "bark", "mist", "plum",
        ])
        #expect(NoteCoverWash.sage.stops.from == 0xDF_E7_E3)
        #expect(NoteCoverWash.plum.stops.to == 0x84_76_9A)
    }

    /// Hand-computed with desktop's `coverWashForSeed`:
    /// `hash = (hash * 31 + charCode) >>> 0`, index `hash % 12`.
    @Test func seedWashMatchesDesktopsHash() {
        #expect(NoteCoverWash.forSeed("") == .sage)
        // "a" = 97 -> 97 % 12 = 1
        #expect(NoteCoverWash.forSeed("a") == .sand)
        // "ab" = 97 * 31 + 98 = 3105 -> 3105 % 12 = 9
        #expect(NoteCoverWash.forSeed("ab") == .bark)
    }

    @Test func seedWashWrapsLikeAnUnsigned32BitInteger() {
        // Long enough to overflow; must not trap and must be stable.
        let seed = String(repeating: "f3a9c0", count: 20)
        #expect(NoteCoverWash.forSeed(seed) == NoteCoverWash.forSeed(seed))
    }

    // MARK: where the picture lives

    @Test func anAttachmentPathNamesItsOwningNote() {
        #expect(
            NoteCoverSource.of("attachments/n1/cover.jpg", noteId: "n1")
                == .attachment(ownerNoteId: "n1", url: "cover.jpg")
        )
        // Desktop's "From note" tab references another note's file.
        #expect(
            NoteCoverSource.of("../../attachments/other/My%20photo.png", noteId: "n1")
                == .attachment(ownerNoteId: "other", url: "My photo.png")
        )
    }

    @Test func anyOtherPathBindsAgainstThisNote() {
        #expect(
            NoteCoverSource.of("Images/photo.png", noteId: "n1")
                == .attachment(ownerNoteId: "n1", url: "Images/photo.png")
        )
        #expect(
            NoteCoverSource.of("https://example.com/a.jpg", noteId: "n1")
                == .remote(URL(string: "https://example.com/a.jpg")!)
        )
    }

    // MARK: uploading

    @Test func theRefIsTheRootRelativeAttachmentPath() {
        #expect(NoteCoverUpload.ref(noteId: "n1", filename: "cover-x.jpg") == "attachments/n1/cover-x.jpg")
    }

    @Test func aFormatDesktopDrawsIsKeptAsIs() throws {
        let png = try #require(Self.pixel.pngData())
        let prepared = try #require(NoteCoverUpload.prepare(bytes: png, fileExtension: "PNG", stamp: "s"))
        #expect(prepared.filename == "cover-s.png")
        #expect(prepared.mimeType == "image/png")
        #expect(prepared.bytes == png)
        #expect(NoteCoverValue.kind(of: prepared.filename) != nil)
    }

    /// HEIC from the camera roll would land as a text property on desktop.
    @Test func anyOtherFormatIsReencodedAsJPEG() throws {
        let png = try #require(Self.pixel.pngData())
        let prepared = try #require(NoteCoverUpload.prepare(bytes: png, fileExtension: "heic", stamp: "s"))
        #expect(prepared.filename == "cover-s.jpg")
        #expect(prepared.mimeType == "image/jpeg")
        #expect(NoteCoverValue.kind(of: prepared.filename) != nil)
    }

    @Test func bytesThatAreNotAPictureAreRefused() {
        #expect(NoteCoverUpload.prepare(bytes: Data("hello".utf8), fileExtension: "png", stamp: "s") == nil)
    }

    private static var pixel: UIImage {
        UIGraphicsImageRenderer(size: CGSize(width: 2, height: 2)).image { context in
            UIColor.gray.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 2, height: 2))
        }
    }
}
