// Renders the OTP email to /tmp/otp-preview.html for local inspection.
// Run: npx tsx scripts/preview-otp-email.ts && open /tmp/otp-preview.html
import { writeFileSync } from 'node:fs'
import { buildOtpEmailHtml } from '../src/emails/otp-template'

const out = '/tmp/otp-preview.html'
writeFileSync(out, buildOtpEmailHtml('882499', 10))
console.log(`wrote ${out}`)
