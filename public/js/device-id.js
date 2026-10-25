// Stabile Device-ID pro Browser-Profil. localStorage ueberlebt Reloads, trennt
// Browser-Profile/Geraete sauber. Beim ersten Aufruf wird eine UUID generiert;
// spaeter wiederverwendet — selber Browser = selbes Device. SSoT fuer alle
// Konsumenten (Collab-Presence + Page-Save-Body), damit der geraete-bewusste
// /changes-Feed eigene Browser-Saves korrekt vom Echo anderer Geraete trennt.

import { uuid } from './utils/uuid.js';

const DEVICE_ID_KEY = 'sw_device_id';
let _cachedDeviceId = null;

export function getDeviceId() {
  if (_cachedDeviceId) return _cachedDeviceId;
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      id = uuid();
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    _cachedDeviceId = id;
    return id;
  } catch {
    // Safari Private Mode etc. — Ephemeral-UUID pro Session, kein Persist.
    if (!_cachedDeviceId) _cachedDeviceId = uuid();
    return _cachedDeviceId;
  }
}
