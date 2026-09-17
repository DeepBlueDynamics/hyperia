/* eslint-disable eslint-comments/disable-enable-pair */
import test from 'ava';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const syntax = require('../../app/sticky-renderer/syntax');

test('quote-breakout className cannot inject extra attributes', (t) => {
  const html = syntax.applyRules('hello', [{pattern: 'hello', className: 'x" data-injected="yes', color: '#c0ffee'}]);
  t.false(html.includes('data-injected'));
  t.false(/class="[^"]*"/.test(html) && html.includes('x"'));
});

test('quote-breakout color cannot inject extra attributes', (t) => {
  const html = syntax.applyRules('hello', [
    {pattern: 'hello', className: 'hljs-keyword', color: 'red" data-color="yes'}
  ]);
  t.false(html.includes('data-color'));
  t.false(html.includes('style="color:red"'));
});

test('valid hljs class and documented hex still wrap the match', (t) => {
  const html = syntax.applyRules('hello', [{pattern: 'hello', className: 'hljs-keyword', color: '#c0ffee'}]);
  t.true(html.includes('class="hljs-keyword"'));
  t.true(html.includes('style="color:#c0ffee"'));
  t.true(html.includes('>hello</span>'));
});

test('documented hex lengths are exactly 3/4/6/8', (t) => {
  const wrap = (color) => syntax.applyRules('x', [{pattern: 'x', className: 'hljs-literal', color}]);
  t.true(wrap('#abc').includes('style="color:#abc"'));
  t.true(wrap('#abcd').includes('style="color:#abcd"'));
  t.true(wrap('#aabbcc').includes('style="color:#aabbcc"'));
  t.true(wrap('#aabbccdd').includes('style="color:#aabbccdd"'));
  t.false(wrap('#ab').includes('style='));
  t.false(wrap('#abcde').includes('style='));
  t.false(wrap('#abcdef0').includes('style='));
  t.false(wrap('#abcdef012').includes('style='));
  t.true(wrap('#abcde').includes('>x</span>') || wrap('#abcde').includes('x'));
});

test('invalid class or color is omitted and match text is retained', (t) => {
  const html = syntax.applyRules('hello', [{pattern: 'hello', className: 'keyword', color: 'navy'}]);
  t.false(html.includes('class="keyword"'));
  t.false(html.includes('navy'));
  t.true(html.includes('hello'));
});

test('note content HTML stays escaped', (t) => {
  const html = syntax.applyRules('<img src=x onerror=1>', [{pattern: 'img', className: 'hljs-keyword'}]);
  t.true(html.includes('&lt;'));
  t.false(/<img\b/i.test(html));
});

test('malformed rules are ignored without dropping a later valid rule', (t) => {
  const html = syntax.applyRules('foo bar', [
    {pattern: 1, className: 'hljs-keyword'},
    {pattern: 'bar', flags: 'g--evil', className: 'hljs-keyword'},
    {pattern: 'foo', className: 'not-hljs', color: 'rgb(0,0,0)'},
    {pattern: 'bar', className: 'hljs-string', color: '#fff'}
  ]);
  t.true(html.includes('class="hljs-string"'));
  t.false(html.includes('not-hljs'));
  t.false(html.includes('rgb('));
});

test('non-global flags still make forward progress across matches', (t) => {
  t.timeout(1000);
  const html = syntax.applyRules('aaa', [{pattern: 'a', flags: 'i', className: 'hljs-keyword'}]);
  t.is((html.match(/class="hljs-keyword"/g) || []).length, 3);
});

test('zero-length unicode matches are skipped without hanging', (t) => {
  t.timeout(1000);
  const html = syntax.applyRules('a\u{1F600}b', [
    {pattern: '(?=)', flags: 'gu', className: 'hljs-keyword'},
    {pattern: 'b', className: 'hljs-string'}
  ]);
  t.false(html.includes('hljs-keyword'));
  t.true(html.includes('class="hljs-string"'));
  t.true(html.length < 200);
});

