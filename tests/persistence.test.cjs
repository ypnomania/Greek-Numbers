const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { webcrypto } = require('node:crypto');
const { test } = require('node:test');
const vm = require('node:vm');

const html = readFileSync(new URL('../index.html', `file://${__filename}`), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
assert.equal(scripts.length, 2);
for (const script of scripts) new vm.Script(script);

// Exercise the application's persistence code without booting browser UI or speech.
const context = vm.createContext({ crypto: webcrypto, document: {} });
context.window = context;
vm.runInContext(scripts[0], context);
const listenersStart = scripts[1].lastIndexOf("for(const b of document.querySelectorAll('[data-tab]'))");
assert.ok(listenersStart > 0);
vm.runInContext(scripts[1].slice(0, listenersStart) + `
globalThis.persistence = { packEvent, unpackEvent, packDBEvent, unpackDBEvent, normalizeImportedEvent };
})();`, context);
const C = context.GreekCore;
const P = context.persistence;
const plain = value => JSON.parse(JSON.stringify(value));

function phoneEvent(pattern, phoneStyle = 'mixed', result = 'correct') {
  return C.validateEvent({
    id: `event-${pattern}-${result}`, sessionId: 'session-1', at: 1700000000000,
    day: '2023-11-14', mode: 'phone', kind: 'phone', target: '6901230456',
    parts: C.phoneParts('6901230456', pattern), keys: [], sampling: pattern,
    regime: 'timed', rate: 1, inputPolicy: 'during', keyboard: 'pad', phoneStyle,
    result, entered: result === 'correct' ? '6901230456' : '6901230457',
    wrongInputs: [], edits: 0, replays: 0, pasted: false,
    completionMs: result === 'correct' ? 820 : null, firstKeyMs: 200,
    typingMs: result === 'correct' ? 620 : null, completedDuringAudio: false,
  });
}

test('mixed phone records retain their grouping through database and JSON backup round trips', () => {
  for (const pattern of Object.keys(C.PATTERNS)) {
    for (const result of ['correct', 'wrong', 'timeout', 'revealed', 'skipped', 'interrupted', 'audio_error']) {
      const original = phoneEvent(pattern, 'mixed', result);
      const row = P.packDBEvent(original);
      const backup = JSON.parse(JSON.stringify(P.packEvent(original, 0)));
      for (const restored of [P.unpackDBEvent(row), P.unpackEvent(backup, ['session-1'])]) {
        assert.equal(restored.phoneStyle, 'mixed');
        assert.equal(restored.sessionId, original.sessionId);
        assert.equal(restored.target, original.target);
        assert.equal(restored.result, original.result);
        assert.equal(restored.entered, original.entered);
        assert.deepEqual(plain(restored.parts), plain(original.parts));
        assert.equal(C.condition(restored), C.settingsCondition({
          regime: 'timed', rate: 1, keyboard: 'pad', phonePattern: 'mixed',
        }, 'phone'));
      }
    }
  }
});

test('legacy mixed compact records load with a deterministic fallback without losing answers', () => {
  const original = phoneEvent('triple');
  const legacy = P.packEvent(original).slice(0, 17);
  const restored = P.unpackEvent(legacy);
  assert.equal(restored.phoneStyle, 'mixed');
  assert.equal(restored.entered, original.entered);
  assert.equal(restored.completionMs, original.completionMs);
  assert.deepEqual(plain(restored.parts), plain(C.phoneParts(original.target, 'pairs')));
  assert.deepEqual(plain(P.unpackDBEvent(P.packDBEvent(restored)).parts), plain(restored.parts));
});

test('legacy expanded records preserve their parts or reconstruct their recorded sampling', () => {
  for (const pattern of Object.keys(C.PATTERNS)) {
    const original = phoneEvent(pattern);
    const withoutParts = { ...original };
    delete withoutParts.parts;
    for (const legacy of [original, withoutParts]) {
      const restored = P.unpackDBEvent(P.packDBEvent(P.normalizeImportedEvent(legacy)));
      assert.deepEqual(plain(restored.parts), plain(original.parts));
    }
    delete withoutParts.sampling;
    const fallback = P.normalizeImportedEvent(withoutParts);
    assert.deepEqual(plain(fallback.parts), plain(C.phoneParts(original.target, 'pairs')));
  }
});

test('fixed phone patterns keep their existing 17-field format and behavior', () => {
  for (const pattern of [...Object.keys(C.PATTERNS), 'digits']) {
    const original = phoneEvent(pattern, pattern);
    const packed = P.packEvent(original);
    assert.equal(packed.length, 17);
    assert.deepEqual(plain(P.unpackEvent(packed).parts), plain(original.parts));
  }
});

test('number records keep their existing format and components', () => {
  const original = C.validateEvent({
    ...phoneEvent('pairs', 'pairs'), mode: 'number', kind: 'compound',
    target: '1021', entered: '1021', keys: C.components(1021),
    parts: [{ digits: '1021', text: C.greek(1021) }],
  });
  const packed = P.packEvent(original);
  const restored = P.unpackEvent(packed);
  assert.equal(packed.length, 17);
  assert.equal(restored.target, original.target);
  assert.deepEqual(plain(restored.keys), plain(original.keys));
  assert.deepEqual(plain(restored.parts), plain(original.parts));
});

test('an invalid explicit mixed grouping is rejected', () => {
  const packed = P.packEvent(phoneEvent('pairs'));
  for (const invalid of [3, 4, 99, null]) {
    packed[17] = invalid;
    assert.throws(() => P.unpackEvent(packed), /紧凑电话分组无效/);
  }
});
