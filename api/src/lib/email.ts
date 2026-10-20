import { createHash, createHmac } from 'node:crypto';

/**
 * Transactional email through Azure Communication Services.
 *
 * Calls the REST API directly with HMAC request signing, so the API bundle
 * gains no dependency. Configuration comes from ACS_CONNECTION_STRING and
 * EMAIL_SENDER (both sourced from Key Vault by infra/set-settings.cjs). When
 * either is missing, sending is skipped and callers fall back to share links.
 *
 * Owner rule: mail may only go out from an address on the verified mahoul.io
 * custom domain (for example noreply@mahoul.io). Any other configured sender,
 * such as the ACS-managed DoNotReply address, is treated as not configured, so
 * nothing is sent and the app shows the share link instead.
 */

const REQUIRED_SENDER_DOMAIN = 'mahoul.io';

interface AcsConfig {
  endpoint: string;
  accessKey: string;
  sender: string;
}

function config(): AcsConfig | null {
  const conn = process.env.ACS_CONNECTION_STRING;
  const sender = process.env.EMAIL_SENDER;
  if (!conn || !sender) return null;
  const address = sender.trim().toLowerCase();
  if (address.split('@')[1] !== REQUIRED_SENDER_DOMAIN) return null;

  const parts: Record<string, string> = {};
  for (const piece of conn.split(';')) {
    const i = piece.indexOf('=');
    if (i > 0) parts[piece.slice(0, i).trim().toLowerCase()] = piece.slice(i + 1).trim();
  }
  if (!parts.endpoint || !parts.accesskey) return null;
  return { endpoint: parts.endpoint.replace(/\/+$/, ''), accessKey: parts.accesskey, sender };
}

export function emailConfigured(): boolean {
  return config() !== null;
}

export interface EmailMessage {
  to: string;
  toName?: string;
  subject: string;
  text: string;
  html: string;
  /** Where replies go, e.g. support@mahoul.io (the sender itself never takes mail). */
  replyTo?: string;
}

export type SendResult = { sent: true } | { sent: false; reason: string };

export async function sendEmail(msg: EmailMessage): Promise<SendResult> {
  const cfg = config();
  if (!cfg) return { sent: false, reason: 'not-configured' };

  const url = new URL(`${cfg.endpoint}/emails:send?api-version=2023-03-31`);
  const body = JSON.stringify({
    senderAddress: cfg.sender,
    content: { subject: msg.subject, plainText: msg.text, html: msg.html },
    recipients: { to: [{ address: msg.to, displayName: msg.toName || msg.to }] },
    ...(msg.replyTo ? { replyTo: [{ address: msg.replyTo }] } : {}),
  });

  const date = new Date().toUTCString();
  const contentHash = createHash('sha256').update(body, 'utf8').digest('base64');
  const stringToSign = `POST\n${url.pathname}${url.search}\n${date};${url.host};${contentHash}`;
  const signature = createHmac('sha256', Buffer.from(cfg.accessKey, 'base64'))
    .update(stringToSign, 'utf8')
    .digest('base64');

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ms-date': date,
        'x-ms-content-sha256': contentHash,
        Authorization: `HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=${signature}`,
      },
      body,
    });
    if (res.ok) return { sent: true };
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    return { sent: false, reason: `ACS ${res.status} ${detail}` };
  } catch (err) {
    return { sent: false, reason: err instanceof Error ? err.message : 'send failed' };
  }
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
