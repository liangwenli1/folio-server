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

// One layout for every message: the name, a heading, what to do, a code or a button, and a closing note.
function layout(locale: Locale, heading: string, lead: string, action: { code: string } | { label: string; url: string }, note: string): Pick<Mail, 'text' | 'html'> {
  const foot = locale === 'zh' ? '此邮件由 Folio 系统自动发送，请勿直接回复。' : 'Folio sent this email automatically.';
  const text = [heading, '', lead, '', 'code' in action ? action.code : `${action.label}: ${action.url}`, '', note, '', foot].join('\n');
  const p = (s: string, color = '#13212F') => `<p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:${color}">${esc(s)}</p>`;
  const middle = 'code' in action
    ? `<p style="margin:4px 0 18px;font-family:Menlo,Consolas,monospace;font-size:30px;letter-spacing:8px;color:#13212F">${esc(action.code)}</p>`
    : `<p style="margin:4px 0 18px"><a href="${esc(action.url)}" style="display:inline-block;padding:11px 18px;border-radius:6px;background:#B23468;color:#ffffff;text-decoration:none;font-size:15px">${esc(action.label)}</a></p>`;
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
      ? { subject: `Folio 验证码：${code}`, ...layout(locale, '验证邮箱', '请在 Folio 页面输入以下验证码完成邮箱验证，15 分钟内有效。', { code }, '如非本人注册 Folio，请忽略此邮件。') }
      : { subject: `Folio 重设密码验证码：${code}`, ...layout(locale, '重设密码', '请在 Folio 页面输入以下验证码并设置新密码，15 分钟内有效。', { code }, '如非本人操作，请忽略此邮件，密码不会变更。') };
  }
  return purpose === 'verify'
    ? { subject: `${code} is your Folio code`, ...layout(locale, 'Confirm your email', 'Enter this code on the Folio page to confirm your email address. It expires in 15 minutes.', { code }, 'If you didn’t sign up for Folio, ignore this email.') }
    : { subject: `${code} is your Folio password reset code`, ...layout(locale, 'Reset your password', 'Enter this code on the Folio page, then choose a new password. It expires in 15 minutes.', { code }, 'If you didn’t ask for this, ignore this email; your password stays the same.') };
}

export function inviteMail(locale: Locale, a: { workspace: string; inviter: string; role: 'admin' | 'member'; url: string }): Mail {
  if (locale === 'zh'){
    const role = a.role === 'admin' ? '管理员' : '成员';
    return { subject: `${a.inviter} 邀请您加入 ${a.workspace}（Folio）`, ...layout(locale, `加入 ${a.workspace}`, `${a.inviter} 邀请您以${role}身份加入 Folio 团队「${a.workspace}」。`, { label: '接受邀请', url: a.url }, '邀请 7 天内有效。如不认识邀请人，请忽略此邮件。') };
  }
  const role = a.role === 'admin' ? 'an admin' : 'a member';
  return { subject: `${a.inviter} invited you to ${a.workspace} on Folio`, ...layout(locale, `Join ${a.workspace}`, `${a.inviter} invited you to join the ${a.workspace} workspace on Folio as ${role}.`, { label: 'Accept the invitation', url: a.url }, 'The invitation expires in 7 days. If you weren’t expecting it, ignore this email.') };
}
