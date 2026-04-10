self.addEventListener('push', function(event) {
    const data = event.data ? event.data.json() : {};
    const title = data.title || 'House of Jokers';
    
    const options = {
        body: data.body || 'It is your turn!',
        icon: '/joker.jpg',
        badge: '/joker.jpg',
        vibrate: [200, 100, 200]
    };
    
    event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function(event) {
    event.notification.close();
    event.waitUntil(
        clients.openWindow('/')
    );
});
