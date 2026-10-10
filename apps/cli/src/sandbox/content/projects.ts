import type { ProjectSpec } from '../specs.ts'

export const projects: ProjectSpec[] = [
  {
    key: 'aurora',
    name: 'Aurora launch',
    description: 'Ship Aurora 1.0, a calm reading app with highlights that sync and stay yours.',
    color: '#f59e0b',
    icon: '🌅',
    statuses: ['Backlog', 'Design', 'Build', 'Review', 'Done'],
    homeNote: 'aurora-brief'
  },
  {
    key: 'studio',
    name: 'Studio ops',
    description: 'The recurring work that keeps Fieldwork running: invoices, hiring, rituals.',
    color: '#64748b',
    icon: '🛠️'
  },
  {
    key: 'website',
    name: 'Website v1',
    description: 'The first Fieldwork site. Shipped, retired, kept for the record.',
    color: '#0ea5e9',
    icon: '🕸️',
    archived: true
  }
]
