import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'officebridge-e2e-'));
const launchOptions = { headless: true, args: ['--no-sandbox'] };
if (process.env.CHROME_PATH) launchOptions.executablePath = process.env.CHROME_PATH;
else launchOptions.channel = 'chrome';
const browser = await chromium.launch(launchOptions);
const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 1000 } });
const host = process.env.OFFICEBRIDGE_URL || 'http://localhost:5173/';
const page = await context.newPage();
const guestPage = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
guestPage.on('pageerror', (error) => errors.push(error.message));

try {
  await page.goto(host);
  await page.getByRole('heading', { name: /Share files between devices/ }).waitFor();
  assert.equal(await page.getByRole('button', { name: /Create Room/ }).count(), 1);
  await page.getByRole('button', { name: /Create Room/ }).click({ force: true });
  await page.getByLabel('Room name').fill('Browser test room');
  await page.getByLabel('Your display name').fill('Owner');
  await page.getByLabel('Room expires').selectOption('30');
  await page.getByRole('button', { name: /Create room/ }).click({ force: true });
  await page.getByText('Your room is ready').waitFor();
  const code = await page.locator('.invite-code strong').innerText();
  assert.match(code, /^[23456789A-HJ-NP-Z]{8}$/);
  assert.ok(await page.getByRole('img', { name: /QR code to join Browser test room/ }).count());
  await page.getByRole('button', { name: 'Enter room' }).click({ force: true });
  await page.getByRole('heading', { name: 'Browser test room' }).waitFor();
  await page.locator('.person-row').filter({ hasText: 'Owner' }).waitFor();
  await page.getByText('Live', { exact: true }).waitFor();

  await guestPage.goto(`${new URL(host).origin}/?room=${code}`);
  await guestPage.getByLabel('Room code').waitFor();
  assert.equal(await guestPage.getByLabel('Room code').inputValue(), code);
  await guestPage.getByLabel('Your display name').fill('Guest');
  await guestPage.getByRole('button', { name: /Join room/ }).click({ force: true });
  await guestPage.getByRole('heading', { name: 'Browser test room' }).waitFor();
  await guestPage.getByText('Live', { exact: true }).waitFor();
  await page.getByText('Guest', { exact: true }).waitFor();

  const testFile = path.join(scratch, 'bridge-note.txt');
  fs.writeFileSync(testFile, 'A file shared through the OfficeBridge browser test.');
  await guestPage.locator('input[type=file]').setInputFiles(testFile);
  await page.getByText('bridge-note.txt', { exact: true }).waitFor();
  await guestPage.getByText('bridge-note.txt', { exact: true }).waitFor();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download bridge-note.txt' }).click({ force: true });
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), 'bridge-note.txt');

  const sharedSnippet = 'const bridge = "connected";';
  await guestPage.getByPlaceholder(/Write a note or paste a code snippet/).fill(sharedSnippet);
  await guestPage.getByLabel('Language').selectOption('javascript');
  await guestPage.getByRole('button', { name: /Share with room/ }).click({ force: true });
  await page.getByText(sharedSnippet, { exact: true }).waitFor();
  assert.equal(await page.getByText('javascript', { exact: true }).count(), 1);

  await page.getByRole('button', { name: 'Invite', exact: true }).click({ force: true });
  await page.getByRole('dialog').getByRole('heading', { name: /Scan to join Browser test room/ }).waitFor();
  await page.getByRole('button', { name: 'Close QR code' }).click({ force: true });

  await guestPage.getByRole('button', { name: 'Delete bridge-note.txt' }).click({ force: true });
  await guestPage.getByRole('dialog').getByRole('heading', { name: 'Remove this file?' }).waitFor();
  await guestPage.getByRole('button', { name: 'Remove file' }).click({ force: true });
  await guestPage.locator('.file-list').getByText('bridge-note.txt', { exact: true }).waitFor({ state: 'detached' });
  await page.locator('.file-list').getByText('bridge-note.txt', { exact: true }).waitFor({ state: 'detached' });

  await guestPage.setViewportSize({ width: 390, height: 844 });
  await guestPage.waitForTimeout(250);
  const mobile = await guestPage.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert.equal(mobile.width, 390);
  assert.ok(mobile.scrollWidth <= mobile.width, `mobile viewport overflows horizontally: ${JSON.stringify(mobile)}`);
  await guestPage.screenshot({ path: path.join(scratch, 'mobile-room.png'), fullPage: true });

  await guestPage.getByRole('button', { name: /Leave room/ }).click({ force: true });
  await page.locator('.person-row').filter({ hasText: 'Guest' }).waitFor({ state: 'detached' });

  await guestPage.getByRole('button', { name: /Join Room/ }).click({ force: true });
  await guestPage.getByLabel('Room code').fill('ZZZZZZZZ');
  await guestPage.getByLabel('Your display name').fill('');
  await guestPage.getByRole('button', { name: /Join room/ }).click({ force: true });
  await guestPage.getByRole('alert').getByText('Add a display name to join the room.').waitFor();
  await guestPage.getByLabel('Your display name').fill('Missing room check');
  await guestPage.getByRole('button', { name: /Join room/ }).click({ force: true });
  await guestPage.getByRole('alert').getByText(/couldn’t find that room/i).waitFor();
  const expiredRoom = await guestPage.evaluate(async () => {
    const response = await fetch('/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Expired browser test room', displayName: 'Test host', expirationMinutes: 0.001 }) });
    return response.json();
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await guestPage.getByLabel('Room code').fill(expiredRoom.room.code);
  await guestPage.getByRole('button', { name: /Join room/ }).click({ force: true });
  await guestPage.getByRole('alert').getByText(/This room has expired/i).waitFor();

  assert.deepEqual(errors, [], `browser page errors: ${errors.join('; ')}`);
  console.log(`Browser checks passed: create ${code}, join (including missing-name, invalid, and expired errors), QR, live presence join/leave, upload, download, share text/code, delete, and mobile 390px layout.`);
} finally {
  await context.close();
  await browser.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}
