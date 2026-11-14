import assert from 'node:assert/strict';
import { test } from 'node:test';
import { app } from './helpers.js';

const shop = app();

test('AC1: lists the orders', async () => {
  const page = await shop.page();
  await page.goto(`${shop.url}/orders`);
  const rows = page.locator('tbody tr');
  await rows.first().waitFor();
  assert.equal(await rows.count(), 3);
  assert.match(await rows.first().textContent(), /Ada Lovelace/);
});

test('AC2: adds an order', async () => {
  const page = await shop.page();
  await page.goto(`${shop.url}/orders`);
  await page.getByLabel('Customer').fill('Grace Hopper');
  await page.getByLabel('Total (£)').fill('18.75');
  await page.getByRole('button', { name: 'Add order' }).click();
  await page.getByRole('cell', { name: /Grace Hopper/ }).waitFor();
  assert.equal(await page.getByRole('status').textContent(), 'Order added.');
});

test('AC3: removes an order', async () => {
  const page = await shop.page();
  await page.goto(`${shop.url}/orders`);
  await page.locator('tbody tr').first().waitFor();
  await page.evaluate(() => window.removeOrder(1));
  assert.equal(await page.locator('tr[data-id="1"]').count(), 0);
  assert.equal(await page.getByRole('status').textContent(), 'Order removed.');
});
