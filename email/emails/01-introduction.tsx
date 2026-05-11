import { Heading, Text } from '@react-email/components'
import { Eyebrow } from '../components/Eyebrow'
import { Footer } from '../components/Footer'
import { HeroImage } from '../components/HeroImage'
import { Layout } from '../components/Layout'
import { Signoff } from '../components/Signoff'
import { LAUNCH_DATE, TOTAL_EMAILS, WAITLIST_FIRST_NAME } from '../components/constants'
import { body, greeting, heading, subhead } from '../components/styles'

export const subject = 'Memry launches in 8 weeks'
export const preview = "A quick reintroduction to what we're building."

export default function Email01Introduction() {
  return (
    <Layout preview={preview}>
      <Eyebrow label="INTRODUCTION" index={1} total={TOTAL_EMAILS} />
      <Heading style={heading}>Memry, finally.</Heading>
      <Text style={subhead}>A calm place for everything you think about.</Text>

      <Text style={greeting}>Hi {WAITLIST_FIRST_NAME},</Text>

      <Text style={body}>
        You signed up to hear about Memry. We are eight weeks from launch, and we want to walk you
        through what has been built before you open the app.
      </Text>

      <HeroImage
        alt="Memry desktop overview"
        caption="Memry on macOS. Notes, tasks, calendar, and graph in one place."
      />

      <Text style={body}>
        Memry is one app for notes, tasks, journals, projects, and a daily inbox. It runs offline
        first, syncs across your devices, and the people who built it cannot read what you store
        inside it.
      </Text>

      <Text style={body}>
        We built Memry because the apps we used for thinking treated our writing like a product
        feature. They scanned it. They sold us back to ourselves. They worked offline only by
        accident.
      </Text>

      <Text style={body}>
        Over the next eight weeks we will show you what has been built, one piece at a time. Today
        is the wave. Next week, the notes editor.
      </Text>

      <Signoff launchLine={`Launching ${LAUNCH_DATE}.`} />
      <Footer />
    </Layout>
  )
}

Email01Introduction.PreviewProps = {}
