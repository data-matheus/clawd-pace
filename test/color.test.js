'use strict';

const assert = require('assert');
const { normHex, eyeColor, hexToRgb } = require('../color');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

t('normalizes 6-digit hex with or without #', () => {
  assert.strictEqual(normHex('#D97757'), '#d97757');
  assert.strictEqual(normHex('3987E5'), '#3987e5');
  assert.strictEqual(normHex('  #abcdef '), '#abcdef');
});
t('expands 3-digit hex', () => {
  assert.strictEqual(normHex('#f0a'), '#ff00aa');
  assert.strictEqual(normHex('0Fc'), '#00ffcc');
});
t('rejects invalid input', () => {
  for (const v of ['', null, undefined, '#12', '#12345', '#1234567', 'red', '#ggg', 'javascript:1', '#12345g']) {
    assert.strictEqual(normHex(v), null, String(v));
  }
});
t('hexToRgb', () => assert.deepStrictEqual(hexToRgb('#3987e5'), [57, 135, 229]));
t('eyes flip to light on dark bodies', () => {
  assert.strictEqual(eyeColor('#d97757'), '#1a1a19');
  assert.strictEqual(eyeColor('#ffffff'), '#1a1a19');
  assert.strictEqual(eyeColor('#1a1a19'), '#f0efec');
  assert.strictEqual(eyeColor('#202a60'), '#f0efec');
});

console.log(`\n${n} tests passed`);
