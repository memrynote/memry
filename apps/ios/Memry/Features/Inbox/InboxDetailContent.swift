import AVKit
import MemryCore
import PDFKit
import SwiftUI

// IB10 / IB11 / IB12. The body of a detail, per type (Paper 10-12 and the
// caption of 12): link card + saved article, voice player + transcript,
// image with its facts, editable note body, PDF first page, video player,
// post card, clip quote + source, reminder target.

struct InboxDetailContent: View {
    let item: InboxItemRecord
    let store: InboxStore
    let editable: Bool

    private var meta: [String: Any] { InboxMeta.metadata(item) }
    private var file: URL? { store.localFile(item.attachmentPath) }

    var body: some View {
        switch item.itemType {
        case "link": linkBody
        case "voice": InboxVoiceDetail(item: item, store: store, file: file)
        case "image": imageBody
        case "note": InboxNoteEditor(item: item, store: store, editable: editable)
        case "pdf": pdfBody
        case "video": videoBody
        case "social": socialBody
        case "clip": clipBody
        case "reminder": InboxReminderDetail(item: item)
        default: textBody(item.content ?? "")
        }
    }

    // MARK: Link (Paper 10)

    private var linkBody: some View {
        let article = ["full", "partial"].contains(meta["extractionStatus"] as? String ?? "")
        return VStack(alignment: .leading, spacing: Tokens.Space.inset) {
            VStack(alignment: .leading, spacing: 0) {
                let thumbnail = store.localFile(item.thumbnailPath).flatMap { UIImage(contentsOfFile: $0.path) }
                // Desktop downloads the hero beside its own copy only; the
                // synced `heroImage` address stands in on this device.
                let remote = (meta["heroImage"] as? String).flatMap(URL.init(string:)).flatMap { $0.scheme == "https" ? $0 : nil }
                let hasHero = thumbnail != nil || remote != nil
                // Paper 10's hero: the page image with its headline. Without an
                // image the headline moves into the card instead of sitting on
                // an empty 180pt block.
                if hasHero {
                    Rectangle()
                        .fill(Tokens.Canvas.surface.color)
                        .frame(height: 180)
                        .overlay {
                            if let thumbnail {
                                Image(uiImage: thumbnail).resizable().scaledToFill()
                            } else {
                                AsyncImage(url: remote) { $0.resizable().scaledToFill() } placeholder: { EmptyView() }
                            }
                        }
                        .overlay(alignment: .bottomLeading) {
                            ZStack(alignment: .bottomLeading) {
                                LinearGradient(colors: [.clear, .black.opacity(0.55)], startPoint: .center, endPoint: .bottom)
                                Text(previewHeadline)
                                    .font(Tokens.Typography.sectionTitle.font.weight(.bold))
                                    .foregroundStyle(Tokens.Inbox.onImage.color)
                                    .lineLimit(2)
                                    .padding(Tokens.Space.inset)
                            }
                        }
                        .clipped()
                }
                VStack(alignment: .leading, spacing: Tokens.Space.small) {
                    if !hasHero {
                        Text(previewHeadline)
                            .font(Tokens.Typography.heading.font)
                            .foregroundStyle(Tokens.Text.primary.color)
                            .lineLimit(2)
                    }
                    if !article, let description = item.content ?? (meta["description"] as? String), !description.isEmpty {
                        Text(description)
                            .font(Tokens.Typography.supporting.font)
                            .foregroundStyle(Tokens.Text.secondary.color)
                    }
                    HStack {
                        Text(InboxMeta.domain(item.sourceUrl ?? "") ?? "")
                            .font(Tokens.Typography.caption.font)
                            .foregroundStyle(Tokens.Text.tertiary.color)
                        Spacer()
                        if let link = item.sourceUrl, let url = URL(string: link) {
                            Link(InboxCopy.open, destination: url)
                                .font(Tokens.Typography.caption.font.weight(.semibold))
                                .foregroundStyle(Tokens.Text.tint.color)
                                .frame(minHeight: Tokens.Size.minimumHitArea)
                                .accessibilityIdentifier("inbox.detail.open")
                        }
                    }
                }
                .padding(Tokens.Space.inset)
            }
            .clipShape(.rect(cornerRadius: Tokens.Radius.card))
            .overlay {
                RoundedRectangle(cornerRadius: Tokens.Radius.card).strokeBorder(Tokens.Line.border.color, lineWidth: Tokens.Size.hairline)
            }
            if article, let text = item.content, !text.isEmpty {
                Text(InboxCopy.savedArticle)
                    .font(Tokens.Typography.caption.font.weight(.semibold))
                    .foregroundStyle(Tokens.Text.secondary.color)
                textBody(text)
            }
        }
    }

