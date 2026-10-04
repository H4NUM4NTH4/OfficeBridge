const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { io: createClient } = require('socket.io-client');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'officebridge-'));
process.env.DATABASE_PATH = path.join(scratch, 'db.sqlite');
process.env.STORAGE_PATH = path.join(scratch, 'storage');
process.env.DEFAULT_ROOM_EXPIRATION_MINUTES = '60';

const { server, db, cleanupExpiredRooms } = require('../src/server');
const base = async (route, options = {}) => fetch(`http://127.0.0.1:${server.address().port}${route}`, options);
const json = (response) => response.json();

(async () => {
  let client;
  let guestClient;
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    assert.equal((await json(await base('/health'))).status, 'ok');

    const createResponse = await base('/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Smoke room', displayName: 'Owner' }) });
    assert.equal(createResponse.status, 201);
    const created = await json(createResponse);
    assert.match(created.room.code, /^[23456789A-HJ-NP-Z]{8}$/);
    assert.ok(created.qrCode.startsWith('data:image/png;base64,'));
    const code = created.room.code;
    const memberHeaders = { 'X-User-Id': created.user.id };

    assert.equal((await base(`/api/rooms/${code}/files`)).status, 401);
    assert.equal((await base(`/api/rooms/${code}/files`, { headers: { 'X-User-Id': 'forged' } })).status, 403);
    assert.equal((await base(`/api/rooms/${code}` , { headers: memberHeaders })).status, 200);

    client = createClient(`http://127.0.0.1:${server.address().port}`, { auth: { roomCode: code, userId: created.user.id },
      transports: ['websocket'], reconnection: false });
    const ownerSnapshotPromise = once(client, 'users:present');
    await once(client, 'connect');
    const ownerSnapshot = (await ownerSnapshotPromise)[0];
    assert.deepEqual(ownerSnapshot.users, [{ id: created.user.id, displayName: 'Owner' }]);

    const joined = once(client, 'user:joined');
    const joinResponse = await base(`/api/rooms/${code}/join`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Guest' }) });
    assert.equal(joinResponse.status, 201);
    const guest = (await json(joinResponse)).user;
    assert.equal((await joined)[0].user.displayName, 'Guest');

    const neverConnectedJoin = await base(`/api/rooms/${code}/join`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Never connected' }) });
    assert.equal(neverConnectedJoin.status, 201);
    const ownerSawGuestConnect = once(client, 'user:joined');
    guestClient = createClient(`http://127.0.0.1:${server.address().port}`, { auth: { roomCode: code, userId: guest.id },
      transports: ['websocket'], reconnection: false });
    const guestSnapshotPromise = once(guestClient, 'users:present');
    await once(guestClient, 'connect');
    const guestSnapshot = (await guestSnapshotPromise)[0];
    assert.deepEqual(new Set(guestSnapshot.users.map((user) => user.id)), new Set([created.user.id, guest.id]));
    assert.equal(guestSnapshot.users.some((user) => user.displayName === 'Never connected'), false);
    assert.equal((await ownerSawGuestConnect)[0].user.id, guest.id);
    const userLeft = once(client, 'user:left');
    guestClient.disconnect();
    assert.equal((await userLeft)[0].userId, guest.id);
    guestClient = null;

    const form = new FormData();
    form.append('file', new Blob(['hello officebridge'], { type: 'text/plain' }), '../hello.txt');
    const fileUploadedEvent = once(client, 'file:uploaded');
    const uploadedResponse = await base(`/api/rooms/${code}/files`, { method: 'POST', headers: memberHeaders, body: form });
    assert.equal(uploadedResponse.status, 201);
    const uploaded = (await json(uploadedResponse)).file;
    assert.equal((await fileUploadedEvent)[0].file.id, uploaded.id);
    assert.equal(uploaded.originalFilename, 'hello.txt');
    assert.equal(uploaded.size, 18);
    const listedFiles = await json(await base(`/api/rooms/${code}/files`, { headers: memberHeaders }));
    assert.equal(listedFiles.files.length, 1);
    const download = await base(`/api/rooms/${code}/files/${uploaded.id}`, { headers: memberHeaders });
    assert.equal(await download.text(), 'hello officebridge');

    const textSharedEvent = once(client, 'text:shared');
    const textResponse = await base(`/api/rooms/${code}/texts`, { method: 'POST', headers: { ...memberHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'const bridge = true;', language: 'javascript' }) });
    assert.equal(textResponse.status, 201);
    const text = (await json(textResponse)).text;
    assert.equal((await textSharedEvent)[0].text.id, text.id);
    assert.equal(text.userId, created.user.id);
    assert.equal((await json(await base(`/api/rooms/${code}/texts`, { headers: memberHeaders }))).texts.length, 1);

    const fileDeletedEvent = once(client, 'file:deleted');
    const deleted = await base(`/api/rooms/${code}/files/${uploaded.id}`, { method: 'DELETE', headers: memberHeaders });
    assert.equal(deleted.status, 204);
    assert.equal((await fileDeletedEvent)[0].fileId, uploaded.id);
    assert.equal((await json(await base(`/api/rooms/${code}/files`, { headers: memberHeaders }))).files.length, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM shared_texts WHERE room_id = ?').get(created.room.id).count, 1);

    db.prepare('UPDATE rooms SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), created.room.id);
    assert.equal((await base(`/api/rooms/${code}`, { headers: memberHeaders })).status, 410);
    assert.equal(cleanupExpiredRooms(), 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM rooms WHERE id = ?').get(created.room.id).count, 0);
    console.log('Smoke checks passed: REST, membership, SQLite, upload/download/delete, QR, Socket.IO presence/join/leave and content events, expiration cleanup.');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    if (guestClient) guestClient.close();
    if (client) client.close();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    db.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
})();
