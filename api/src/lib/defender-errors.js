// Turns Defender's own error text into something a company can act on.
//  A tenant without Defender for Endpoint has no DeviceEvents table at all, so the query can never work there.
export function explainDefenderError(message) {
  const m = String(message || '');
  if (/failed to resolve (table|column)|DeviceEvents/i.test(m)) return { code: 'no-defender-tables', needsCollector: true, message: 'Microsoft Defender for Endpoint isn\u2019t set up in this organization, so Defender has no App Control event data to read. Choose \u201cNexpatchOnline agent\u201d as the event source instead. It works with any license: deploy the agent script with Intune and devices send their App Control events to NexpatchOnline.' };
  if (/\b403\b|permission|forbidden|authorization/i.test(m)) return { code: 'permission', needsCollector: false, message: 'NexpatchOnline doesn\u2019t have permission to read Defender advanced hunting. An administrator needs to approve the App Control permissions again on the Connect page (ThreatHunting.Read.All), and the tenant needs Microsoft Defender for Endpoint.' };
  return { code: 'other', needsCollector: false, message: `Microsoft Defender returned an error: ${m.slice(0, 200)}` };
}

