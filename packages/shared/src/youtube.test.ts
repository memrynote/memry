import { describe, expect, it } from 'vitest'
import { extractYouTubeVideoId } from './youtube'

describe('extractYouTubeVideoId', () => {
  it('extracts valid YouTube video ids from supported URL shapes', () => {
    expect(extractYouTubeVideoId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
    expect(extractYouTubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
    expect(extractYouTubeVideoId('https://music.youtube.com/embed/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
    expect(extractYouTubeVideoId('https://youtube.com/shorts/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
  })

  it('rejects invalid ids and non-YouTube hostnames', () => {
    expect(extractYouTubeVideoId('https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ')).toBeNull()
    expect(extractYouTubeVideoId('https://www.youtube.com/watch?v=too-short')).toBeNull()
    expect(extractYouTubeVideoId('not a url')).toBeNull()
  })
})
