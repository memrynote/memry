import { useState } from 'react'
import { createReactBlockSpec } from '@blocknote/react'
import { youtubeEmbedConfig } from '@memry/editor-schema/blocks'
import { Play } from '@/lib/icons'
import { getYouTubeThumbnailUrl, getYouTubeEmbedUrl } from '@/lib/youtube-utils'
import { useT } from '@memry/i18n/renderer'

function YouTubePlayer({ videoId, title }: { videoId: string; title?: string }) {
  const [isPlaying, setIsPlaying] = useState(false)

  if (isPlaying) {
    return (
      <div className="relative aspect-video overflow-hidden rounded-[10px] bg-black">
        <iframe
          src={getYouTubeEmbedUrl(videoId)}
          className="size-full"
          sandbox="allow-scripts allow-same-origin allow-presentation"
          allow="autoplay; encrypted-media"
          title={title || 'YouTube video'}
        />
      </div>
    )
  }

  return (
    <button
      type="button"
      className="relative aspect-video w-full overflow-hidden rounded-[10px] bg-muted cursor-pointer group"
      onClick={() => setIsPlaying(true)}
    >
      <img
        src={getYouTubeThumbnailUrl(videoId)}
        alt={title || 'YouTube video'}
        className="size-full object-cover"
      />
      <div className="absolute inset-0 flex items-center justify-center bg-black/20 group-hover:bg-black/30 transition-colors">
        <div className="flex items-center justify-center size-14 rounded-full bg-red-600 group-hover:bg-red-500 transition-colors shadow-lg">
          <Play className="size-6 text-white ms-0.5" />
        </div>
      </div>
    </button>
  )
}

function YoutubeEmbedBlockRender({
  block,
  contentRef
}: {
  block: { props: { videoId: string; videoUrl: string } }
  contentRef: React.Ref<HTMLDivElement>
}) {
  const { t: tPhaseF } = useT('notes')
  const { videoId, videoUrl } = block.props

  if (!videoId) {
    return (
      <div ref={contentRef} className="p-2 text-muted-foreground text-sm">
        {tPhaseF('phaseF.componentsNoteContentAreaYoutubeEmbedBlock.noVideoUrl')}
      </div>
    )
  }

  return (
    <div ref={contentRef} className="youtube-embed-block my-2" contentEditable={false}>
      <YouTubePlayer videoId={videoId} />
      {videoUrl && (
        <a
          href={videoUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1.5 block text-[11px] text-muted-foreground/60 hover:text-muted-foreground truncate transition-colors"
        >
          {videoUrl}
        </a>
      )}
    </div>
  )
}

// Type/props/content and the `![embed](url)` on-disk form come from the shared
// package so the main process registers the same node and writes the same bytes.
export const createYoutubeEmbedBlock = createReactBlockSpec(youtubeEmbedConfig, {
  render: YoutubeEmbedBlockRender
})

export { EMBED_BLOCK_REGEX, serializeYoutubeEmbed } from '@memry/editor-schema/blocks'
