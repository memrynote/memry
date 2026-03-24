import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('react-tweet', () => ({
  useTweet: vi.fn()
}))

import { useTweet } from 'react-tweet'
import { TweetCard } from './tweet-card'

const mockUseTweet = vi.mocked(useTweet)

const baseItem = {
  id: 'item-1',
  type: 'social' as const,
  title: 'Tweet by @rauchg',
  content: null,
  sourceUrl: 'https://twitter.com/rauchg/status/1234567890',
  processingStatus: 'complete',
  metadata: {
    platform: 'twitter' as const,
    tweetId: '1234567890',
    postUrl: 'https://twitter.com/rauchg/status/1234567890',
    authorName: '',
    authorHandle: '@rauchg',
    postContent: '',
    mediaUrls: [],
    extractionStatus: 'partial' as const
  }
}

describe('TweetCard', () => {
  beforeEach(() => {
    mockUseTweet.mockReset()
  })

  it('should show loading skeleton while fetching', () => {
    mockUseTweet.mockReturnValue({
      data: undefined,
      error: undefined,
      isLoading: true
    } as ReturnType<typeof useTweet>)

    render(<TweetCard item={baseItem} />)

    expect(screen.getByTestId('tweet-skeleton')).toBeInTheDocument()
  })

  it('should show error state when tweet not found', () => {
    mockUseTweet.mockReturnValue({
      data: undefined,
      error: new Error('Not found'),
      isLoading: false
    } as ReturnType<typeof useTweet>)

    render(<TweetCard item={baseItem} />)

    expect(screen.getByText(/unavailable/i)).toBeInTheDocument()
  })

  it('should render tweet content on success', () => {
    mockUseTweet.mockReturnValue({
      data: {
        __typename: 'Tweet',
        lang: 'en',
        favorite_count: 4200,
        possibly_sensitive: false,
        created_at: '2025-12-28T12:00:00.000Z',
        display_text_range: [0, 140],
        id_str: '1234567890',
        text: 'The future is offline-capable by default',
        full_text: 'The future is offline-capable by default',
        user: {
          id_str: '123',
          name: 'Guillermo Rauch',
          screen_name: 'rauchg',
          verified: true,
          profile_image_url_https: 'https://pbs.twimg.com/profile_images/avatar.jpg',
          is_blue_verified: true,
          profile_image_shape: 'Circle'
        },
        edit_control: {
          edit_tweet_ids: ['1234567890'],
          editable_until_msecs: '0',
          is_edit_eligible: false,
          edits_remaining: '0'
        },
        isEdited: false,
        isStaleEdit: false
      },
      error: undefined,
      isLoading: false
    } as unknown as ReturnType<typeof useTweet>)

    render(<TweetCard item={baseItem} />)

    expect(screen.getByText('Guillermo Rauch')).toBeInTheDocument()
    expect(screen.getByText('@rauchg')).toBeInTheDocument()
    expect(screen.getByText(/offline-capable/)).toBeInTheDocument()
  })

  it('should show x.com badge', () => {
    mockUseTweet.mockReturnValue({
      data: {
        __typename: 'Tweet',
        lang: 'en',
        favorite_count: 100,
        possibly_sensitive: false,
        created_at: '2025-12-28T12:00:00.000Z',
        display_text_range: [0, 10],
        id_str: '123',
        text: 'Hello',
        full_text: 'Hello',
        user: {
          id_str: '1',
          name: 'Test',
          screen_name: 'test',
          verified: false,
          profile_image_url_https: '',
          is_blue_verified: false,
          profile_image_shape: 'Circle'
        },
        edit_control: {
          edit_tweet_ids: ['123'],
          editable_until_msecs: '0',
          is_edit_eligible: false,
          edits_remaining: '0'
        },
        isEdited: false,
        isStaleEdit: false
      },
      error: undefined,
      isLoading: false
    } as unknown as ReturnType<typeof useTweet>)

    render(<TweetCard item={baseItem} />)

    expect(screen.getByText('x.com')).toBeInTheDocument()
  })

  it('should call useTweet with tweetId from metadata', () => {
    mockUseTweet.mockReturnValue({
      data: undefined,
      error: undefined,
      isLoading: true
    } as ReturnType<typeof useTweet>)

    render(<TweetCard item={baseItem} />)

    expect(mockUseTweet).toHaveBeenCalledWith('1234567890')
  })

  it('should extract tweetId from sourceUrl if not in metadata', () => {
    mockUseTweet.mockReturnValue({
      data: undefined,
      error: undefined,
      isLoading: true
    } as ReturnType<typeof useTweet>)

    const itemWithoutTweetId = {
      ...baseItem,
      metadata: { ...baseItem.metadata, tweetId: undefined }
    }

    render(<TweetCard item={itemWithoutTweetId} />)

    expect(mockUseTweet).toHaveBeenCalledWith('1234567890')
  })

  it('should show error when no tweetId can be extracted', () => {
    mockUseTweet.mockReturnValue({
      data: undefined,
      error: undefined,
      isLoading: false
    } as ReturnType<typeof useTweet>)

    const itemNoId = {
      ...baseItem,
      sourceUrl: 'https://twitter.com/user',
      metadata: { ...baseItem.metadata, tweetId: undefined }
    }

    render(<TweetCard item={itemNoId} />)

    expect(screen.getByText(/unavailable/i)).toBeInTheDocument()
  })
})
