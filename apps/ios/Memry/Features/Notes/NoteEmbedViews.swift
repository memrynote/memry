import LinkPresentation
import SwiftUI
import UIKit

// The two embed blocks, drawn the way desktop draws them: a YouTube video as
// its thumbnail with a play mark, a bookmark as a card with the page's own
// title, description and image.
//
// **Nothing here is fetched on the note's behalf that desktop does not fetch
// too.** Desktop loads the thumbnail and the page's metadata when it renders
// the block; this does the same, when the block is on screen, and falls back
// to the address itself while that is loading or when it fails. The note is
// readable offline either way.

/// A YouTube embed: the video's thumbnail, and a tap that opens it.
struct YouTubeCard: View {
    let videoUrl: String?
    let videoId: String?
    let title: String?

    private var destination: URL? {
        videoUrl.flatMap { $0.isEmpty ? nil : URL(string: $0) }
    }

    /// YouTube's own still for the video. `hqdefault` exists for every
    /// public video, which the larger sizes do not.
    private var thumbnail: URL? {
        let id = (videoId?.isEmpty == false ? videoId : nil) ?? Self.id(from: videoUrl)
        return id.flatMap { URL(string: "https://img.youtube.com/vi/\($0)/hqdefault.jpg") }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            if let destination {
                Link(destination: destination) { still }
                    .accessibilityLabel(title?.isEmpty == false ? title ?? "" : "YouTube video")
                    .accessibilityAddTraits(.isLink)
            } else {
                still
            }
            if let videoUrl, !videoUrl.isEmpty {
                Text(videoUrl)
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.tint.color)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
    }

    private var still: some View {
        ZStack {
            AsyncImage(url: thumbnail) { phase in
                if case let .success(image) = phase {
                    image.resizable().scaledToFill()
                } else {
                    Tokens.Canvas.surface.color
                }
            }
            Image(systemName: "play.circle.fill")
                .font(.system(size: 52))
                .symbolRenderingMode(.palette)
                .foregroundStyle(.white, .red)
                .accessibilityHidden(true)
        }
        .aspectRatio(16 / 9, contentMode: .fit)
        .frame(maxWidth: .infinity)
        .clipShape(.rect(cornerRadius: Tokens.Radius.card))
    }

    /// The id in `watch?v=`, `youtu.be/` and `/embed/` addresses.
    static func id(from address: String?) -> String? {
        guard let address, let components = URLComponents(string: address) else { return nil }
        if let watched = components.queryItems?.first(where: { $0.name == "v" })?.value,
           !watched.isEmpty {
            return watched
        }
        let segments = components.path.split(separator: "/").map(String.init)
        if components.host?.contains("youtu.be") == true { return segments.first }
        if let index = segments.firstIndex(where: { $0 == "embed" || $0 == "shorts" }),
           index + 1 < segments.count {
            return segments[index + 1]
        }
        return nil
    }
}

/// A bookmark: the page's own card when its metadata loads, the stored props
/// or the bare address until then.
struct BookmarkCard: View {
    let url: String?
    let title: String?
    let subtitle: String?

    @State private var metadata: LPLinkMetadata?

    var body: some View {
        Group {
            if let metadata {
                LinkPreview(metadata: metadata)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                BookmarkFallback(url: url, title: title, subtitle: subtitle)
            }
        }
        .task(id: url) { await load() }
    }

    private func load() async {
        guard let url, let address = URL(string: url), address.scheme?.hasPrefix("http") == true
        else { return }
        if let cached = LinkMetadataCache.shared.object(forKey: url as NSString) {
            metadata = cached
            return
        }
        let provider = LPMetadataProvider()
        provider.shouldFetchSubresources = true
        guard let fetched = try? await provider.startFetchingMetadata(for: address) else { return }
        LinkMetadataCache.shared.setObject(fetched, forKey: url as NSString)
        metadata = fetched
    }
}

/// Metadata already fetched this session, so scrolling a card off screen and
/// back does not fetch the page again.
private enum LinkMetadataCache {
    nonisolated(unsafe) static let shared = NSCache<NSString, LPLinkMetadata>()
}

private struct LinkPreview: UIViewRepresentable {
    let metadata: LPLinkMetadata

    func makeUIView(context: Context) -> LPLinkView {
        LPLinkView(metadata: metadata)
    }

    func updateUIView(_ view: LPLinkView, context: Context) {
        view.metadata = metadata
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: LPLinkView, context: Context) -> CGSize? {
        let width = proposal.width ?? UIView.layoutFittingExpandedSize.width
        let fitted = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        return CGSize(width: width, height: fitted.height)
    }
}

private struct BookmarkFallback: View {
    let url: String?
    let title: String?
    let subtitle: String?

    private var destination: URL? {
        url.flatMap { $0.isEmpty ? nil : URL(string: $0) }
    }

    var body: some View {
        if let destination {
            Link(destination: destination) { card }
                .accessibilityAddTraits(.isLink)
        } else {
            card
        }
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.tight) {
            Text(title?.isEmpty == false ? title ?? "" : (url ?? "A link is here"))
                .font(Tokens.Typography.supporting.font.weight(.medium))
                .foregroundStyle(Tokens.Text.primary.color)
                .lineLimit(2)
            if let subtitle, !subtitle.isEmpty {
                Label(subtitle, systemImage: "globe")
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
            }
        }
        .padding(Tokens.Space.inset)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(
            RoundedRectangle(cornerRadius: Tokens.Radius.card)
                .stroke(Tokens.Line.border.color, lineWidth: Tokens.Size.hairline)
        )
        .accessibilityElement(children: .combine)
    }
}
