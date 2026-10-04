'use strict';
// Stabile Instanz-Kennung (App-Setting `app.instance_id`). Beim ersten Lesen
// einmal zufaellig erzeugt und persistiert; danach unveraendert, auch ueber
// Umzug, Backup-Restore (liegt in der DB) und URL-Wechsel hinweg.

const crypto = require('crypto');
const appSettings = require('./app-settings');

function getInstanceId() {
  const cur = String(appSettings.get('app.instance_id') || '').trim();
  if (cur) return cur;
  const id = crypto.randomUUID();
  appSettings.set('app.instance_id', id, { updatedBy: 'system' });
  return id;
}

module.exports = { getInstanceId };
