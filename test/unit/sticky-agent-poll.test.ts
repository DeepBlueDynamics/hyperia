import test from 'ava';

import {pollAgentRun} from '../../app/sticky/runs/runners';
import type {SidecarReply} from '../../app/sticky/runs/sidecar';

// Scripted n8 trigger states, one per GET; DELETEs are recorded.
function fakeN8(states: Array<Record<string, unknown>>) {
  const calls: string[] = [];
  let i = 0;
  const request = (method: string, path: string): Promise<SidecarReply> => {
    calls.push(`${method} ${path}`);
    if (method === 'DELETE') return Promise.resolve({ok: true, status: 200, data: {}, text: ''});
    const data = states[Math.min(i++, states.length - 1)];
    return Promise.resolve({ok: true, status: 200, data, text: ''});
  };
  return {request: request as any, calls};
}

const ctx = (request: any) => ({request, sleep: async () => {}, now: () => 0});

test('a run n8 reports as running is waited on, not failed', async (t) => {
  const n8 = fakeN8([
    {last_fired: null, last_status: null},
    {last_fired: 1, last_status: 'running'},
    {last_fired: 1, last_status: 'running'},
    {last_fired: 1, last_status: 'ok'}
  ]);
  t.deepEqual(await pollAgentRun('t1', 0, ctx(n8.request)), {status: 'ok'});
  t.is(n8.calls.filter((c) => c.startsWith('GET')).length, 4);
  t.is(n8.calls[n8.calls.length - 1], 'DELETE /api/n8/run/t1', 'trigger deleted only after it finished');
});

test('an n8 error after running is a failure with its message', async (t) => {
  const n8 = fakeN8([
    {last_fired: 1, last_status: 'running'},
    {last_fired: 1, last_status: 'error', last_error: 'container exited 1'}
  ]);
  t.deepEqual(await pollAgentRun('t2', 0, ctx(n8.request)), {status: 'failed', error: 'container exited 1'});
});