test('agent highlight invokes sticky-highlight and falls back to hljs', async (t) => {
  const calls = [];
  let hljsCalled = 0;
  const banner = {style: {display: ''}, className: '', innerHTML: '', textContent: ''};
  function ctxWith(invoke) {
    return {
      doc: {getElementById: (id) => (id === 'aiBanner' ? banner : null)},
      persist: {},
      win: {
        hljs: {
          highlightElement() {
            hljsCalled += 1;
          }
        }
      },
      ipc: {invoke, on() {}},
      state: {highlightMode: 'agent'}
    };
  }
  const codeEl = {innerHTML: '', textContent: '', dataset: {}};
  const syn = syntax.createSyntax(
    ctxWith((ch, payload) => {
      calls.push([ch, payload]);
      return Promise.resolve({ok: true, rules: [{pattern: 'hello', className: 'hljs-keyword'}]});
    })
  );
  await syn.applyHighlight('hello', codeEl);
  t.is(calls[0][0], 'sticky-highlight');
  t.is(calls[0][1].content, 'hello');
  t.true(codeEl.innerHTML.includes('hljs-keyword'));
  t.is(hljsCalled, 0);

  const code2 = {innerHTML: '', textContent: '', dataset: {highlighted: 'yes'}};
  const syn2 = syntax.createSyntax(ctxWith(() => Promise.reject(new Error('timeout'))));
  await syn2.applyHighlight('hello', code2);
  t.is(hljsCalled, 1);
  t.is(code2.textContent, 'hello');
  t.is(code2.dataset.highlighted, undefined);
});

test('!ok highlight response is not cached and uses static fallback', async (t) => {
  const calls = [];
  let hljsCalled = 0;
  const banner = {style: {display: ''}, className: '', innerHTML: '', textContent: ''};
  const syn = syntax.createSyntax({
    doc: {getElementById: (id) => (id === 'aiBanner' ? banner : null)},
    persist: {},
    win: {
      hljs: {
        highlightElement() {
          hljsCalled += 1;
        }
      }
    },
    ipc: {
      invoke(ch, payload) {
        calls.push([ch, payload]);
        return Promise.resolve({ok: false, rules: [{pattern: 'hello', className: 'hljs-keyword'}], error: 'timeout'});
      },
      on() {}
    },
    state: {highlightMode: 'agent'}
  });
  const codeEl = {innerHTML: '', textContent: '', dataset: {}};
  await syn.applyHighlight('hello', codeEl);
  t.is(hljsCalled, 1);
  t.is(codeEl.textContent, 'hello');
  t.false((codeEl.innerHTML || '').includes('hljs-keyword'));
  await syn.applyHighlight('hello', {innerHTML: '', textContent: '', dataset: {}});
  t.is(calls.length, 2);
});

test('ok highlight response is cached; content is sliced to 4000', async (t) => {
  const calls = [];
  const banner = {style: {display: ''}, className: '', innerHTML: '', textContent: ''};
  const syn = syntax.createSyntax({
    doc: {getElementById: (id) => (id === 'aiBanner' ? banner : null)},
    persist: {},
    win: {hljs: {highlightElement() {}}},
    ipc: {
      invoke(ch, payload) {
        calls.push([ch, payload]);
        return Promise.resolve({ok: true, rules: [{pattern: 'ab', className: 'hljs-keyword'}]});
      },
      on() {}
    },
    state: {highlightMode: 'agent'}
  });
  const long = 'ab'.repeat(2500);
  const el = {innerHTML: '', textContent: '', dataset: {}};
  await syn.applyHighlight(long, el);
  t.is(calls[0][1].content.length, 4000);
  await syn.applyHighlight(long, {innerHTML: '', textContent: '', dataset: {}});
  t.is(calls.length, 1);
});
