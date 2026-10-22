import { PortalChannels } from '@memry/contracts/ipc-channels'
import type {
  PortalGetUsageInput,
  PortalSearchInput,
  PortalStampAnchorInput,
  PortalUsageChangedEvent
} from '@memry/contracts/portals-api'
import { invoke, subscribe } from '../lib/ipc'

export const portalsApi = {
  getUsage: (input: PortalGetUsageInput) => invoke(PortalChannels.invoke.GET_USAGE, input),
  stampAnchor: (input: PortalStampAnchorInput) => invoke(PortalChannels.invoke.STAMP_ANCHOR, input),
  search: (input: PortalSearchInput) => invoke(PortalChannels.invoke.SEARCH, input),
  onUsageChanged: (callback: (event: PortalUsageChangedEvent) => void): (() => void) =>
    subscribe<PortalUsageChangedEvent>(PortalChannels.events.USAGE_CHANGED, callback)
}
