// Service-outage / maintenance notices that a company's IT admins send to their own people.
// Pure helpers only (validation, templates, Windows toast script). Delivery lives in functions/notifications.js.
import { safeUrl, safeColor } from './email-templates.js';

export const SEVERITIES = { info: { label: 'Information', color: '#3B4FD8' }, warning: { label: 'Warning', color: '#B45309' }, critical: { label: 'Critical outage', color: '#B91C1C' }, resolved: { label: 'Resolved', color: '#15803D' } };

export const NOTICE_TEMPLATES = {
  outage:      { label: 'Service outage',      severity: 'critical', title: 'Service outage: {{service}}',        message: '{{service}} is currently unavailable. We are working to restore it.\n\nYou do not need to do anything. We will send another update when it is back.' },
  degraded:    { label: 'Degraded service',    severity: 'warning',  title: '{{service}} is running slowly',      message: 'You may notice slowness or errors in {{service}}. We are investigating.\n\nWorkaround: ' },
  maintenance: { label: 'Planned maintenance', severity: 'warning',  title: 'Planned maintenance: {{service}}',   message: '{{service}} will be unavailable for maintenance.\n\nWhen: \nExpected duration: \n\nPlease save your work beforehand.' },
  restored:    { label: 'Service restored',    severity: 'resolved', title: '{{service}} is working again',       message: '{{service}} has been restored. Thank you for your patience.\n\nIf you still see problems, contact the IT help desk.' },
  custom:      { label: 'Custom message',      severity: 'info',     title: '',                                  message: '' },
};

export const fill = (text, vars) => String(text || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k) => vars?.[k] ?? '');

export function cleanNotice(b = {}) {
  const severity = SEVERITIES[b.severity] ? b.severity : 'info';
  const title = String(b.title || '').trim().slice(0, 100), message = String(b.message || '').trim().slice(0, 2000);
  if (!title) return { error: 'Enter a title.' };
  if (!message) return { error: 'Enter a message.' };
  const ctaUrl = String(b.ctaUrl || '').trim();
  if (ctaUrl && !safeUrl(ctaUrl)) return { error: 'The link must be a valid https:// address.' };
  const hours = Math.min(168, Math.max(1, Number(b.expiresInHours) || 24));
  return { value: { template: NOTICE_TEMPLATES[b.template] ? b.template : 'custom', severity, title, message, ctaText: String(b.ctaText || '').trim().slice(0, 40), ctaUrl: ctaUrl ? safeUrl(ctaUrl) : '', expiresInHours: hours } };
}

export function cleanSettings(b = {}) {
  const email = String(b.supportEmail || '').trim().toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: 'The support email address is not valid.' };
  const color = b.color ? safeColor(b.color, '') : '';
  if (b.color && !color) return { error: 'The color must look like #3B4FD8.' };
  return { value: { orgName: String(b.orgName || '').trim().slice(0, 80), supportEmail: email, footer: String(b.footer || '').trim().slice(0, 400), color } };
}

const xml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const ps = s => String(s).replace(/'/g, "''").replace(/\r?\n/g, ' ');   // single-quoted PowerShell string

// A self-contained PowerShell script that shows a Windows toast for the signed-in user and stops showing after `expiresAt`.
// The admin deploys it themselves (Intune platform script, run as the logged-on user); NexpatchOnline never pushes it.
export function buildToastScript({ title, message, severity = 'info', ctaText = '', ctaUrl = '', expiresAt, orgName = '' }) {
  const url = safeUrl(ctaUrl);
  const heading = `${severity === 'critical' ? '\u26A0 ' : ''}${title}`.slice(0, 120);
  const body = String(message).replace(/\r?\n+/g, ' ').slice(0, 400);
  const toast = `<toast scenario='${severity === 'critical' ? 'urgent' : 'default'}'><visual><binding template='ToastGeneric'><text>${xml(heading)}</text><text>${xml(body)}</text>${orgName ? `<text placement='attribution'>${xml(orgName)}</text>` : ''}</binding></visual>${url ? `<actions><action content='${xml(ctaText || 'Learn more')}' activationType='protocol' arguments='${xml(url)}'/></actions>` : ''}</toast>`;
  return `# NexpatchOnline notification script (generated ${new Date().toISOString()})
# Shows one Windows toast to the signed-in user. Deploy as an Intune platform script and run it with the logged-on user's credentials.
# It does nothing after the expiry time below, so leaving it assigned is harmless.
$ErrorActionPreference = 'Stop'
$expiresUtc = [datetime]::Parse('${new Date(expiresAt).toISOString()}', $null, 'RoundtripKind')
if ([datetime]::UtcNow -gt $expiresUtc) { exit 0 }
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml('${ps(toast)}')
$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show([Windows.UI.Notifications.ToastNotification]::new($xml))
`;
}
