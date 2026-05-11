import { Heading, Text } from '@react-email/components'
import { Eyebrow } from '../components/Eyebrow'
import { Footer } from '../components/Footer'
import { HeroImage } from '../components/HeroImage'
import { InlineImage } from '../components/InlineImage'
import { Layout } from '../components/Layout'
import { Signoff } from '../components/Signoff'
import { TOTAL_EMAILS, WAITLIST_FIRST_NAME } from '../components/constants'
import { body, greeting, heading, sectionHeading, subhead } from '../components/styles'

export const subject = 'Projects and a calendar that match'
export const preview = 'Plan the work. See the week.'

export default function Email06ProjectsCalendar() {
  return (
    <Layout preview={preview}>
      <Eyebrow label="PROJECTS" index={6} total={TOTAL_EMAILS} />
      <Heading style={heading}>Projects and a calendar that match.</Heading>
      <Text style={subhead}>Plan the work. See the week.</Text>

      <Text style={greeting}>Hi {WAITLIST_FIRST_NAME},</Text>

      <Text style={body}>
        A project in Memry is a container. Notes, tasks, journals, and files belong to it. Open the
        project and you see everything in one column, sorted by what you last touched.
      </Text>

      <HeroImage
        alt="Project view with notes, tasks, and journal entries grouped"
        caption="Projects gather every related artifact in one column."
      />

      <Text style={body}>
        The calendar is the other half. Every task with a date shows up. Every journal entry shows
        up. Drag a task from Wednesday to Thursday and the database updates. Click an empty day and
        you can create a task or a journal entry without leaving the view.
      </Text>

      <InlineImage alt="Calendar week view with a task being dragged between days" />

      <Heading as="h2" style={sectionHeading}>
        How they connect
      </Heading>
      <Text style={body}>
        Projects answer the question what am I working on. Calendars answer the question when is
        this happening. Memry lets you switch between the two without losing context.
      </Text>

      <Text style={body}>
        We tried hard to keep both views fast. They open instantly. They render instantly. There is
        no spinner.
      </Text>

      <Signoff launchLine="Launching in 3 weeks." />
      <Footer />
    </Layout>
  )
}

Email06ProjectsCalendar.PreviewProps = {}
