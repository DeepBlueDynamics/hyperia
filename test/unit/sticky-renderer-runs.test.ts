/* eslint-disable eslint-comments/disable-enable-pair */
/* eslint-disable @typescript-eslint/no-var-requires */
import test from 'ava';

const links = require('../../app/sticky-renderer/links');
const {renderMarkdown, escapeHtml} = require('../../app/sticky-renderer/markdown');
const fmt = require('../../app/sticky-renderer/run-format');

// Local-time anchors so relative/absolute formatting is TZ-independent.
const NOW = new Date(2026, 8, 26, 10, 0, 0).getTime(); // Sat Sep 26 2026 10:00 local
const at = (d: number, h: number, m = 0) => new Date(2026, 8, d, h, m, 0).getTime();

// ---------- Markdown ----------

test('markdown: headings, emphasis, code, paragraphs keep line breaks', (t) => {
  t.is(renderMarkdown('# Title'), '<h1>Title</h1>');
  t.is(renderMarkdown('### Sub ###'), '<h3>Sub</h3>');
  t.is(
    renderMarkdown('**bold** and *it* and _it2_ and `x<y`'),
    '<p><strong>bold</strong> and <em>it</em> and <em>it2</em> and <code>x&lt;y</code></p>'
  );
  t.is(renderMarkdown('Tokyo: 22°C\nTomorrow 24°C'), '<p>Tokyo: 22°C<br>Tomorrow 24°C</p>');
  t.is(renderMarkdown('a\n\nb'), '<p>a</p><p>b</p>');
  t.is(renderMarkdown('snake_case_name stays'), '<p>snake_case_name stays</p>');
  t.is(renderMarkdown('2 * 3 * 4'), '<p>2 * 3 * 4</p>');
});

test('markdown: fenced code is escaped verbatim', (t) => {
  t.is(renderMarkdown('```js\nif (a < b) { **x** }\n```'), '<pre><code>if (a &lt; b) { **x** }</code></pre>');
});

test('markdown: lists (ul, ol with start, nested, tasks)', (t) => {
  t.is(renderMarkdown('- a\n- b'), '<ul><li>a</li><li>b</li></ul>');
  t.is(renderMarkdown('3. c\n4. d'), '<ol start="3"><li>c</li><li>d</li></ol>');
  t.is(renderMarkdown('- a\n  - a1\n- b'), '<ul><li>a<ul><li>a1</li></ul></li><li>b</li></ul>');
  t.is(
    renderMarkdown('- [x] done\n- [ ] todo'),
    '<ul><li><span class="md-task">☑</span> done</li><li><span class="md-task">☐</span> todo</li></ul>'
  );
});

test('markdown: tables with alignment', (t) => {
  const html = renderMarkdown('| City | Temp |\n|:--|--:|\n| Tokyo | 22 |\n| Oslo | 9 |');
  t.is(
    html,
    '<table><thead><tr><th style="text-align:left">City</th><th style="text-align:right">Temp</th></tr></thead>' +
      '<tbody><tr><td style="text-align:left">Tokyo</td><td style="text-align:right">22</td></tr>' +
      '<tr><td style="text-align:left">Oslo</td><td style="text-align:right">9</td></tr></tbody></table>'
  );
});

test('markdown: blockquote and hr', (t) => {
  t.is(renderMarkdown('> quoted **x**'), '<blockquote><p>quoted <strong>x</strong></p></blockquote>');
  t.is(renderMarkdown('---'), '<hr>');
});

test('markdown: links become href-less anchors with data targets', (t) => {
  t.is(
    renderMarkdown('[docs](https://example.com/a?b=1&c=2)'),
    '<p><a class="md-link" data-kind="url" data-target="https://example.com/a?b=1&amp;c=2" title="https://example.com/a?b=1&amp;c=2">docs</a></p>'
  );
  const bare = renderMarkdown('see https://example.com/x.');
  t.true(bare.includes('data-target="https://example.com/x"'));
  t.true(bare.endsWith('</a>.</p>'), 'trailing period stays outside the link');
  t.true(renderMarkdown('open [[Weather Tokyo]]').includes('data-kind="note" data-target="Weather Tokyo"'));
  t.true(renderMarkdown('open sticky:note-123').includes('data-kind="note" data-target="note-123"'));
  t.true(renderMarkdown('[other](sticky:abc)').includes('data-kind="note" data-target="abc"'));
  t.false(/href=/.test(renderMarkdown('[x](https://a.b) https://c.d')));
});

