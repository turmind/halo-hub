import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addressUrl } from '../../src/navigation.js'

test('address entry defaults to https, accepts http(s) only and never searches', () => {
  assert.equal(addressUrl(' example.com/path?q=yes '), 'https://example.com/path?q=yes')
  assert.equal(addressUrl('localhost:8443/path'), 'https://localhost:8443/path')
  assert.equal(addressUrl('http://127.0.0.1:8888/'), 'http://127.0.0.1:8888/')
  for (const value of ['', 'two words', 'file:///fixture', 'chrome://settings', 'javascript:1', 'data:text/plain,test', 'ftp://example.com', 'https://user:pass@example.com', 'x'.repeat(8193)]) assert.equal(addressUrl(value), undefined, value)
})
