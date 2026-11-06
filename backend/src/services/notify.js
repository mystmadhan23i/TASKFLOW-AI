import Notification from '../models/Notification.js';

/** Create notifications, skipping the actor and duplicate recipients. Never throws. */
export async function notify(recipients, { actor, type, title, message = '', link = '' }) {
  try {
    const unique = [...new Set((Array.isArray(recipients) ? recipients : [recipients])
      .filter(Boolean).map(String))].filter((id) => id !== String(actor));
    if (!unique.length) return;
    await Notification.insertMany(unique.map((user) => ({ user, actor, type, title, message: message.slice(0, 500), link })));
  } catch (err) {
    console.error('notify failed', err.message);
  }
}
