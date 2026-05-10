import { store } from '../../store'

export interface DisclosureState {
  accepted: boolean
}

export function getDisclosureState(): DisclosureState {
  return { accepted: store.get('agent').disclosureAccepted === true }
}

export function acceptDisclosure(): DisclosureState {
  store.set('agent', { ...store.get('agent'), disclosureAccepted: true })
  return { accepted: true }
}
