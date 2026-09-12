import type {
  UnsplashDownloadInput,
  UnsplashDownloadResult,
  UnsplashSearchInput,
  UnsplashSearchResult
} from '../../contracts/src/unsplash-api.ts'
import { UnsplashChannels } from '../../contracts/src/ipc-channels.ts'
import { defineDomain, defineMethod, type RpcClient } from './schema.ts'

export const unsplashRpc = defineDomain({
  name: 'unsplash',
  methods: {
    search: defineMethod<(input: UnsplashSearchInput) => Promise<UnsplashSearchResult>>({
      channel: UnsplashChannels.invoke.SEARCH,
      params: ['input']
    }),
    download: defineMethod<(input: UnsplashDownloadInput) => Promise<UnsplashDownloadResult>>({
      channel: UnsplashChannels.invoke.DOWNLOAD,
      params: ['input']
    })
  },
  events: {}
})

export type UnsplashClientAPI = RpcClient<typeof unsplashRpc>
