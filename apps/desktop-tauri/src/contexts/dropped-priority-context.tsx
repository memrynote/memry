import { createContext, useContext } from 'react'
import type { Priority } from '@/data/sample-tasks'

type DroppedPriorities = Map<string, Priority>

const DroppedPriorityContext = createContext<DroppedPriorities>(new Map())

export const DroppedPriorityProvider = DroppedPriorityContext.Provider

export const useDroppedPriorities = (): DroppedPriorities => useContext(DroppedPriorityContext)
