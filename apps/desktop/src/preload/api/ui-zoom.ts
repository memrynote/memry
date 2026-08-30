import { UiZoomChannels, type UiZoomChangedEvent, type ZoomFactor } from '@memry/contracts/ui-zoom'
import { invoke, subscribe } from '../lib/ipc'

export const uiZoomApi = {
  get: (): Promise<ZoomFactor> => invoke(UiZoomChannels.invoke.GET),
  set: (factor: number): Promise<ZoomFactor> => invoke(UiZoomChannels.invoke.SET, factor)
}

export const uiZoomEvents = {
  onUiZoomChanged: (callback: (event: UiZoomChangedEvent) => void): (() => void) =>
    subscribe<UiZoomChangedEvent>(UiZoomChannels.events.CHANGED, callback)
}
