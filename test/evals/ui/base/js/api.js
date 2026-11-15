// The orders API's URLs. In development, the page's `?state=` (empty or error) is
// passed on, so the server returns no orders or fails.
export function apiUrl(path) {
  const state = new URLSearchParams(location.search).get('state');
  return state ? `${path}?state=${encodeURIComponent(state)}` : path;
}

export const money = (n) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(n);

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ENTITIES[c]);