test('markdown XSS: raw HTML, attributes and scripts are escaped', (t) => {
  const evil = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '# <iframe src="javascript:alert(1)">',
    '| <b>h</b> |\n|---|\n| <svg onload=alert(1)> |',
    '- <a href="javascript:alert(1)">x</a>',
    '> <style>body{}</style>',
    '**<i onclick=x>**'
  ];
  for (const src of evil) {
    const html = renderMarkdown(src);
    t.false(/<(script|img|iframe|svg|style|b|i)\b/i.test(html), `no raw tag: ${html}`);
    t.false(/<a\b(?![^>]*class="md-link")/.test(html), `no foreign anchor: ${html}`);
  }
});

test('markdown XSS: dangerous link schemes are not linked', (t) => {
  for (const href of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'file:///etc/passwd', 'vbscript:x']) {
    const html = renderMarkdown(`[click](${href})`);
    t.false(html.includes('md-link'), href);
    t.false(html.includes('<b>'), href);
  }
});

test('markdown XSS: quotes in link targets cannot break out of attributes', (t) => {
  const html = renderMarkdown('https://a.b/x"onmouseover="alert(1)');
  t.false(/"\s*onmouseover=/.test(html));
  const wiki = renderMarkdown('[[a" onclick="x]]');
  t.true(wiki.includes('data-target="a&quot; onclick=&quot;x"'));
});

test('markdown: NUL placeholders in input cannot forge slots', (t) => {
  const html = renderMarkdown('`<b>` \u00000\u0000 x');
  t.false(html.includes('<b>'));
  t.is(escapeHtml(`<"'&>`), '&lt;&quot;&#39;&amp;&gt;');
});

test('markdown: empty and nullish input', (t) => {
  t.is(renderMarkdown(''), '');
  t.is(renderMarkdown(null), '');
  t.is(renderMarkdown(undefined), '');
});

// ---------- Links ----------

test('links: URL, [[name]], sticky:id, app://sticky and [From:] tokens', (t) => {
  const text = 'a https://x.io/p, b [[My Note]] c sticky:n-42 d app://sticky/n-7 e [From: Bob]';
  const toks = links.findLinks(text).map((x: {kind: string; value: string}) => [x.kind, x.value]);
  t.deepEqual(toks, [
    ['url', 'https://x.io/p'],
    ['note', 'My Note'],
    ['note', 'n-42'],
    ['note', 'n-7'],
    ['note', 'Bob']
  ]);
});

test('links: linkTokenAt hits inside a token and misses outside', (t) => {
  const text = 'go to [[Weather Tokyo]] now';
  t.deepEqual(links.linkTokenAt(text, 10), {kind: 'note', value: 'Weather Tokyo'});
  t.is(links.linkTokenAt(text, 1), null);
  t.deepEqual(links.linkTokenAt('see https://a.b/c.', 8), {kind: 'url', value: 'https://a.b/c'});
});

test('links: sticky: needs an id and a word boundary', (t) => {
  t.deepEqual(links.findLinks('the sticky: thing'), []);
  t.deepEqual(links.findLinks('nosticky:abc'), []);
  t.deepEqual(
    links.findLinks('(sticky:abc).').map((x: {value: string}) => x.value),
    ['abc']
  );
});

test('links: classifyHref accepts http(s)/sticky only', (t) => {
  t.deepEqual(links.classifyHref('https://a.b'), {kind: 'url', value: 'https://a.b'});
  t.deepEqual(links.classifyHref('sticky:Weather%20Tokyo'), {kind: 'note', value: 'Weather Tokyo'});
  t.deepEqual(links.classifyHref('app://sticky/n-1'), {kind: 'note', value: 'n-1'});
  t.is(links.classifyHref('javascript:alert(1)'), null);
  t.is(links.classifyHref('file:///c/x'), null);
});

test('links: openLink routes urls and notes to the existing IPC', (t) => {
  const sent: unknown[][] = [];
  const ipc = {send: (...a: unknown[]) => sent.push(a)};
  t.true(links.openLink(ipc, {kind: 'url', value: 'https://a.b'}));
  t.true(links.openLink(ipc, {kind: 'note', value: 'n-1'}));
  t.false(links.openLink(ipc, {kind: 'url', value: 'javascript:x'}));
  t.false(links.openLink(ipc, null));
  t.deepEqual(sent, [
    ['sticky-open-external', 'https://a.b'],
    ['sticky-open-note', 'n-1']
  ]);
  const ta = {value: 'x [[Other]] y', selectionStart: 4};
  t.true(links.followLinkInTextarea(ta, ipc));
  t.deepEqual(sent[2], ['sticky-open-note', 'Other']);
});

// ---------- Footer formatting ----------

test('format: relative and absolute times', (t) => {
  t.is(fmt.formatRelative(NOW + 5 * 60000, NOW), 'in 5m');
  t.is(fmt.formatRelative(NOW + 130 * 60000, NOW), 'in 2h 10m');
  t.is(fmt.formatRelative(NOW - 3 * 3600000, NOW), '3h ago');
  t.is(fmt.formatRelative(NOW + 10000, NOW), 'now');
  t.is(fmt.formatRelative(NOW + 4 * 86400000, NOW), 'in 4d');
  t.is(fmt.formatAbsolute(at(26, 8), NOW), '08:00 today');
  t.is(fmt.formatAbsolute(at(27, 8), NOW), '08:00 tomorrow');
  t.is(fmt.formatAbsolute(at(25, 23, 5), NOW), '23:05 yesterday');
  t.is(fmt.formatAbsolute(at(29, 9), NOW), 'Tue 09:00');
  t.is(fmt.formatAbsolute(new Date(2026, 9, 20, 7, 30).getTime(), NOW), 'Oct 20 07:30');
});

test('format: footer for an ok daily agent run', (t) => {
  const run = {
    when: 'every',
    every: {kind: 'daily', time: '08:00'},
    target: 'agent',
    agent: {provider: 'claude', image: 'default', dir: '/w', danger: false}
  };
  const f = fmt.formatFooter(run, {last_status: 'ok', last_run: at(26, 8), next_run: at(27, 8)}, NOW);
  t.true(f.visible);
  t.is(f.last, '✓ ran 08:00 today');
  t.is(f.next, 'next in 22h (08:00 tomorrow)');
  t.is(f.target, 'claude');
  t.is(f.error, '');
});

test('format: footer statuses, errors, pane target, paused, no run', (t) => {
  const pane = {
    when: 'every',
    every: {kind: 'interval', minutes: 120},
    target: 'pane',
    pane: {uid: 'u1', name: 'Naval Tern'}
  };
  const failed = fmt.formatFooter(
    pane,
    {last_status: 'halted', last_run: at(26, 9), last_error: 'Pane Naval Tern closed; schedule paused.'},
    NOW
  );
  t.is(failed.last, '⏸ halted 09:00 today');
  t.is(failed.error, 'Pane Naval Tern closed; schedule paused.');
  t.is(failed.target, '→ pane Naval Tern');
  t.is(failed.next, 'every 2h');
  t.is(fmt.formatFooter(pane, {last_status: 'running'}, NOW).last, '⟳ running');
  t.is(fmt.formatFooter(pane, {last_status: 'awaiting_approval'}, NOW).last, '⌛ awaiting approval');
  t.is(fmt.formatFooter(pane, {last_status: 'skipped', last_run: at(26, 9)}, NOW).last, '⏭ skipped 09:00 today');
  t.is(fmt.formatFooter(pane, {last_status: 'failed', last_run: at(26, 9)}, NOW).last, '✗ failed 09:00 today');
  t.is(fmt.formatFooter({...pane, paused: true}, {next_run: at(26, 12)}, NOW).next, 'paused');
  t.is(fmt.formatFooter({when: 'now', target: 'notify'}, {}, NOW).last, 'not run yet');
  t.false(fmt.formatFooter(null, {}, NOW).visible);
  t.true(fmt.formatFooter(null, {last_status: 'ok', last_run: at(26, 8)}, NOW).visible);
});

test('format: armed rule, tooltip, labels', (t) => {
  const run = {when: 'every', every: {kind: 'weekly', days: [5, 1], time: '09:30'}, target: 'notify'};
  t.true(fmt.isArmed(run));
  t.false(fmt.isArmed({...run, paused: true}));
  t.false(fmt.isArmed(null));
  t.is(fmt.whenLabel(run, NOW), 'Mon, Fri 09:30');
  t.is(fmt.everyLabel({kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], time: '07:00'}), 'every day 07:00');
  t.is(fmt.everyLabel({kind: 'cron', expr: '0 9 * * 1-5'}), 'cron 0 9 * * 1-5');
  t.is(fmt.tooltip(run, {next_run: at(28, 9, 30)}, NOW), 'Mon, Fri 09:30 · notify\nNext run: in 2d (Mon 09:30)');
  t.is(fmt.formatRelative(at(27, 21), NOW), 'in 1d 11h');
  t.true(fmt.tooltip(null, {}, NOW).startsWith('Run this sticky'));
});

