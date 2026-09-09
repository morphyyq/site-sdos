const statusEl = document.querySelector('#status');
const button = document.querySelector('#subscribe');
const alertsEl = document.querySelector('#alerts');

function b64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map(char => char.charCodeAt(0)));
}
function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[c]));
}
function formatDate(value) {
  return new Date(value).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });
}

async function loadAlerts() {
  const response = await fetch('/api/alerts');
  if (!response.ok) throw new Error('Не удалось загрузить сообщения');
  const alerts = await response.json();
  alertsEl.innerHTML = alerts.length ? alerts.map(alert => `
    <article class="panel alert">
      <div class="alert-text">${escapeHtml(alert.text)}</div>
      <div class="meta">${formatDate(alert.createdAt)} · Ялта</div>
    </article>`).join('') : '<div class="panel empty">Сообщений пока нет.</div>';
}

async function subscribe() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    statusEl.textContent = 'Браузер не поддерживает push. На iPhone добавьте сайт на главный экран и откройте его оттуда.';
    return;
  }
  button.disabled = true;
  button.textContent = 'Подключаем…';
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error('Разрешение на уведомления не выдано. Его можно включить в настройках браузера.');
    const registration = await navigator.serviceWorker.register('/sw.js');
    const config = await (await fetch('/api/config')).json();
    if (!config.vapidPublicKey) throw new Error('Push пока не настроен на сервере.');
    const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToUint8Array(config.vapidPublicKey) });
    const response = await fetch('/api/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(subscription) });
    if (!response.ok) throw new Error('Не удалось сохранить подписку.');
    statusEl.textContent = 'Готово. Теперь вы будете получать сообщения по Ялте.';
    button.textContent = 'Уведомления включены';
  } catch (error) {
    statusEl.textContent = error.message;
    button.disabled = false;
    button.textContent = 'Включить';
  }
}

button.addEventListener('click', subscribe);
loadAlerts().catch(() => { alertsEl.innerHTML = '<div class="panel empty">Не удалось загрузить сообщения.</div>'; });
