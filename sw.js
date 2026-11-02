/* SOL FX LAB v2.4 Web Push receiver.
 * Preserve existing offline shell, never cache tokens, encrypted snapshots, APIs,
 * subscriptions, or notification payloads. No trades; no outbound writes.
 */
const CACHE = 'sol-fx-mobile-shell-v2-4-0';
const ASSETS = ['./','./index.html','./styles.css','./health.css','./health.js','./app.js','./manifest.webmanifest','./icon-192.png','./icon-512.png'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key.startsWith('sol-fx-mobile-shell-') && key !== CACHE).map(key => caches.delete(key))
  )));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('./index.html')));
    return;
  }
  if (!ASSETS.some(p => new URL(p, self.registration.scope).href === url.href)) return;
  event.respondWith(caches.match(request).then(cached => cached || fetch(request)));
});

self.addEventListener('push', event => {
  // Safari requires a user-visible notification for a received Web Push.
  event.waitUntil((async () => {
    let msg = {};
    try { msg = event.data ? event.data.json() : {}; } catch (_) { msg = {}; }
    const valid = msg && typeof msg === 'object' && !Array.isArray(msg);
    const title = valid && typeof msg.title === 'string' ? msg.title.slice(0, 70) : 'SOL FX LAB';
    const body = valid && typeof msg.body === 'string' ? msg.body.slice(0, 200) : '通知を受信しました';
    const type = valid && msg.type === 'test' ? 'test' : 'signal';
    const options = {
      body,
      icon: './icon-192.png',
      badge: './icon-192.png',
      tag: valid && typeof msg.tag === 'string' ? msg.tag.slice(0, 110) : `solfx-${type}`,
      data: { url: new URL('./', self.registration.scope).href },
      renotify: false
    };
    await self.registration.showNotification(title, options);
  })());
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const url = new URL('./', self.registration.scope).href;
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) {
      if (client.url.startsWith(self.registration.scope)) {
        await client.focus();
        return;
      }
    }
    await clients.openWindow(url);
  })());
});