test('format: statusMessage for set replies', (t) => {
  t.is(fmt.statusMessage({ok: true, status: 'awaiting_approval'}, NOW), 'Waiting for your approval in Hyperia');
  t.is(fmt.statusMessage({ok: true, status: 'running'}, NOW), '⟳ Running now');
  t.is(
    fmt.statusMessage({ok: true, status: 'scheduled', next_run: NOW + 3600000}, NOW),
    'Scheduled (scheduled) · next in 1h'
  );
  t.is(fmt.statusMessage({ok: true, status: 'ok', next_run: NOW + 3600000}, NOW), 'Scheduled · next in 1h');
  t.is(fmt.statusMessage({ok: false, error: 'x'}, NOW), '');
});

// ---------- Panel fields <-> run ----------

test('run build: defaults are Now + Notify', (t) => {
  const f = fmt.defaultFields(NOW, '/home/u');
  t.is(f.when, 'now');
  t.is(f.target, 'notify');
  t.deepEqual(fmt.buildRun(f), {ok: true, run: {when: 'now', target: 'notify'}});
});

test('run build: at, interval, daily, weekly, cron', (t) => {
  const base = fmt.defaultFields(NOW, '/h');
  const atRun = fmt.buildRun({...base, when: 'at', at: '2026-09-27T08:00'});
  t.true(atRun.ok);
  t.is(Date.parse(atRun.run.at), at(27, 8));
  t.deepEqual(
    fmt.buildRun({...base, when: 'every', everyKind: 'interval', intervalN: '2', intervalUnit: 'h'}).run.every,
    {kind: 'interval', minutes: 120}
  );
  t.deepEqual(fmt.buildRun({...base, when: 'every', everyKind: 'daily', dailyTime: '08:00'}).run.every, {
    kind: 'daily',
    time: '08:00'
  });
  t.deepEqual(
    fmt.buildRun({...base, when: 'every', everyKind: 'weekly', weeklyDays: [5, 1, 1], weeklyTime: '09:15'}).run.every,
    {kind: 'weekly', days: [1, 5], time: '09:15'}
  );
  t.deepEqual(fmt.buildRun({...base, when: 'every', everyKind: 'cron', cron: ' 0  9 * * 1-5 '}).run.every, {
    kind: 'cron',
    expr: '0 9 * * 1-5'
  });
});

