import AVKit
import MemryCore
import PDFKit
import QuickLook
import SwiftUI

// The pieces the attachment views are built from, split from `NoteAttachmentViews.swift`.

/// A video or a recording, playable in place.
///
/// The player is held in state: built in `body`, it was rebuilt on every
/// re-render, and a note that re-read itself mid-playback stopped the clip.
struct MediaPlayer: View {
    let url: URL
    let isAudio: Bool
    @State private var player: AVPlayer?

    var body: some View {
        VideoPlayer(player: player)
            .aspectRatio(isAudio ? nil : 16 / 9, contentMode: .fit)
            .frame(height: isAudio ? 64 : nil)
            .clipShape(.rect(cornerRadius: Tokens.Radius.card))
            .onAppear {
                if player == nil { player = AVPlayer(url: url) }
            }
            .onDisappear { player?.pause() }
    }
}

/// A PDF, laid out for reading inside the note.
struct PDFPreview: UIViewRepresentable {
    let url: URL

    func makeUIView(context: Context) -> PDFView {
        let view = PDFView()
        view.autoScales = true
        view.displayMode = .singlePageContinuous
        view.displayDirection = .vertical
        view.backgroundColor = .clear
        view.document = PDFDocument(url: url)
        return view
    }

    func updateUIView(_ view: PDFView, context: Context) {
        if view.document?.documentURL != url {
            view.document = PDFDocument(url: url)
        }
    }
}

struct LocalImage: View {
    let path: URL
    let label: String
    let maxWidth: Double?

    var body: some View {
        if let image = UIImage(contentsOfFile: path.path(percentEncoded: false)) {
            Image(uiImage: image)
                .resizable()
                .scaledToFit()
                .frame(maxWidth: maxWidth.map { CGFloat($0) } ?? .infinity)
                .clipShape(.rect(cornerRadius: Tokens.Radius.card))
                .accessibilityLabel(label)
        } else {
            // The row says the bytes are here and they would not decode: a
            // truncated write, or a format this platform does not read. Said
            // plainly rather than drawn as an empty box.
            AttachmentPlaceholder(
                symbol: "exclamationmark.triangle",
                label: label,
                detail: "This picture could not be opened"
            )
        }
    }
}

struct RemoteImage: View {
    let address: String
    let label: String

    var body: some View {
        AsyncImage(url: URL(string: address)) { phase in
            switch phase {
            case let .success(image):
                image
                    .resizable()
                    .scaledToFit()
                    .clipShape(.rect(cornerRadius: Tokens.Radius.card))
                    .accessibilityLabel(label)
            case .failure:
                AttachmentPlaceholder(
                    symbol: "photo",
                    label: label,
                    detail: "This picture is on the web and did not load"
                )
            default:
                AttachmentPlaceholder(symbol: "photo", label: label, detail: "Loading")
            }
        }
    }
}

/// The block is here and the bytes are not, said in words.
struct AttachmentPlaceholder: View {
    let symbol: String
    let label: String
    let detail: String

    var body: some View {
        AttachmentCard(symbol: symbol, label: label, detail: detail)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(label), \(detail)")
    }
}

struct AttachmentCard: View {
    let symbol: String
    let label: String
    let detail: String

    var body: some View {
        HStack(spacing: Tokens.Space.medium) {
            Image(systemName: symbol)
                .font(Tokens.Typography.body.font)
                .foregroundStyle(Tokens.Text.secondary.color)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: Tokens.Space.tight) {
                Text(label)
                    .font(Tokens.Typography.supporting.font)
                    .foregroundStyle(Tokens.Text.primary.color)
                    .lineLimit(2)
                Text(detail)
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
            }
            Spacer(minLength: 0)
        }
        .padding(Tokens.Space.inset)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(
            RoundedRectangle(cornerRadius: Tokens.Radius.card)
                .stroke(Tokens.Line.border.color, lineWidth: Tokens.Size.hairline)
        )
    }
}

/// A card that opens an address, for a remote attachment.
struct LinkCardRowPublic: View {
    let url: String
    let title: String
    let subtitle: String?
    let symbol: String

    var body: some View {
        if let destination = URL(string: url) {
            Link(destination: destination) {
                AttachmentCard(symbol: symbol, label: title, detail: subtitle ?? url)
            }
            .accessibilityAddTraits(.isLink)
        } else {
            AttachmentCard(symbol: symbol, label: title, detail: subtitle ?? url)
        }
    }
}
