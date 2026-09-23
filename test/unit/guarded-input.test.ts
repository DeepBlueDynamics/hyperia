import test from 'ava';

import {submitInput, type InputTransport} from '../../app/guarded-input';

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
