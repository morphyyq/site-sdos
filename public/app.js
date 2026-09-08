const statusEl = document.querySelector('#status');
const button = document.querySelector('#subscribe');
const alertsEl = document.querySelector('#alerts');

function b64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map(char => char.charCodeAt(0)));
}

async function loadAlerts() {
  const response = await fetch('/api/alerts');
  const alerts = await response.json();
  alertsEl.innerHTML = alerts.length ? alerts.map(alert => `
    <article class="card alert">
      <strong>${escapeHtml(alert.text)}</strong><br>
      <time>${new Date(alert.createdAt).toLocaleString('ru-RU')} · ${escapeHtml(alert.city)}</time>
    </article>`).join('') : '<p class="muted">Сообщений пока нет.</p>';
}
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[c])); }

async function subscribe() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    statusEl.textContent = 'Этот браузер не поддерживает Web Push. На iPhone добавьте сайт на главный экран и откройте его оттуда.';
    return;
  }
  button.disabled = true;
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error('Разрешение на уведомления не выдано');
    const registration = await navigator.serviceWorker.register('/sw.js');
    const config = await (await fetch('/api/config')).json();
    if (!config.vapidPublicKey) throw new Error('На сервере ещё не настроены VAPID-ключи');
    const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToUint8Array(config.vapidPublicKey) });
    await fetch('/api/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(subscription) });
    statusEl.textContent = 'Готово. Вы подписаны на уведомления по Ялте.';
    button.textContent = 'Уведомления включены';
  } catch (error) {
    statusEl.textContent = error.message;
    button.disabled = false;
  }
}
button.addEventListener('click', subscribe);
loadAlerts().catch(() => { alertsEl.innerHTML = '<p class="muted">Не удалось загрузить сообщения.</p>'; });
