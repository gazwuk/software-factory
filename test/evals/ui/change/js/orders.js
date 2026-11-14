import { apiUrl, escapeHtml, money } from './api.js';

const list = document.getElementById('orders');
const status = document.getElementById('status');
const form = document.getElementById('new-order');
const backdrop = document.getElementById('details-backdrop');
const dialog = document.getElementById('details');
const closeButton = document.getElementById('details-close');

const EYE = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 3C4 3 1 8 1 8s3 5 7 5 7-5 7-5-3-5-7-5Zm0 8a3 3 0 1 1 0-6 3 3 0 0 1 0 6Z"/></svg>';
const TRASH = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M6 1h4l1 1h3v2H2V2h3l1-1Zm-3 4h10l-1 10H4L3 5Z"/></svg>';

let orders = [];

function announce(message) {
  status.textContent = message;
}

async function load() {
  try {
    const res = await fetch(apiUrl('/api/orders'));
    if (!res.ok) throw new Error(`GET /api/orders: ${res.status}`);
    orders = await res.json();
    render();
  } catch {
    list.textContent = 'Something went wrong.';
  }
}

function row(o) {
  return `<tr data-id="${o.id}">
    <td>#${o.id}</td>
    <td>${escapeHtml(o.customer)}<span class="order-meta">${o.items} item${o.items === 1 ? '' : 's'}</span></td>
    <td>${o.placed}</td>
    <td><span class="status-pill">${escapeHtml(o.status)}</span></td>
    <td>${money(o.total)}</td>
    <td class="actions">
      <button class="icon-btn" type="button" data-action="view" aria-label="View order #${o.id}">${EYE}</button>
      <button class="icon-btn" type="button" data-action="delete">${TRASH}</button>
    </td>
  </tr>`;
}

function render() {
  if (!orders.length) {
    list.innerHTML = '<p class="empty">No orders.</p>';
    return;
  }
  list.innerHTML = `<table class="orders-table">
    <thead>
      <tr>
        <th scope="col">Order</th><th scope="col">Customer</th><th scope="col">Placed</th>
        <th scope="col">Status</th><th scope="col">Total</th><th scope="col"><span class="visually-hidden">Actions</span></th>
      </tr>
    </thead>
    <tbody>${orders.map(row).join('')}</tbody>
  </table>`;
}

export async function removeOrder(id) {
  const res = await fetch(apiUrl(`/api/orders/${id}`), { method: 'DELETE' }).catch(() => null);
  if (!res?.ok) return announce(`Couldn’t remove order #${id}. Try again in a moment.`);
  orders = orders.filter((o) => o.id !== id);
  render();
  announce('Order removed.');
}
window.removeOrder = removeOrder;

function openDetails(id) {
  const o = orders.find((x) => x.id === id);
  document.getElementById('details-body').innerHTML = `
    <dt>Order</dt><dd>#${o.id}</dd>
    <dt>Customer</dt><dd>${escapeHtml(o.customer)}</dd>
    <dt>Total</dt><dd>${money(o.total)}</dd>`;
  backdrop.hidden = false;
  closeButton.focus();
}

function closeDetails() {
  backdrop.hidden = true;
}

list.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const id = Number(button.closest('tr').dataset.id);
  if (button.dataset.action === 'view') openDetails(id);
  if (button.dataset.action === 'delete') removeOrder(id);
});

closeButton.addEventListener('click', closeDetails);
document.addEventListener('keydown', (event) => {
  if (backdrop.hidden) return;
  if (event.key === 'Escape') closeDetails();
  // The dialog is modal: Tab stays inside it (Close is its only control).
  if (event.key === 'Tab') {
    event.preventDefault();
    closeButton.focus();
  }
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  for (const el of form.querySelectorAll('.field-error')) el.textContent = '';
  const res = await fetch(apiUrl('/api/orders'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ customer: form.customer.value, total: form.total.value }),
  }).catch(() => null);
  form.reset();
  if (!res) return announce('Couldn’t reach the shop to add the order. Check your connection and try again.');
  if (!res.ok) {
    const { field, error } = await res.json();
    document.getElementById(`${field}-error`).textContent = error;
    return;
  }
  orders = [...orders, await res.json()];
  render();
  announce('Order added.');
});

await load();
const deepLink = Number(new URLSearchParams(location.search).get('order'));
if (deepLink && orders.some((o) => o.id === deepLink)) openDetails(deepLink);
