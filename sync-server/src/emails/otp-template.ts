export const buildOtpEmailHtml = (code: string, expiresMinutes: number): string => `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:#ffffff;border-radius:12px;overflow:hidden">
<tr><td style="background:#18181b;padding:24px 32px">
  <span style="color:#ffffff;font-size:20px;font-weight:600;letter-spacing:-0.3px">memry</span>
</td></tr>
<tr><td style="padding:32px">
  <p style="margin:0 0 8px;color:#18181b;font-size:16px;font-weight:600">Your verification code</p>
  <p style="margin:0 0 24px;color:#71717a;font-size:14px;line-height:1.5">Enter this code to sign in to Memry.</p>
  <div style="background:#f4f4f5;border-radius:8px;padding:20px;text-align:center;margin:0 0 24px">
    <span style="font-family:'SF Mono',SFMono-Regular,Menlo,Consolas,monospace;font-size:32px;font-weight:700;letter-spacing:6px;color:#18181b">${code}</span>
  </div>
  <p style="margin:0 0 24px;color:#71717a;font-size:13px;line-height:1.5">This code expires in ${expiresMinutes} minutes.</p>
  <hr style="border:none;border-top:1px solid #e4e4e7;margin:0 0 16px">
  <p style="margin:0;color:#a1a1aa;font-size:12px;line-height:1.5">If you didn't request this code, you can safely ignore this email. Never share this code with anyone.</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`
