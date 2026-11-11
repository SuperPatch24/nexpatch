// Builds an App Control base policy XML from the choices made on the website.
// Starts from Microsoft's own templates (WDAC Toolkit, MIT licence) and sets rule options.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'policy-templates');
const xmlEsc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// Rule options to turn on; everything else present in the template is left as-is or removed below.
function ruleOptionsXml(o) {
  const on = ['Enabled:Unsigned System Integrity Policy', 'Enabled:Advanced Boot Options Menu', 'Enabled:UMCI', 'Enabled:Update Policy No Reboot', 'Enabled:Allow Supplemental Policies'];
  if (o.mode !== 'enforce') on.push('Enabled:Audit Mode');
  if (o.managedInstaller) on.push('Enabled:Managed Installer');
  if (o.isg) on.push('Enabled:Intelligent Security Graph Authorization');
  if (o.enforceScripts === false) on.push('Disabled:Script Enforcement'); // scripts are enforced unless turned off
  return '  <Rules>\n' + on.map(x => `    <Rule>\n      <Option>${x}</Option>\n    </Rule>`).join('\n') + '\n  </Rules>';
}

export async function buildBasePolicy(o) {
  const tmpl = o.base === 'DefaultWindows' ? 'DefaultWindows_Audit.xml' : 'AllowMicrosoft.xml';
  let xml = (await readFile(join(dir, tmpl), 'utf8')).replace(/^\uFEFF/, '');

  const policyId = o.policyId || `{${randomUUID().toUpperCase()}}`;
  // A base policy's PolicyID and BasePolicyID are the same value.
  xml = xml.replace(/<PolicyID>[^<]*<\/PolicyID>/, `<PolicyID>${policyId}</PolicyID>`)
           .replace(/<BasePolicyID>[^<]*<\/BasePolicyID>/, `<BasePolicyID>${policyId}</BasePolicyID>`);
  xml = xml.replace(/<VersionEx>[^<]*<\/VersionEx>/, `<VersionEx>${o.version || '10.0.0.1'}</VersionEx>`);
  // Replace the whole Rules block with our chosen options.
  xml = xml.replace(/<Rules>[\s\S]*?<\/Rules>/, ruleOptionsXml(o));
  // Friendly name
  xml = xml.replace(/(<Setting Provider="PolicyInfo" Key="Information" ValueName="Name">\s*<Value>\s*<String>)[^<]*(<\/String>)/,
    `$1${xmlEsc(o.name || 'NexpatchOnline base policy')}$2`);

  return { xml, policyId };
}
