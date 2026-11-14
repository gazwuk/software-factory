import assert from 'node:assert/strict';
import { test } from 'node:test';
import { app } from './helpers.js';

const shop = app();

test('the home page greets the user', async () => {
  const page = await shop.page();
  await page.goto(`${shop.url}/`);
  assert.equal(await page.getByRole('heading', { level: 1 }).textContent(), 'Welcome back');
});
