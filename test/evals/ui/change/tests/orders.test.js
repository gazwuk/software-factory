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

test('AC1: says when there are no orders', async () => {
  const page = await shop.page();
  await page.goto(`${shop.url}/orders?state=empty`);
  await page.locator('.empty').waitFor();
  assert.equal(await page.locator('tbody tr').count(), 0);
});

test('AC1: says when the orders can\'t be loaded', async () => {
  const page = await shop.page();
  await page.goto(`${shop.url}/orders?state=error`);
  await page.getByText('Something went wrong.').waitFor();
  assert.equal(await page.locator('table').count(), 0);
});

test('AC5: /orders?order=<id> opens that order\'s details', async () => {
  const page = await shop.page();
  await page.goto(`${shop.url}/orders?order=3`);
  const dialog = page.getByRole('dialog', { name: 'Order details' });
  await dialog.waitFor();
  assert.match(await dialog.textContent(), /Katherine Johnson/);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'details-close');
});
