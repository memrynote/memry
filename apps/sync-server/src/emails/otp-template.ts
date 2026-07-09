export const buildOtpEmailHtml = (code: string, expiresMinutes: number): string => `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
</head>
<body style="margin:0;padding:0;background:#fffcf7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${code} is your MemryNote verification code</div>
<table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;background:#fffcf7">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:#ffffff;border:1px solid #f0ebe3;border-radius:14px;overflow:hidden">
<tr><td style="height:4px;background:#ff671a;font-size:0;line-height:0">&nbsp;</td></tr>
<tr><td style="padding:28px 32px 0">
  <img src="https://memrynote.com/memrynote-logo.png" alt="MemryNote" width="145" height="20" style="display:block;border:0">
</td></tr>
<tr><td style="padding:28px 32px 32px">
  <p style="margin:0 0 8px;color:#1f2937;font-size:17px;font-weight:600;letter-spacing:-0.2px">Your verification code</p>
  <p style="margin:0 0 24px;color:#6b7280;font-size:14px;line-height:1.5">Enter this code to sign in to MemryNote.</p>
  <div style="background:#fffcf7;border:1px solid #f0ebe3;border-radius:10px;padding:22px;text-align:center;margin:0 0 24px">
    <span style="font-family:'SF Mono',SFMono-Regular,Menlo,Consolas,monospace;font-size:34px;font-weight:700;letter-spacing:8px;color:#1f2937">${code}</span>
  </div>
  <p style="margin:0 0 24px;color:#6b7280;font-size:13px;line-height:1.5">This code expires in ${expiresMinutes} minutes.</p>
  <hr style="border:none;border-top:1px solid #f0ebe3;margin:0 0 16px">
  <p style="margin:0;color:#9ca3af;font-size:12px;line-height:1.6">If you didn't request this code, you can safely ignore this email. Never share this code with anyone &mdash; MemryNote will never ask for it.</p>
</td></tr>
</table>
<p style="margin:20px 0 0;color:#9ca3af;font-size:12px">MemryNote &middot; Private, encrypted notes</p>
</td></tr>
</table>
</body>
</html>`
