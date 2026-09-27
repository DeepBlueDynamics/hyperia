import test from 'ava';

import {
  submitInput,
  pendingEnterDecision,
  PENDING_ENTER_MAX_MS,
  type InputTransport,
  type PendingEnter
} from '../../app/guarded-input';

test('unfocused working agent receives body then isolated Enter', async (t) => {
  const writes: string[] = [];
  const transport: InputTransport = {
    alive: () => true,
    protected: () => false,
    write: (s) => {
      writes.push(s);
    },
    settle: () => {
      writes.push('settled');
      return Promise.resolve();
    }
  };
  const result = await submitInput({text: 'hello', submit: true, agent: true}, transport);
  t.is(result.state, 'submitted');
  t.deepEqual(writes, ['\x1b[200~hello\x1b[201~', 'settled', '\r']);
});

test('human focus defers without emitting bytes', async (t) => {
  const result = await submitInput(
    {text: 'hello', submit: true, agent: true},
    {
      alive: () => true,
      protected: () => true,
      write: () => t.fail('must not write'),
      settle: () => Promise.resolve()
    }
  );
  t.is(result.state, 'deferred');
});

test('focus race after body never sends Enter or replays', async (t) => {
  const writes: string[] = [];
  let focused = false;
  const result = await submitInput(
    {text: 'hello', submit: true, agent: true},
    {
      alive: () => true,
      protected: () => focused,
      write: (s) => {
        writes.push(s);
      },
      settle: () => {
        focused = true;
        return Promise.resolve();
      }
    }
  );
  t.is(result.state, 'indeterminate');
  t.deepEqual(writes, ['\x1b[200~hello\x1b[201~']);
});

test('submit false preserves exact shell text without Enter', async (t) => {
  const writes: string[] = [];
  const result = await submitInput(
    {text: 'echo hello', submit: false, agent: false},
    {
      alive: () => true,
      protected: () => false,
      write: (s) => {
        writes.push(s);
      },
      settle: () => {
        t.fail('shell staging must not settle');
        return Promise.resolve();
      }
    }
  );
  t.is(result.state, 'submitted');
  t.deepEqual(writes, ['echo hello']);
});

test('gone target writes nothing and transport failure is indeterminate', async (t) => {
  const gone = await submitInput(
    {text: 'hello', submit: true, agent: true},
    {
      alive: () => false,
      protected: () => false,
      write: () => t.fail('must not write'),
      settle: () => Promise.resolve()
    }
  );
  t.is(gone.state, 'failed');
  const failed = await submitInput(
    {text: 'hello', submit: true, agent: true},
    {
      alive: () => true,
      protected: () => false,
      write: () => {
        throw new Error('transport closed');
      },
      settle: () => Promise.resolve()
    }
  );
  t.is(failed.state, 'indeterminate');
});

test('withheld Enter reports the write time and keeps the result indeterminate', async (t) => {
  let focused = false;
  const armed: number[] = [];
  const before = Date.now();
  const result = await submitInput(
    {text: 'mail notice', submit: true, agent: true},
    {
      alive: () => true,
      protected: () => focused,
      write: () => {},
      settle: () => {
        focused = true;
        return Promise.resolve();
      },
      enterWithheld: (writtenAt) => armed.push(writtenAt)
    }
  );
  t.is(result.state, 'indeterminate');
  t.is(armed.length, 1);
  t.true(armed[0] >= before && armed[0] <= Date.now());
});

test('gone pane after the write arms no pending Enter', async (t) => {
  let alive = true;
  const result = await submitInput(
    {text: 'hello', submit: true, agent: true},
    {
      alive: () => alive,
      protected: () => false,
      write: () => {},
      settle: () => {
        alive = false;
        return Promise.resolve();
      },
      enterWithheld: () => t.fail('must not arm for a dead incarnation')
    }
  );
  t.is(result.state, 'indeterminate');
});

const pending: PendingEnter = {uid: 'pane-1', pid: 42, writtenAt: 10_000};
const idle = {now: 10_500, sameIncarnation: true, protected: false};

test('pending Enter sends once the pane is free and untouched', (t) => {
  t.deepEqual(pendingEnterDecision(pending, idle), {action: 'send'});
  // Activity from before the write does not block it.
  t.deepEqual(pendingEnterDecision(pending, {...idle, lastUserActivityAt: 9_000}), {action: 'send'});
});

test('pending Enter waits while the human is focused on the pane', (t) => {
  t.deepEqual(pendingEnterDecision(pending, {...idle, protected: true}), {action: 'wait'});
});

test('pending Enter never fires over the human typing since the write', (t) => {
  t.deepEqual(pendingEnterDecision(pending, {...idle, lastUserActivityAt: 10_000}), {
    action: 'abandon',
    reason: 'human-typed'
  });
  t.deepEqual(pendingEnterDecision(pending, {...idle, protected: true, lastUserActivityAt: 10_200}), {
    action: 'abandon',
    reason: 'human-typed'
  });
});

test('pending Enter gives up after the window or a new incarnation', (t) => {
  const late = {...idle, now: pending.writtenAt + PENDING_ENTER_MAX_MS + 1};
  t.deepEqual(pendingEnterDecision(pending, late), {action: 'abandon', reason: 'timeout'});
  t.deepEqual(pendingEnterDecision(pending, {...idle, now: pending.writtenAt + PENDING_ENTER_MAX_MS}), {
    action: 'send'
  });
  t.deepEqual(pendingEnterDecision(pending, {...idle, sameIncarnation: false}), {
    action: 'abandon',
    reason: 'incarnation'
  });
});
