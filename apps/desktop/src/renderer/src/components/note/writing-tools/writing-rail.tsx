import { AlternativesRail } from './alternatives-rail'
import { LabRail } from './lab-rail'
import { OverflowRail } from './overflow-rail'
import type {
  WritingRailMode,
  WritingToolsSession,
  WritingToolsSnapshot
} from './writing-tools-session'

interface WritingRailProps {
  mode: WritingRailMode
  session: WritingToolsSession
  snapshot: WritingToolsSnapshot
}

/** The note side rail in one of its writing modes (review cards are the default mode). */
export function WritingRail({ mode, session, snapshot }: WritingRailProps) {
  switch (mode) {
    case 'alternatives':
      return <AlternativesRail session={session} snapshot={snapshot} />
    case 'overflow':
      return <OverflowRail session={session} snapshot={snapshot} />
    case 'lab':
      return <LabRail session={session} snapshot={snapshot} />
  }
}