test('run build: validation errors', (t) => {
  const base = fmt.defaultFields(NOW, '/h');
  t.false(fmt.buildRun({...base, when: 'at', at: ''}).ok);
  t.false(fmt.buildRun({...base, when: 'every', everyKind: 'interval', intervalN: '0'}).ok);
  t.false(fmt.buildRun({...base, when: 'every', everyKind: 'interval', intervalN: '1.5'}).ok);
  t.false(fmt.buildRun({...base, when: 'every', everyKind: 'daily', dailyTime: '25:00'}).ok);
  t.false(fmt.buildRun({...base, when: 'every', everyKind: 'weekly', weeklyDays: []}).ok);
  t.false(fmt.buildRun({...base, when: 'every', everyKind: 'cron', cron: '* * *'}).ok);
  t.false(fmt.buildRun({...base, target: 'agent', provider: ''}).ok);
  t.false(fmt.buildRun({...base, target: 'agent', provider: 'claude', dir: ' '}).ok);
  t.false(fmt.buildRun({...base, target: 'pane', paneUid: ''}).ok);
  t.regex(fmt.buildRun({...base, when: 'every', everyKind: 'cron', cron: 'x'}).error, /5 fields/);
});

test('run build: agent, pane and history targets', (t) => {
  const base = fmt.defaultFields(NOW, '/h');
  t.deepEqual(fmt.buildRun({...base, target: 'agent', provider: 'codex', dir: '/w', danger: true}).run, {
    when: 'now',
    target: 'agent',
    agent: {provider: 'codex', image: 'default', dir: '/w', danger: true}
  });
  t.deepEqual(fmt.buildRun({...base, target: 'pane', paneUid: 'u9', paneName: 'Naval Tern'}).run.pane, {
    uid: 'u9',
    name: 'Naval Tern'
  });
  t.deepEqual(fmt.buildRun({...base, historyKeep: true, historyLimit: '7'}).run.history, {keep: true, limit: 7});
  t.deepEqual(fmt.buildRun({...base, historyKeep: true, historyLimit: 'x'}).run.history, {keep: true, limit: 50});
});

