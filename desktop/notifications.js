'use strict';

function createApprovalNotifier({ Notification, getWindow, isPending, isSupported }) {
  const active = new Map();

  function update() {
    for (const [key, { target, notification }] of active) {
      if (isPending(target)) continue;
      active.delete(key);
      notification.close();
    }
  }

  function notify(target) {
    const window = getWindow();
    if (!window || window.isDestroyed() || window.isFocused() || !isSupported()) return;
    const key = `${target.instanceId}:${target.requestId}`;
    if (active.has(key) || !isPending(target)) return;
    const notification = new Notification({
      title: 'Bridge approval needed',
      body: `Instance on port ${target.port} is waiting. Open Bridge Desktop to review.`
    });
    active.set(key, { target, notification });
    const forget = () => {
      if (active.get(key)?.notification === notification) active.delete(key);
    };
    notification.once('close', forget);
    notification.once('failed', forget);
    notification.once('click', () => {
      forget();
      const current = getWindow();
      if (!current || current.isDestroyed() || !isPending(target)) return;
      if (current.isMinimized()) current.restore();
      current.show();
      current.focus();
      current.webContents.send('bridge:focus-instance', target.instanceId);
    });
    try { notification.show(); } catch { forget(); }
  }

  return { notify, update };
}

module.exports = { createApprovalNotifier };
