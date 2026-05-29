// StudyDesk Service Worker — handles push notifications and offline caching
const CACHE = 'studydesk-v1';
const ASSETS = ['/', '/index.html', '/manifest.json'];

// ── Install: cache app shell ───────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS).catch(() => {}))
  );
  self.skipWaiting();
});

// ── Activate: clean old caches ─────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
  // Check for due tasks when SW activates (app opened / resumed)
  checkAndNotify();
});

// ── Fetch: serve from cache, fall back to network ─────────────────────
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request).then(resp => {
      if (resp && resp.status === 200) {
        const clone = resp.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
      }
      return resp;
    })).catch(() => caches.match('/index.html'))
  );
});

// ── Push: receive server push (future Supabase integration) ───────────
self.addEventListener('push', e => {
  let data = { title: 'StudyDesk', body: 'You have a reminder.' };
  try { data = e.data ? e.data.json() : data; } catch {}
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: data.tag || 'studydesk',
      data: data,
      vibrate: [200, 100, 200],
      actions: [
        { action: 'open', title: 'Open StudyDesk' },
        { action: 'dismiss', title: 'Dismiss' }
      ]
    })
  );
});

// ── Notification click ─────────────────────────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  if (e.action === 'dismiss') return;
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const existing = list.find(c => c.url.includes(self.location.origin));
      if (existing) return existing.focus();
      return clients.openWindow('/');
    })
  );
});

// ── Local scheduled notifications ─────────────────────────────────────
// Called when SW activates — reads tasks from IDB/message, fires notifications
function checkAndNotify() {
  // Ask the page for task data via message
  self.clients.matchAll({ type: 'window' }).then(list => {
    list.forEach(c => c.postMessage({ type: 'REQUEST_TASK_CHECK' }));
  });
}

// ── Message from page: task data for notification check ───────────────
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'TASK_CHECK') {
    const tasks = e.data.tasks || [];
    const settings = e.data.settings || {};
    if (!settings.enabled) return;
    const today = new Date(); today.setHours(0, 0, 0, 0);

    tasks.filter(t => !t.done).forEach(t => {
      const due = new Date(t.date); due.setHours(0, 0, 0, 0);
      const diff = Math.round((due - today) / 86400000);
      let title = null, body = null;

      if (settings.overdue && diff < 0) {
        title = `Overdue: ${t.name}`;
        body = `${t.subject} was due ${Math.abs(diff)} day${Math.abs(diff) > 1 ? 's' : ''} ago`;
      } else if (settings.today && diff === 0) {
        title = `Due today: ${t.name}`;
        body = `${t.subject} is due today`;
      } else if (settings.tomorrow && diff === 1) {
        title = `Due tomorrow: ${t.name}`;
        body = `${t.subject} is due tomorrow`;
      } else if (settings.advance > 0 && diff === settings.advance) {
        title = `Coming up: ${t.name}`;
        body = `${t.subject} is due in ${diff} days`;
      }

      if (title) {
        self.registration.showNotification(title, {
          body,
          icon: '/icon-192.png',
          tag: `task-${t.id}`,
          vibrate: [200, 100, 200],
          data: { taskId: t.id }
        });
      }
    });
  }

  // Schedule daily check alarm
  if (e.data && e.data.type === 'SCHEDULE_CHECK') {
    // Store the next check time — SW will check on next activation
    // (Full background scheduling requires periodic sync API)
    const time = e.data.time || '07:30';
    const [h, m] = time.split(':').map(Number);
    const now = new Date();
    const next = new Date(); next.setHours(h, m, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    const ms = next - now;
    // Can't use setTimeout reliably in SW — we fire check on SW activation
    // and when the app sends TASK_CHECK. For true scheduled push, use Supabase.
  }
});
