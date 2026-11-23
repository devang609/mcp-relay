import type { ServerConfig, CallMetrics, CumulativeMetrics } from '../../shared/types.js';

const DB_NAME = 'mcprelay';
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('config')) {
        db.createObjectStore('config', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('servers')) {
        db.createObjectStore('servers', { keyPath: 'url' });
      }
      if (!db.objectStoreNames.contains('metrics')) {
        const store = db.createObjectStore('metrics', { keyPath: 'id', autoIncrement: true });
        store.createIndex('timestamp', 'timestamp');
      }
    };
  });
}

export async function getConfig(key: string): Promise<unknown> {
  try {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('config', 'readonly');
      const store = tx.objectStore('config');
      const request = store.get(key);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result?.value);
    });
  } catch {
    return undefined;
  }
}

export async function setConfig(key: string, value: unknown): Promise<void> {
  try {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('config', 'readwrite');
      const store = tx.objectStore('config');
      const request = store.put({ key, value });
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  } catch {
    // IndexedDB unavailable
  }
}

export async function getServers(): Promise<ServerConfig[]> {
  try {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('servers', 'readonly');
      const store = tx.objectStore('servers');
      const request = store.getAll();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result || []);
    });
  } catch {
    return [];
  }
}

export async function saveServer(config: ServerConfig): Promise<void> {
  try {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('servers', 'readwrite');
      const store = tx.objectStore('servers');
      const request = store.put(config);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  } catch {
    // IndexedDB unavailable
  }
}

export async function removeServer(url: string): Promise<void> {
  try {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('servers', 'readwrite');
      const store = tx.objectStore('servers');
      const request = store.delete(url);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  } catch {
    // IndexedDB unavailable
  }
}

export async function saveMetrics(metrics: CallMetrics): Promise<void> {
  try {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('metrics', 'readwrite');
      const store = tx.objectStore('metrics');
      const request = store.put(metrics);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  } catch {
    // IndexedDB unavailable
  }
}

export async function getCumulativeMetrics(): Promise<CumulativeMetrics> {
  try {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('metrics', 'readonly');
      const store = tx.objectStore('metrics');
      const request = store.getAll();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const rows: CallMetrics[] = request.result || [];
        const result: CumulativeMetrics = {
          tokensAvoided: 0,
          roundTripsEliminated: 0,
          timeSavedMs: 0,
          callsLocal: 0,
          callsTotal: rows.length,
        };
        for (const row of rows) {
          const classicTokens = row.catalogSize * 25; // rough estimate of tokens per tool schema
          const codeModeTokens = row.tokensIn + row.tokensOut;
          result.tokensAvoided += Math.max(0, classicTokens - codeModeTokens);
          result.roundTripsEliminated += Math.max(0, row.catalogSize - row.roundTrips);
          if (row.executionLocation === 'browser') {
            result.callsLocal++;
          }
        }
        resolve(result);
      };
    });
  } catch {
    return {
      tokensAvoided: 0,
      roundTripsEliminated: 0,
      timeSavedMs: 0,
      callsLocal: 0,
      callsTotal: 0,
    };
  }
}

export async function exportConfig(): Promise<string> {
  const servers = await getServers();
  const cloudKey = await getConfig('cloudApiKey') as string | undefined;
  const cloudProvider = await getConfig('cloudProvider') as string | undefined;
  return JSON.stringify({
    servers: servers.map(s => ({ url: s.url, name: s.name, enabled: s.enabled })),
    cloudProvider,
    // Never export the actual keys — the user re-enters them
  }, null, 2);
}

export async function importConfig(json: string): Promise<void> {
  const data = JSON.parse(json);
  if (data.servers) {
    for (const s of data.servers) {
      await saveServer({ ...s, apiKey: '' });
    }
  }
  if (data.cloudProvider) {
    await setConfig('cloudProvider', data.cloudProvider);
  }
}
