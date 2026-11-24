import test from 'ava';

import {sendToPane} from '../../app/sticky/runs/runners';
import type {SidecarReply} from '../../app/sticky/runs/sidecar';

const note = {id: 'note-1-q3yg', name: 'Clever Zebra', text: 'git clone git@github.com:o/r.git\n'} as any;

function fake(replies: Record<string, SidecarReply>) {
  const calls: Array<{path: string; body: any}> = [];
  const request = (_method: string, path: string, body?: any): Promise<SidecarReply> => {
    calls.push({path, body});
    return Promise.resolve(replies[path]);
  };
  return {request: request as any, calls};
}

const ok: SidecarReply = {ok: true, status: 200, data: {}, text: ''};
const shell409: SidecarReply = {
  ok: false,
  status: 409,
  data: {error: 'shell prompt: pwsh integration idle, no foreground Use pane_send for agent input…'},
  text: ''
};

test('an agent pane gets the sticky prompt', async (t) => {
  const f = fake({'/api/pane/send': ok});
  t.deepEqual(await sendToPane('p1', note, {runId: 'r1', history: [], request: f.request}), {status: 'ok'});
  t.is(f.calls.length, 1);
  t.true(f.calls[0].body.text.includes('Clever Zebra'));
});

test('a pane at a shell prompt runs the note as the command', async (t) => {
  const f = fake({'/api/pane/send': shell409, '/api/terminal/run': ok});
  t.deepEqual(await sendToPane('p1', note, {runId: 'r1', history: [], request: f.request}), {status: 'ok'});
  t.is(f.calls[1].path, '/api/terminal/run');
  t.is(f.calls[1].body.text, 'git clone git@github.com:o/r.git');
  t.is(f.calls[1].body.idempotency_key, 'sticky-note-1-q3yg-r1-shell');
});

test('a busy shell reports both refusals', async (t) => {
  const f = fake({'/api/pane/send': shell409, '/api/terminal/run': {...shell409, data: {error: 'busy'}}});
  const out = await sendToPane('p1', note, {runId: 'r1', history: [], request: f.request});
  t.is(out.status, 'failed');
  t.true(out.error!.includes('as a shell command: HTTP 409: busy'));
});

test('other failures are not retried as a command', async (t) => {
  const f = fake({'/api/pane/send': {ok: false, status: 500, data: {error: 'boom'}, text: ''}});
  const out = await sendToPane('p1', note, {runId: 'r1', history: [], request: f.request});
  t.is(out.status, 'failed');
  t.is(f.calls.length, 1);
});
