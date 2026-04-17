importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: 'AIzaSyDlzuMEutA5yDZLpRG62WEuxBQmi6y_tq0',
  authDomain: 'luxridesreservas-d5102.firebaseapp.com',
  databaseURL: 'https://luxridesreservas-d5102-default-rtdb.firebaseio.com',
  projectId: 'luxridesreservas-d5102',
  storageBucket: 'luxridesreservas-d5102.firebasestorage.app',
  messagingSenderId: '731425344327',
  appId: '1:731425344327:web:3ef04d1320750cd6e6da62'
});

const messaging = firebase.messaging();

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

messaging.onBackgroundMessage((payload) => {
  const notification = payload?.notification || {};
  const data = payload?.data || {};
  const notificationTitle = notification.title || 'Nuevo viaje LuxRides';
  const notificationOptions = {
    body: notification.body || data.body || 'Hay un servicio esperando.',
    icon: './luxrides-driver-icon.svg',
    badge: './luxrides-driver-icon.svg',
    vibrate: [200, 100, 200, 100, 300],
    tag: data.tag || 'luxrides-viaje-push',
    renotify: true,
    requireInteraction: true,
    data: {
      url: data.click_action || data.url || self.location.origin
    }
  };

  self.registration.showNotification(notificationTitle, notificationOptions);
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const targetUrl = event.notification?.data?.url || self.location.origin;

  event.waitUntil((async () => {
    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientList) {
      if ('focus' in client) {
        await client.focus();
        if ('navigate' in client && targetUrl) {
          await client.navigate(targetUrl);
        }
        return;
      }
    }

    if (self.clients.openWindow) {
      await self.clients.openWindow(targetUrl);
    }
  })());
});