import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashString } from '@vibetoon/shared';
import { hashBytes } from '../src/storage';

test('a file is hashed in pieces to the same hash as its whole base64', () => {
  for (const size of [0, 1, 2, 3, 1000, 3 * 1024 * 1024 - 1, 3 * 1024 * 1024, 3 * 1024 * 1024 + 1, 7 * 1024 * 1024 + 5]) {
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i += 1) bytes[i] = (i * 31 + 7) % 256;
    assert.equal(hashBytes(bytes), hashString(Buffer.from(bytes).toString('base64')), `${size} bytes`);
  }
});

test('a view into a bigger buffer is hashed as just its own bytes', () => {
  const whole = new Uint8Array([9, 9, 1, 2, 3, 4, 9]);
  assert.equal(hashBytes(whole.subarray(2, 6)), hashString(Buffer.from([1, 2, 3, 4]).toString('base64')));
});
