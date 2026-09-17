import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { discover } from '../../src/discover.ts';
import { prepareInteractionReview } from '../../src/interaction-review.ts';
import { serve } from '../../src/serve.ts';
import { materialize } from './materialize.mjs';

type Candidate = Awaited<ReturnType<typeof prepareInteractionReview>>['evidence']['candidates'][number];
interface State { active: string; elements: { selector: string; visible: boolean; text: string; attributes: Record<string, string> }[] }
function trace(candidate: Candidate, action: string) {
  const value = candidate.traces.find(item => item.action === action);
  assert.ok(value, `Missing ${action} trace`);
  return { before: JSON.parse(value.before) as State, after: JSON.parse(value.after) as State };
}
function element(state: State, id: string) {
  const value = state.elements.find(item => item.selector.endsWith(`#${id}`));
  assert.ok(value, `Missing retained #${id}`);
  return value;
}

test('development controls expose seven defects and their task controls in production evidence', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'interaction-evidence-'));
  const browser = await chromium.launch();
  try {
    const root = join(temp, 'corpus');
    await materialize(root);
    const manifest = JSON.parse(await readFile(join(root, 'private-key.json'), 'utf8')) as {
      cases: { id: string; family: string }[];
    };
    const candidates = new Map<string, Candidate>();
    const surfaces: Record<string, string> = { tabs: 'tabs', 'native-choice': 'choices', disclosure: 'disclosures', 'stateful-checkbox': 'stateful', dialogs: 'dialogs' };
    for (const item of manifest.cases) {
      const input = join(root, item.id);
      const server = await serve(input);
      const context = await browser.newContext({ serviceWorkers: 'block' });
      try {
        const packet = await prepareInteractionReview(context, (await discover(input, server.origin)).pages, [], item.id);
        assert.equal(packet.auditedPages, 1, item.id);
        const candidate = packet.evidence.candidates.find(value => value.surface === surfaces[item.family]);
        assert.ok(candidate, `No ${item.family} candidate in ${item.id}`);
        assert.ok(candidate.dom.html.length, `${item.id} has no retained DOM`);
        candidates.set(item.id, candidate);
      } finally {
        await context.close();
        await server.close();
      }
    }
    assert.equal(candidates.size, 16);
    const get = (id: string) => { const value = candidates.get(id); assert.ok(value); return value; };

    assert.equal(trace(get('a01'), 'ArrowRight').after.active, 'button#tab-one');
    assert.equal(trace(get('a02'), 'ArrowRight').after.active, 'button#tab-two');
    assert.equal(element(trace(get('a02'), 'ArrowRight').after, 'panel-two').visible, true);
    const manual = trace(get('a03'), 'ArrowRight').after;
    assert.equal(manual.active, 'button#tab-two');
    assert.equal(element(manual, 'tab-two').attributes['aria-selected'], 'false');
    assert.equal(element(trace(get('a03'), 'Enter').after, 'panel-two').visible, true);
    assert.equal(get('a04').traces.length, 0);
    assert.match(get('a04').traceNote ?? '', /Native select popup and keyboard state are not observable reliably/);

    for (const [id, expanded] of [['a05', 'false'], ['a06', 'true']]) {
      const state = trace(get(id!), 'Enter');
      assert.equal(element(state.before, 'hint').visible, false);
      assert.equal(element(state.after, 'hint').visible, true);
      assert.equal(element(state.after, 'toggle').attributes['aria-expanded'], expanded);
    }
    assert.equal(element(trace(get('a07'), 'Enter').after, 'toggle').attributes['aria-expanded'], 'false');
    assert.equal(element(trace(get('a08'), 'Enter').after, 'toggle').attributes['aria-expanded'], 'true');

    for (const [id, checked] of [['a09', 'false'], ['a10', 'true']]) {
      const state = trace(get(id!), 'Space');
      assert.match(element(state.before, 'result').text, /excluded/);
      assert.match(element(state.after, 'result').text, /included/);
      assert.equal(element(state.after, 'choice').attributes['aria-checked'], checked);
    }
    assert.match(element(trace(get('a11'), 'Space').after, 'result').text, /excluded/);
    assert.equal(element(trace(get('a12'), 'Space').after, 'choice').attributes['aria-checked'], 'true');

    for (const action of ['Shift+Tab from first control', 'Tab from last control']) {
      const defect = trace(get('a13'), action).after.active;
      const clean = trace(get('a14'), action).after.active;
      assert.equal(defect, action === 'Shift+Tab from first control' ? 'button#openDialog' : 'a', `Defect should reach a background control: ${action}`);
      assert.ok(['input#reminder', 'button#closeDialog'].includes(clean), `Control should contain focus: ${action}`);
    }
    assert.equal(element(trace(get('a15'), 'Escape').after, 'editor').visible, true);
    assert.equal(element(trace(get('a16'), 'Escape').after, 'editor').visible, false);
  } finally {
    await browser.close();
    await rm(temp, { recursive: true, force: true });
  }
});
