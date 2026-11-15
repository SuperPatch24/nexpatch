// Static regression checks for the App Control / general Reports separation in public/index.html.
// These do not run a browser; they guard against the two defects found in review:
//  1) general renderReports() writing to App Control DOM/data, 2) renderReports() throwing on a missing element.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const html = readFileSync(fileURLToPath(new URL('../../public/index.html', import.meta.url)), 'utf8');
const fnBody = (name) => {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} not found`);
  const next = html.indexOf('\nfunction ', start + 10);
  return html.slice(start, next < 0 ? undefined : next);
};
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
const selectors = (body) => [...body.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)].map(m => m[1]);

test('general renderReports() does not touch App Control data or DOM', () => {
  const body = fnBody('renderReports');
  for (const forbidden of ['repAppControl', 'repACStats', 'acRepStats', 'acRepTop', 'REP.appcontrol', 'REP.acTop', 'S.events', 'acEventsForReports'])
    assert.ok(!body.includes(forbidden), `renderReports must not reference ${forbidden}`);
});

test('App Control Reports owns the repAppControl table and its export dataset', () => {
  assert.ok(fnBody('renderACReports').includes('#repAppControl'));
  assert.equal((html.match(/REP\.appcontrol\s*=/g) || []).length, 1, 'exactly one writer of REP.appcontrol');
  assert.equal((html.match(/\$\('#repAppControl'\)\.innerHTML\s*=/g) || []).length, 1, 'exactly one writer of #repAppControl');
  assert.ok(html.indexOf('data-rep="appcontrol"') > html.indexOf('id="acReportsPanel"'), 'App Control export button lives in the App Control panel');
});

test('every element selected by the two report renderers exists in the page (no null.innerHTML)', () => {
  for (const fn of ['renderReports', 'renderACReports'])
    for (const id of selectors(fnBody(fn))) assert.ok(ids.has(id), `${fn} selects #${id} which is not in index.html`);
});

test('App Control reports show an error state when events cannot be loaded', () => {
  assert.ok(/async function loadACEvents[\s\S]{0,400}acRepSub/.test(html));
});
