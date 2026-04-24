import type { MockRouteMap } from './types'
import { mockId, mockTimestamp } from './types'

interface MockBookmark {
  id: string
  url: string
  title: string
  description: string
  thumbnail: string | null
  tags: string[]
  folderId: string | null
  createdAt: number
  updatedAt: number
}

const fixtures = [
  { url: 'https://tailwindcss.com/docs', title: 'Tailwind CSS docs' },
  { url: 'https://tauri.app/', title: 'Tauri' },
  { url: 'https://react.dev/', title: 'React docs' },
  { url: 'https://vitejs.dev/', title: 'Vite' },
  { url: 'https://tanstack.com/query/latest', title: 'TanStack Query' },
  { url: 'https://www.prisma.io/docs', title: 'Prisma docs' },
  { url: 'https://nextjs.org/docs', title: 'Next.js docs' },
  { url: 'https://kit.svelte.dev/', title: 'SvelteKit' },
  { url: 'https://vercel.com/blog', title: 'Vercel blog' },
  { url: 'https://blog.cloudflare.com/', title: 'Cloudflare blog' },
  { url: 'https://news.ycombinator.com/', title: 'Hacker News' },
  { url: 'https://tr.wikipedia.org/', title: 'Türkçe Vikipedi' }
]

const bookmarks: MockBookmark[] = fixtures.map((f, i) => ({
  id: `bookmark-${i + 1}`,
  url: f.url,
  title: f.title,
  description: `Mock bookmark for ${f.title}`,
  thumbnail: null,
  tags: i % 2 === 0 ? ['docs'] : [],
  folderId: null,
  createdAt: mockTimestamp(30 - i),
  updatedAt: mockTimestamp(i)
}))

export const bookmarksRoutes: MockRouteMap = {
  bookmarks_list: async () => bookmarks,
  bookmarks_get: async (args) => {
    const { id } = args as { id: string }
    const b = bookmarks.find((x) => x.id === id)
    if (!b) throw new Error(`Bookmark ${id} not found`)
    return b
  },
  bookmarks_create: async (args) => {
    const input = args as Partial<MockBookmark> & { url: string }
    const now = Date.now()
    const b: MockBookmark = {
      id: mockId('bookmark'),
      url: input.url,
      title: input.title ?? input.url,
      description: input.description ?? '',
      thumbnail: input.thumbnail ?? null,
      tags: input.tags ?? [],
      folderId: input.folderId ?? null,
      createdAt: now,
      updatedAt: now
    }
    bookmarks.unshift(b)
    return b
  },
  bookmarks_update: async (args) => {
    const { id, ...changes } = args as { id: string } & Partial<MockBookmark>
    const b = bookmarks.find((x) => x.id === id)
    if (!b) throw new Error(`Bookmark ${id} not found`)
    Object.assign(b, changes, { updatedAt: Date.now() })
    return b
  },
  bookmarks_delete: async (args) => {
    const { id } = args as { id: string }
    const idx = bookmarks.findIndex((b) => b.id === id)
    if (idx >= 0) bookmarks.splice(idx, 1)
    return { ok: true }
  },
  bookmarks_preview: async (args) => {
    const { url } = args as { url: string }
    return {
      url,
      title: `Mock title for ${new URL(url).hostname}`,
      description: 'Mock description — generated at M1.',
      thumbnail: null,
      favicon: null
    }
  }
}
