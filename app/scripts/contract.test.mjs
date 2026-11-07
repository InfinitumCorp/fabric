// Regression: the JS <-> native contract cannot carry passwords, tokens or keys. Run: node --test scripts/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const ts = read('modules/fabric-matrix/src/FabricMatrixModule.ts');
const kt = read('modules/fabric-matrix/android/src/main/java/expo/modules/fabricmatrix/FabricMatrixModule.kt');
const app = read('App.tsx');
const SECRET = /pass(word)?|pw\b|token|secret|recovery|store_?key|private/i;

test('TS bridge declares no login and no secret-named parameter', () => {
  assert.doesNotMatch(ts, /\blogin\s*\(/);
  const params = [...ts.matchAll(/\b\w+\(([^)]*)\)\s*:\s*Promise/g)].flatMap((m) => m[1].split(',').map((x) => x.split(':')[0].trim()).filter(Boolean));
  assert.ok(params.length > 10);
  for (const p of params) assert.doesNotMatch(p, SECRET, `parameter ${p}`);
});

test('native module exposes no login and takes no secret-named argument', () => {
  const fns = [...kt.matchAll(/AsyncFunction\("(\w+)"\)\s*Coroutine\s*\{([^>]*)->/g)];
  assert.ok(fns.length > 10);
  for (const [, name, args] of fns) {
    assert.notEqual(name, 'login');
    assert.doesNotMatch(args, SECRET, `${name}(${args})`);
  }
});

test('native module returns only allow-listed fields to JS', () => {
  const allowed = new Set(['userId', 'deviceId', 'roomId', 'name', 'peer', 'invited', 'encrypted', 'identity', 'id', 'mine', 'sender', 'body', 'utd', 'state', 'ts', 'phase', 'other', 'emojis', 'symbol', 'description']);
  const keys = [...kt.matchAll(/"(\w+)" to /g)].map((m) => m[1]);
  assert.ok(keys.length > 10);
  for (const k of keys) assert.ok(allowed.has(k), `field ${k} crosses to JS`);
  assert.doesNotMatch(kt, /accessToken|\.session\(\)|loadStoreKey/);
});

test('app has no password field', () => {
  assert.doesNotMatch(app, /secureTextEntry|Matrix!?\.login|password\s*[:=]/i);
});

test('screenshot exception is compile-time only and off by default', () => {
  const gradle = read('modules/fabric-matrix/android/build.gradle');
  assert.match(gradle, /findProperty\('fabricDiagnosticScreenshots'\) \?: 'false'/);
  assert.match(kt, /if \(BuildConfig\.DIAGNOSTIC_SCREENSHOTS\) return/);
  const signIn = read('modules/fabric-matrix/android/src/main/java/expo/modules/fabricmatrix/SignInActivity.kt');
  assert.match(signIn, /addFlags\(WindowManager\.LayoutParams\.FLAG_SECURE\)/);
  assert.doesNotMatch(signIn, /DIAGNOSTIC/);
  assert.doesNotMatch(kt, /clearFlags/);
});
