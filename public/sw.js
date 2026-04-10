self.addEventListener('push', function(event) {
    const data = event.data ? event.data.json() : {};
    const title = data.title || 'House of Jokers';
    
    const options = {
        body: data.body || 'It is your turn!',
        icon: '/joker.jpg',
        badge: '/joker.jpg',
        vibrate: [200, 100, 200],
        tag: 'hoj-turn', // Förhindrar notis-spam genom att ersätta den gamla notisen
        renotify: true
    };
    
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
            let isFocused = false;
            // Kolla om appen är öppen och spelaren faktiskt tittar på skärmen
            for (let client of windowClients) {
                if (client.focused) {
                    isFocused = true;
                    break;
                }
            }
            // Om de INTE har appen aktiv på skärmen -> visa notisen!
            if (!isFocused) {
                return self.registration.showNotification(title, options);
            }
        })
    );
});

self.addEventListener('notificationclick', function(event) {
    event.notification.close();
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
            // Om de redan har spelet i en flik i bakgrunden, hoppa till den!
            for (let client of windowClients) {
                if (client.url.includes('/') && 'focus' in client) {
                    return client.focus();
                }
            }
            // Annars, öppna en helt ny flik med spelet
            if (clients.openWindow) {
                return clients.openWindow('/');
            }
        })
    );
});
