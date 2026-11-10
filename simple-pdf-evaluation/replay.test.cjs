'use strict';
// Offline model: demonstrates the boundary of a signed, create-only PUT.
// It is not an Object Storage emulator, server, signer, or Cloud Function.
const { test } = require('node:test');
const assert = require('node:assert/strict');
class ObjectStoreModel {
  constructor() { this.objects = new Map(); }
  async put(key, data, expiration, now) {
    if (now >= expiration) return 403;
    if (this.objects.has(key)) return 412;
    this.objects.set(key, Buffer.from(data));
    return 200;
  }
  get(key) { return this.objects.get(key); }
  delete(key) { this.objects.delete(key); }
}
test('create-only PUT rejects parallel write and overwrite', async () => {
  const s = new ObjectStoreModel();
  const result = await Promise.all([s.put('estimate', 'first', 10, 1), s.put('estimate', 'second', 10, 1)]);
  assert.deepEqual(result.sort(), [200,412]);
  assert.equal(s.get('estimate').toString(), 'first');
});
test('deleting before expiry allows old permission to recreate object', async () => {
  const s = new ObjectStoreModel();
  assert.equal(await s.put('estimate','first',10,1),200);
  s.delete('estimate');
  assert.equal(await s.put('estimate','first',10,2),200);
});
test('expired permission is rejected in model', async () => {
  const s = new ObjectStoreModel();
  assert.equal(await s.put('estimate','first',10,10),403);
});
test('public storage exposes unchecked bytes as soon as PUT completes', async () => {
  const s = new ObjectStoreModel();
  await s.put('estimate','not-a-pdf',10,1);
  assert.equal(s.get('estimate').toString(),'not-a-pdf');
});
