import { Heading, Text } from '@react-email/components'
import { Eyebrow } from '../components/Eyebrow'
import { Footer } from '../components/Footer'
import { HeroImage } from '../components/HeroImage'
import { InlineImage } from '../components/InlineImage'
import { Layout } from '../components/Layout'
import { Signoff } from '../components/Signoff'
import { LAUNCH_DATE, TOTAL_EMAILS, WAITLIST_FIRST_NAME } from '../components/constants'
import { body, greeting, heading, list, sectionHeading, subhead } from '../components/styles'

export const subject = 'Memry launches next week'
export const preview = "A quick recap of everything we've shown you."

export default function Email10LaunchWeek() {
  return (
    <Layout preview={preview}>
      <Eyebrow label="ONE WEEK OUT" index={10} total={TOTAL_EMAILS} />
      <Heading style={heading}>Memry launches next week.</Heading>
      <Text style={subhead}>One email. Every feature. One place.</Text>

      <Text style={greeting}>Hi {WAITLIST_FIRST_NAME},</Text>

      <Text style={body}>
        We are five days out. This email is a recap. If you missed any of the last nine, this one is
        the version with everything in it.
      </Text>

      <HeroImage
        alt="Memry full dashboard hero shot"
        caption="The full Memry surface. Launching next Monday."
      />

      <Heading as="h2" style={sectionHeading}>
        What ships on launch day
      </Heading>
      <ul style={list}>
        <li>Encrypted notes with a block editor</li>
        <li>Inbox for fast capture</li>
        <li>Tasks tied to notes and projects</li>
        <li>Daily journal with one entry per day</li>
        <li>Cross-device sync built on CRDTs</li>
        <li>Projects and a calendar that match</li>
        <li>AI agent with your own model</li>
        <li>Graph view of every note and link</li>
        <li>Offline-first architecture</li>
      </ul>

      <InlineImage alt="Feature grid showing all surfaces of the app" />

      <Text style={body}>
        On launch day we will send one more email. It will have download links for macOS, Windows,
        and Linux. No invite codes. No queue.
      </Text>

      <Text style={body}>
        Thank you for waiting. Four hundred people have been on this list since we started writing.
        Some of you have been there for months. We tried to make something that earns the wait.
      </Text>

      <Signoff launchLine={`Launching ${LAUNCH_DATE}. Five days from today.`} />
      <Footer />
    </Layout>
  )
}

Email10LaunchWeek.PreviewProps = {}
