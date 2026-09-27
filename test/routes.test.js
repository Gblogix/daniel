// Loads every route module so syntax / wiring errors fail the test suite, not just the live server.
const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/db');
store.db = store.open(':memory:');

test('app and all routes load', () => {
  const { createApp } = require('../src/server');
  assert.equal(typeof createApp(), 'function');
});
