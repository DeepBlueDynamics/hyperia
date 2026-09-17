/* eslint-disable eslint-comments/disable-enable-pair */
import {existsSync, readFileSync, readdirSync} from 'fs';
import {join} from 'path';

import test from 'ava';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const bootstrap = require('../../app/sticky-renderer/bootstrap');

const rendererDir = join(__dirname, '../../app/sticky-renderer');
const htmlPath = join(__dirname, '../../app/sticky.html');

const REQUIRED_ASSETS = [
  'boot.js',
  'bootstrap.js',
  'chrome.js',
  'persist.js',
  'theme.js',
  'links.js',
  'syntax.js',
  'file-bind.js',
  'schedule-ui.js',
  'search-mode.js',
  'find.js',
  'code-mode.js',
  'note-mode.js',
  'chrome.css',
  'editor.css',
  'schedule.css',
  'search.css'
];

test('renderer JS and CSS files exist next to sticky.html', (t) => {
  for (const name of REQUIRED_ASSETS) {
    t.true(existsSync(join(rendererDir, name)), name);
  }
  t.true(existsSync(join(__dirname, '../../app/highlight.min.js')));
});

test('sticky.html requires bootstrap and links renderer CSS', (t) => {
  const html = readFileSync(htmlPath, 'utf8');
  t.true(html.split(/\n/).length <= 200, 'markup stays a small shell');
  t.true(html.includes('src="sticky-renderer/boot.js"'));
  t.false(html.includes("require('./sticky-renderer/bootstrap').boot()"));
  t.false(/<script>[^<]*require\(/.test(html));
  t.true(html.includes('sticky-renderer/chrome.css'));
  t.false(/<style>/.test(html));
  t.false(html.includes('function readNotes'));
  t.true(/Content-Security-Policy/.test(html));
  t.true(html.includes("default-src 'none'"));
  t.true(html.includes("script-src 'self'"));
  t.true(html.includes("style-src 'self' 'unsafe-inline'"));
  t.true(html.includes("connect-src 'none'"));
  t.true(html.includes("object-src 'none'"));
  t.true(html.includes("frame-src 'none'"));
  t.true(html.includes("base-uri 'none'"));
  t.true(html.includes("form-action 'none'"));
});

test('boot.js is the external entry that requires bootstrap', (t) => {
  const boot = readFileSync(join(rendererDir, 'boot.js'), 'utf8');
  t.true(boot.includes("require('./sticky-renderer/bootstrap').boot()"));
});

test('app tsconfig excludes sticky-renderer so webpack is the only copy path', (t) => {
  const tsconfig = JSON.parse(readFileSync(join(__dirname, '../../app/tsconfig.json'), 'utf8'));
  t.true(Array.isArray(tsconfig.exclude));
  t.true(tsconfig.exclude.includes('./sticky-renderer'));
});

test('resolveMode maps query params to search | code | note', (t) => {
  t.is(bootstrap.resolveMode(new URLSearchParams('mode=search'), ''), 'search');
  t.is(bootstrap.resolveMode(new URLSearchParams('file=/tmp/a.ts'), '/tmp/a.ts'), 'code');
  t.is(bootstrap.resolveMode(new URLSearchParams('id=note-1'), ''), 'note');
});

test('bootstrap require graph loads without DOM', (t) => {
  t.is(typeof bootstrap.boot, 'function');
  t.deepEqual(bootstrap.boot({document: null, window: null}), {ok: false, reason: 'no-dom'});
});

test('renderer modules stay under the 400-line split threshold', (t) => {
  for (const name of readdirSync(rendererDir)) {
    if (!/\.(js|css)$/.test(name)) continue;
    const n = readFileSync(join(rendererDir, name), 'utf8').split(/\n/).length;
    t.true(n <= 400, `${name} is ${n} lines`);
  }
});