test('run prefill: round-trips every shape through buildRun', (t) => {
  const runs = [
    {when: 'now', target: 'notify'},
    {when: 'at', at: new Date(at(27, 8)).toISOString(), target: 'notify'},
    {when: 'every', every: {kind: 'interval', minutes: 15}, target: 'notify'},
    {when: 'every', every: {kind: 'interval', minutes: 180}, target: 'notify'},
    {
      when: 'every',
      every: {kind: 'daily', time: '08:00'},
      target: 'agent',
      agent: {provider: 'claude', image: 'default', dir: '/w', danger: true}
    },
    {
      when: 'every',
      every: {kind: 'weekly', days: [1, 3], time: '07:45'},
      target: 'pane',
      pane: {uid: 'u1', name: 'Naval Tern'},
      history: {keep: true, limit: 7}
    },
    {when: 'every', every: {kind: 'cron', expr: '*/5 * * * *'}, target: 'notify'}
  ];
  for (const run of runs) {
    const f = fmt.prefillFromRun(run, NOW, '/h');
    t.deepEqual(fmt.buildRun(f), {ok: true, run}, JSON.stringify(run));
  }
  const hours = fmt.prefillFromRun(runs[3], NOW, '/h');
  t.is(hours.intervalN, 3);
  t.is(hours.intervalUnit, 'h');
  t.is(fmt.prefillFromRun(null, NOW, '/h').dir, '/h');
});

test('run panel: provider options put installed first and mark unknown', (t) => {
  const opts = fmt.providerOptions([
    {name: 'grok', installed: false},
    {name: 'hermes', installed: null},
    {name: 'codex', installed: true},
    {name: 'claude', installed: true}
  ]);
  t.deepEqual(opts, [
    {value: 'claude', label: 'claude', disabled: false},
    {value: 'codex', label: 'codex', disabled: false},
    {value: 'hermes', label: 'hermes ?', disabled: false},
    {value: 'grok', label: 'grok (not installed)', disabled: true}
  ]);
  t.deepEqual(fmt.providerOptions(undefined), []);
  t.is(fmt.paneLabel({uid: 'u', name: 'Naval Tern', tab: 'Research', app: 'claude'}), 'Naval Tern · Research · claude');
});
