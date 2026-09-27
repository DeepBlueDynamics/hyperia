import test from 'ava';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const fit = require('../../app/sticky-renderer/fit');

test('parseFitParam: four positive numbers or nothing', (t) => {
  t.deepEqual(fit.parseFitParam('1152,756,480,378'), {maxW: 1152, maxH: 756, minW: 480, minH: 378});
  t.is(fit.parseFitParam(null), null);
  t.is(fit.parseFitParam('1,2,3'), null);
  t.is(fit.parseFitParam('1,2,x,4'), null);
  t.is(fit.parseFitParam('1,2,0,4'), null);
});

const caps = {maxW: 1000, maxH: 800, minW: 400, minH: 300};

test('planFit: sizes to content plus chrome and slack', (t) => {
  const widths: number[] = [];
  const size = fit.planFit({
    naturalW: 500,
    heightAt: (w: number) => {
      widths.push(w);
      return 400;
    },
    chromeW: 20,
    chromeH: 40,
    caps
  });
  t.deepEqual(size, {width: 500 + 20 + fit.SLACK, height: 400 + 40 + fit.SLACK});
  t.deepEqual(widths, [500 + fit.SLACK], 'height is measured at the final content width');
});

test('planFit: long lines cap the width and wrap into more height', (t) => {
  const size = fit.planFit({
    naturalW: 5000,
    heightAt: (w: number) => (w < 1000 ? 2000 : 100),
    chromeW: 20,
    chromeH: 40,
    caps
  });
  t.deepEqual(size, {width: 1000, height: 800});
});

test('planFit: tiny content is held at the minimum', (t) => {
  t.deepEqual(fit.planFit({naturalW: 10, heightAt: () => 10, chromeW: 0, chromeH: 0, caps}), {width: 400, height: 300});
});
