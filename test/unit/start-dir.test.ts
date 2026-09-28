import test from 'ava';

import {pickStartDirectory} from '../../app/utils/start-dir';

const home = '/home/me';
const exists = (dirs: string[]) => (p: string) => dirs.includes(p);

test('launch path wins over everything', (t) => {
  t.is(
    pickStartDirectory(
      {argPath: '/arg', profileDir: '/prof', lastCwd: '/last'},
      home,
      exists(['/arg', '/prof', '/last'])
    ),
    '/arg'
  );
});

test('explicit profile workingDirectory beats the remembered cwd', (t) => {
  t.is(pickStartDirectory({profileDir: '/prof', lastCwd: '/last'}, home, exists(['/prof', '/last'])), '/prof');
});

test('remembered cwd is used when nothing more specific is set', (t) => {
  t.is(pickStartDirectory({profileDir: '', lastCwd: '/last'}, home, exists(['/last'])), '/last');
});

test('missing or relative directories fall through to home', (t) => {
  t.is(pickStartDirectory({argPath: '--inspect=0', profileDir: 'rel/dir', lastCwd: '/gone'}, home, exists([])), home);
  t.is(pickStartDirectory({}, home, exists([])), home);
});
