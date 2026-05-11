import { Heading, Text } from '@react-email/components'
import { Eyebrow } from '../components/Eyebrow'
import { Footer } from '../components/Footer'
import { HeroImage } from '../components/HeroImage'
import { InlineImage } from '../components/InlineImage'
import { Layout } from '../components/Layout'
import { Signoff } from '../components/Signoff'
import { TOTAL_EMAILS, WAITLIST_FIRST_NAME } from '../components/constants'
import { body, greeting, heading, sectionHeading, subhead } from '../components/styles'

export const subject = 'Tasks that live alongside your notes'
export const preview = 'One place for the thinking and the doing.'

export default function Email04Tasks() {
  return (
    <Layout preview={preview}>
      <Eyebrow label="TASKS" index={4} total={TOTAL_EMAILS} />
      <Heading style={heading}>Tasks that live alongside your notes.</Heading>
      <Text style={subhead}>One place for the thinking and the doing.</Text>

      <Text style={greeting}>Hi {WAITLIST_FIRST_NAME},</Text>

      <Text style={body}>
        A task in Memry is a first-class object. It has a date, a status, a priority, a context, and
        an optional project. It belongs to the same workspace as your notes.
      </Text>

      <HeroImage
        alt="Task list with details panel open"
        caption="Tasks sit in the same workspace as your notes and projects."
      />

      <Text style={body}>
        Most apps split thinking and doing into two surfaces. You write your idea in one app. You
        add the work in another. Then you spend the rest of the year keeping them in sync.
      </Text>

      <Text style={body}>
        Memry keeps both in the same place. Mention a task inside a note and they link. Open a
        project and you see notes, tasks, and journal entries from that project in one column.
      </Text>

      <InlineImage alt="A note with embedded tasks linked inline" />

      <Heading as="h2" style={sectionHeading}>
        What you can do
      </Heading>
      <Text style={body}>
        Set due dates. Set priorities. Group by status. Filter by context. Inline a task in a note.
        Schedule a task on the calendar. Drag a task between days when the week shifts.
      </Text>

      <Signoff launchLine="Launching in 5 weeks." />
      <Footer />
    </Layout>
  )
}

Email04Tasks.PreviewProps = {}
