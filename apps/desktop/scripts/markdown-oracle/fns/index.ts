import { FNS as blocks } from './blocks'
import { FNS as critic } from './critic'
import { FNS as markers } from './markers'
import { FNS as text } from './text'

/** Every function-level oracle of stage 4, by name. Names are unique across layers. */
export const FNS: Record<string, (...args: never[]) => unknown> = {
  ...text,
  ...markers,
  ...blocks,
  ...critic
}
