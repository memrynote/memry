import { PropertyDefinitionsService } from '../vault/property-definitions'

/**
 * Property names whose date value should render on the calendar (vault-wide,
 * synced via `.memry/properties.md`). Returns an empty list if the property
 * definitions service is not initialized yet (e.g. before a vault is open).
 */
export function getCalendarEnabledPropertyNames(): string[] {
  try {
    return PropertyDefinitionsService.get().listCalendarEnabledNames()
  } catch {
    return []
  }
}
