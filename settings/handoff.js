/**
 * One-shot hand-off of a PDF the user picked or dropped in the popup to a viewer tab.
 * The popup closes as soon as it loses focus, so a blob: URL made there would die with
 * it. Instead the file is parked in IndexedDB (shared by every page of the extension)
 * under a random key; the viewer takes it and deletes it. Nothing leaves the device.
 */

const DB_NAME = 'nivra-handoff';
const STORE = 'files';

function _open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function _tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const result = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(result?.result);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

/** Store a File; returns the key to put in viewer.html?idb=<key>. */
export async function putFile(file) {
  const key = crypto.randomUUID();
  const db = await _open();
  await _tx(db, 'readwrite', s => s.put({ name: file.name, blob: file, at: Date.now() }, key));
  db.close();
  return key;
}

/** Fetch and delete a parked file. Returns {name, blob} or null. */
export async function takeFile(key) {
  if (!/^[0-9a-f-]{36}$/i.test(key || '')) return null;
  const db = await _open();
  const entry = await _tx(db, 'readonly', s => s.get(key));
  if (entry) await _tx(db, 'readwrite', s => s.delete(key));
  // Sweep anything abandoned (a tab that never opened) older than a day.
  await _tx(db, 'readwrite', s => {
    const cur = s.openCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return;
      if (Date.now() - (c.value?.at || 0) > 864e5) c.delete();
      c.continue();
    };
    return cur;
  }).catch(() => {});
  db.close();
  return entry ? { name: entry.name, blob: entry.blob } : null;
}
