// Outgoing email over SMTP, in the recipient's language. Any provider with SMTP works (SMTP_URL, MAIL_FROM);
// development sends to the local Mailpit inbox.
import { createTransport } from 'nodemailer';
import type { Config } from './config.js';

export type Locale = 'en' | 'zh';
export interface Mail { subject: string; text: string; html: string }
export interface Mailer { send(to: string, mail: Mail): Promise<void> }

export function createMailer(config: Config): Mailer {
  const transport = createTransport(config.smtpUrl);
  return { send: async (to, mail) => { await transport.sendMail({ from: config.mailFrom, to, ...mail }); } };
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// One layout for every message: the name, a heading, what to do, the code, and a closing note.
function layout(locale: Locale, heading: string, lead: string, code: string, note: string): Pick<Mail, 'text' | 'html'> {
  const foot = locale === 'zh' ? '这封邮件由 Folio 自动发送。' : 'Folio sent this email automatically.';
  const text = [heading, '', lead, '', code, '', note, '', foot].join('\n');
  const p = (s: string, color = '#13212F') => `<p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:${color}">${esc(s)}</p>`;
  const middle = `<p style="margin:4px 0 18px;font-family:Menlo,Consolas,monospace;font-size:30px;letter-spacing:8px;color:#13212F">${esc(code)}</p>`;
  const html = `<!doctype html><html lang="${locale}"><body style="margin:0;padding:24px;background:#F1F3EF;font-family:-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif">
<div style="max-width:520px;margin:0 auto;padding:28px;background:#FBFCFA;border:1px solid #D5DCD6;border-radius:10px">
<p style="margin:0 0 18px;font-family:Georgia,serif;font-weight:700;font-size:22px;color:#B23468">Folio</p>
<h1 style="margin:0 0 14px;font-family:Georgia,'Songti SC',serif;font-size:24px;line-height:1.2;color:#13212F">${esc(heading)}</h1>
${p(lead)}${middle}${p(note, '#56636F')}
<p style="margin:18px 0 0;padding-top:12px;border-top:1px solid #D5DCD6;font-size:12px;color:#56636F">${esc(foot)}</p>
</div></body></html>`;
  return { text, html };
}

export function codeMail(locale: Locale, purpose: 'verify' | 'reset', code: string): Mail {
  if (locale === 'zh'){
    return purpose === 'verify'
      ? { subject: `Folio 验证码：${code}`, ...layout(locale, '确认你的邮箱', '在 Folio 页面上输入下面的验证码，完成邮箱验证。验证码 15 分钟内有效。', code, '如果你没有注册 Folio，忽略这封邮件即可。') }
      : { subject: `Folio 重设密码验证码：${code}`, ...layout(locale, '重设密码', '在 Folio 页面上输入下面的验证码，然后设置新密码。验证码 15 分钟内有效。', code, '如果不是你本人操作，忽略这封邮件即可，密码不会改变。') };
  }
  return purpose === 'verify'
    ? { subject: `${code} is your Folio code`, ...layout(locale, 'Confirm your email', 'Enter this code on the Folio page to confirm your email address. It expires in 15 minutes.', code, 'If you didn’t sign up for Folio, ignore this email.') }
    : { subject: `${code} is your Folio password reset code`, ...layout(locale, 'Reset your password', 'Enter this code on the Folio page, then choose a new password. It expires in 15 minutes.', code, 'If you didn’t ask for this, ignore this email; your password stays the same.') };
}
