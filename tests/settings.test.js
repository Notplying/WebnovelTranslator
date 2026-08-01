// Schema invariants + sanitizer behavior for settings.js.
// Run: node --test tests/settings.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { SETTINGS, DEFAULTS, LOCAL_SETTINGS_KEYS, NON_SETTING_STORAGE_KEYS, IMPORTABLE_DATA_KEYS, sanitizeNumericSettings } = require('../settings.js');

test('DEFAULTS mirrors the schema exactly', () => {
  const keys = Object.keys(SETTINGS);
  assert.equal(Object.keys(DEFAULTS).length, keys.length);
  for (const key of keys) {
    assert.ok(key in DEFAULTS, `DEFAULTS missing ${key}`);
    assert.equal(DEFAULTS[key], SETTINGS[key].default, `${key} default mismatch`);
  }
});

test('every entry declares an elementId string', () => {
  for (const [key, def] of Object.entries(SETTINGS)) {
    assert.equal(typeof def.elementId, 'string', `${key} needs elementId`);
  }
});

test('numeric rows: defaults within [min, max]; min <= max', () => {
  for (const [key, def] of Object.entries(SETTINGS)) {
    if (def.type !== 'number') continue;
    if (def.min === undefined || def.max === undefined) {
      assert.ok(def.allowEmpty, `${key} numeric row must be clamped or allowEmpty`);
      continue;
    }
    assert.ok(def.min <= def.max, `${key} min > max`);
    assert.ok(def.default >= def.min && def.default <= def.max,
      `${key} default ${def.default} outside [${def.min}, ${def.max}]`);
  }
});

test('allowEmpty rows default to empty string', () => {
  for (const [key, def] of Object.entries(SETTINGS)) {
    if (def.allowEmpty) {
      assert.equal(def.default, '', `${key} allowEmpty default must be ''`);
    }
  }
});

test('LOCAL_SETTINGS_KEYS excludes the sync-area key, includes everything else', () => {
  assert.equal(LOCAL_SETTINGS_KEYS.length, Object.keys(SETTINGS).length - 1);
  assert.ok(!LOCAL_SETTINGS_KEYS.includes('collectionIncludeInBackup'));
  assert.ok(LOCAL_SETTINGS_KEYS.includes('apiType'));
});

test('non-setting keys are disjoint from the settings schema', () => {
  for (const key of NON_SETTING_STORAGE_KEYS) {
    assert.ok(!(key in SETTINGS), `${key} must not be a setting`);
  }
});

test('import allow-list covers every setting', () => {
  const allow = [...Object.keys(DEFAULTS), ...IMPORTABLE_DATA_KEYS];
  for (const key of Object.keys(SETTINGS)) {
    assert.ok(allow.includes(key), `import allow-list missing ${key}`);
  }
});

// ─── sanitizer behavior ───────────────────────────────────────────────────────

test('sanitizer clamps out-of-range values to [min, max]', () => {
  assert.equal(sanitizeNumericSettings({ retryCount: 999 }).retryCount, 20);
  assert.equal(sanitizeNumericSettings({ retryCount: 0 }).retryCount, 1);
  assert.equal(sanitizeNumericSettings({ temperature: 99 }).temperature, 2);
  assert.equal(sanitizeNumericSettings({ topP: 0 }).topP, 0.01);
});

test('sanitizer falls back to schema default on NaN', () => {
  assert.equal(sanitizeNumericSettings({ temperature: 'abc' }).temperature, DEFAULTS.temperature);
  assert.equal(sanitizeNumericSettings({ retryCount: 'abc' }).retryCount, DEFAULTS.retryCount);
});

test('sanitizer uses integer parse for integer rows, float for float rows', () => {
  // '3.7' truncates to 3 for integer rows, parses as 3.7 for float rows.
  assert.equal(sanitizeNumericSettings({ retryCount: '3.7' }).retryCount, 3);
  assert.equal(sanitizeNumericSettings({ temperature: '3.7' }).temperature, 2); // 3.7 clamped to max 2
});

test('sanitizer preserves blank allowEmpty token fields', () => {
  assert.equal(sanitizeNumericSettings({ geminiMaxTokens: '' }).geminiMaxTokens, '');
  assert.equal(sanitizeNumericSettings({ openRouterMaxTokens: undefined }).openRouterMaxTokens, '');
});

test('sanitizer passes unknown keys through untouched', () => {
  const out = sanitizeNumericSettings({ someFutureKey: 'x', retryCount: 5 });
  assert.equal(out.someFutureKey, 'x');
  assert.equal(out.retryCount, 5);
});

test('sanitizer does not invent keys that were not present', () => {
  const out = sanitizeNumericSettings({ retryCount: 5 });
  assert.ok(!('maxLength' in out));
  assert.ok(!('prefix' in out));
});
