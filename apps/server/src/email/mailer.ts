import nodemailer from 'nodemailer';

type Mail = { to: string; subject: string; text: string };

const host = Bun.env.SMTP_HOST;
const from = Bun.env.EMAIL_FROM ?? 'BunnyFile <no-reply@localhost>';

// One transport for the process. Built only when SMTP is configured.
const transport = host
  ? nodemailer.createTransport({
      host,
      port: Number(Bun.env.SMTP_PORT ?? 587),
      secure: Bun.env.SMTP_SECURE === 'true',
      auth: Bun.env.SMTP_USER ? { user: Bun.env.SMTP_USER, pass: Bun.env.SMTP_PASS } : undefined,
    })
  : null;

// Test seam: when MAIL_CAPTURE=1, mail is collected here instead of sent.
export const outbox: Mail[] = [];

export async function sendMail({ to, subject, text }: Mail): Promise<void> {
  if (Bun.env.MAIL_CAPTURE === '1') {
    outbox.push({ to, subject, text });
    return;
  }
  if (!transport) {
    // ponytail: no SMTP configured — log the message so flows that depend on
    // email (password reset) still work; an admin can relay the link.
    // Configure SMTP_HOST to send for real.
    console.log(`[email] (no SMTP configured) to=${to} subject="${subject}"\n${text}`);
    return;
  }
  await transport.sendMail({ from, to, subject, text });
}
