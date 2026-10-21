// Config is validated once, at the edge, so a bad value fails before any write. These tests pin the
// messages, because the message is the whole point of the check.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { erpConfig, modelConfig } from '../src/config.js';

test('a well-formed erp config falls back to the local defaults', () => {
  const config = erpConfig({ ERP_TOKEN: 'key:secret' } as NodeJS.ProcessEnv);
  assert.equal(config.base, 'http://127.0.0.1:8080');
  assert.equal(config.company, 'Nordic Parts Demo');
  assert.equal(config.token, 'key:secret');
});

test('the inbox token wins over the generic token', () => {
  const config = erpConfig({ ERP_TOKEN: 'a:b', ERP_INBOX_TOKEN: 'c:d' } as NodeJS.ProcessEnv);
  assert.equal(config.token, 'c:d');
});

test('a missing token names the variable and the fix', () => {
  assert.throws(
    () => erpConfig({} as NodeJS.ProcessEnv),
    /ERP_CONFIG_INVALID.*ERP_INBOX_TOKEN/s,
  );
});

test('a token with a space is rejected instead of failing later as an opaque 401', () => {
  assert.throws(() => erpConfig({ ERP_TOKEN: 'key: sec ret' } as NodeJS.ProcessEnv), /ERP_CONFIG_INVALID/);
});

test('a missing model key is reported before the first request', () => {
  assert.throws(() => modelConfig({} as NodeJS.ProcessEnv), /MODEL_CONFIG_INVALID.*GOOGLE_API_KEY/s);
  assert.doesNotThrow(() => modelConfig({ GOOGLE_API_KEY: 'x'.repeat(30) } as NodeJS.ProcessEnv));
});