    /// Paper 10 sets the page's own headline over the preview image; the site
    /// name, then the domain, stand in when the metadata has none.
    private var previewHeadline: String {
        let pageTitle = (meta["title"] as? String).flatMap { $0 == item.title ? nil : $0 }
        return pageTitle ?? (meta["siteName"] as? String) ?? InboxMeta.domain(item.sourceUrl ?? "") ?? ""
    }

    // MARK: Image, PDF, video (Paper 12)

    private var imageBody: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.inset) {
            if let file, let image = UIImage(contentsOfFile: file.path) {
                InboxZoomableImage(image: image)
            } else {
                fileElsewhere
            }
            facts([
                (InboxCopy.dimensions, dimensions),
                (InboxCopy.format, (meta["format"] as? String)?.uppercased()),
                (InboxCopy.size, (meta["fileSize"] as? NSNumber).map { InboxMeta.byteString($0.doubleValue) })
            ])
        }
    }

    private var dimensions: String? {
        guard let width = (meta["width"] as? NSNumber)?.intValue, let height = (meta["height"] as? NSNumber)?.intValue else { return nil }
        return "\(width) × \(height)"
    }

    private var pdfBody: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.inset) {
            if let file, let page = PDFDocument(url: file)?.page(at: 0) {
                Image(uiImage: page.thumbnail(of: CGSize(width: 600, height: 800), for: .mediaBox))
                    .resizable()
                    .scaledToFit()
                    .clipShape(.rect(cornerRadius: Tokens.Radius.card))
                    .accessibilityHidden(true)
            } else {
                fileElsewhere
            }
            facts([
                (InboxCopy.pagesLabel, (meta["pageCount"] as? NSNumber).map { InboxCopy.pageCount($0.intValue) }),
                (InboxCopy.size, (meta["fileSize"] as? NSNumber).map { InboxMeta.byteString($0.doubleValue) })
            ])
        }
    }

    @ViewBuilder private var videoBody: some View {
        if let file {
            VideoPlayer(player: AVPlayer(url: file))
                .frame(height: 240)
                .clipShape(.rect(cornerRadius: Tokens.Radius.card))
        } else {
            fileElsewhere
        }
    }

    // MARK: Social, clip

    private var socialBody: some View {
        let failed = (meta["extractionStatus"] as? String) == "failed"
        let post = (meta["postContent"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? item.content
        return VStack(alignment: .leading, spacing: Tokens.Space.small) {
            if failed && (post ?? "").isEmpty {
                Text(InboxCopy.tweetUnavailable).font(Tokens.Typography.body.font.weight(.semibold))
                Text(InboxCopy.tweetUnavailableDetail).font(Tokens.Typography.supporting.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
            } else {
                let handle = meta["authorHandle"] as? String ?? ""
                let name = meta["authorName"] as? String ?? ""
                if !handle.isEmpty || !name.isEmpty {
                    Text([name, handle].filter { !$0.isEmpty }.joined(separator: " "))
                        .font(Tokens.Typography.supporting.font.weight(.semibold))
                }
                if let post { Text(post).font(Tokens.Typography.body.font) }
            }
            if let link = item.sourceUrl, let url = URL(string: link) {
                Link(InboxCopy.viewOn(platform: platform(url)), destination: url)
                    .font(Tokens.Typography.supporting.font.weight(.semibold))
                    .foregroundStyle(Tokens.Text.tint.color)
                    .frame(minHeight: Tokens.Size.minimumHitArea)
            }
        }
        .padding(Tokens.Space.inset)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Tokens.Canvas.surface.color, in: .rect(cornerRadius: Tokens.Radius.card))
    }

    /// Desktop's `metadata.platform`, else the site name in the address.
    private func platform(_ url: URL) -> String? {
        meta["platform"] as? String ?? url.host()?.split(separator: ".").dropLast().last.map(String.init)
    }

    private var clipBody: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            HStack(alignment: .top, spacing: Tokens.Space.medium) {
                Rectangle().fill(Tokens.Inbox.clip.color).frame(width: 3).accessibilityHidden(true)
                Text(item.content ?? (meta["quotedText"] as? String) ?? "")
                    .font(Tokens.Typography.body.font)
                    .foregroundStyle(Tokens.Text.primary.color)
            }
            if let link = item.sourceUrl, let url = URL(string: link) {
                Link(destination: url) {
                    Label(item.sourceTitle ?? InboxMeta.domain(link) ?? link, systemImage: "link")
                        .font(Tokens.Typography.supporting.font)
                        .foregroundStyle(Tokens.Text.tint.color)
                }
                .frame(minHeight: Tokens.Size.minimumHitArea)
            }
        }
    }

    // MARK: Shared

    private func textBody(_ text: String) -> some View {
        Text(text)
            .font(Tokens.Typography.body.font)
            .foregroundStyle(Tokens.Text.primary.color)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var fileElsewhere: some View {
        Label(InboxCopy.fileNotHere, systemImage: "iphone.slash")
            .font(Tokens.Typography.supporting.font)
            .foregroundStyle(Tokens.Text.secondary.color)
            .padding(Tokens.Space.inset)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Tokens.Canvas.surface.color, in: .rect(cornerRadius: Tokens.Radius.card))
    }

    private func facts(_ rows: [(String, String?)]) -> some View {
        VStack(spacing: 0) {
            ForEach(rows.filter { $0.1 != nil }, id: \.0) { label, value in
                HStack {
                    Text(label).foregroundStyle(Tokens.Text.secondary.color)
                    Spacer()
                    Text(value ?? "").foregroundStyle(Tokens.Text.primary.color)
                }
                .font(Tokens.Typography.supporting.font)
                .frame(minHeight: Tokens.Size.minimumHitArea)
                .accessibilityElement(children: .combine)
                Divider()
            }
        }
    }
}

/// An image that zooms with a pinch and opens full screen on tap (Paper 12).
struct InboxZoomableImage: View {
    let image: UIImage
    @State private var fullScreen = false
    @State private var scale: CGFloat = 1

    var body: some View {
        Image(uiImage: image)
            .resizable()
            .scaledToFit()
            .clipShape(.rect(cornerRadius: Tokens.Radius.card))
            .onTapGesture { fullScreen = true }
            .accessibilityAddTraits(.isImage)
            .fullScreenCover(isPresented: $fullScreen) {
                ZStack(alignment: .topTrailing) {
                    Color.black.ignoresSafeArea()
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                        .scaleEffect(scale)
                        .gesture(MagnifyGesture().onChanged { scale = max(1, $0.magnification) }.onEnded { _ in
                            if scale < 1.05 { scale = 1 }
                        })
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                    Button(InboxCopy.close, systemImage: "xmark") {
                        scale = 1
                        fullScreen = false
                    }
                    .labelStyle(.iconOnly)
                    .buttonStyle(.glass)
                    .padding(Tokens.Space.inset)
                }
            }
    }
}
