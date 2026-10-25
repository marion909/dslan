// Service worker: shows push notifications and opens the game when one is tapped.
self.addEventListener('push', function (event) {
  var data = {};
  try { data = event.data.json(); } catch (e) { data = { title: 'TWLan', body: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(data.title || 'TWLan', {
    body: data.body || '', tag: data.tag || 'twlan', icon: '/icon-192.png', badge: '/icon-192.png', data: { url: data.url || '/page/play' }
  }));
});
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || '/page/play';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      if ('focus' in list[i]) { if ('navigate' in list[i]) list[i].navigate(url); return list[i].focus(); }
    }
    return self.clients.openWindow(url);
  }));
});
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) { event.waitUntil(self.clients.claim()); });
