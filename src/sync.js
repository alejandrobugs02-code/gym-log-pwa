// sync.js — Sincronización en segundo plano con buffer serverless.
//
// Operación transparente y local-first:
// - Gestiona la cola de salida (eventOutbox) de la PWA.
// - Divide en lotes seguros (< 25 eventos por request para no superar los 64 KB de WebKit en iOS Safari).
// - Maneja reintentos silenciosos y expone el estado de sincronización.
// - Soporta keepalive acotado en pagehide.

export const BATCH_SIZE_DEFAULT = 20;
export const BATCH_SIZE_KEEPALIVE = 12;

export const SYNC_STATUS = {
  SYNCED: 'synced',
  SYNCING: 'syncing',
  PENDING: 'pending',
  ERROR: 'error',
};

export const SYNC_BADGE = {
  [SYNC_STATUS.SYNCED]: '☁️✓',
  [SYNC_STATUS.SYNCING]: '☁️↑',
  [SYNC_STATUS.PENDING]: '☁️⏳',
  [SYNC_STATUS.ERROR]: '☁️⚠️',
};

export function syncBadgeText(status) {
  return SYNC_BADGE[status] || SYNC_BADGE[SYNC_STATUS.SYNCED];
}

class SyncManager {
  constructor() {
    this.status = SYNC_STATUS.SYNCED;
    this.lastError = null;
    this.lastSyncAt = null;
    this.isSyncing = false;
    this.listeners = new Set();
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify() {
    const info = this.getState();
    for (const fn of this.listeners) {
      try { fn(info); } catch (e) { /* noop */ }
    }
  }

  getState() {
    return {
      status: this.status,
      badge: syncBadgeText(this.status),
      lastError: this.lastError,
      lastSyncAt: this.lastSyncAt,
      isSyncing: this.isSyncing,
    };
  }

  setStatus(status, error = null) {
    this.status = status;
    if (error !== null) this.lastError = error;
    if (status === SYNC_STATUS.SYNCED) {
      this.lastError = null;
      this.lastSyncAt = new Date().toISOString();
    }
    this.notify();
  }

  /**
   * Envía los eventos pendientes en la outbox al backend configurado.
   * Silencioso ante fallos de red; nunca bloquea la interfaz de usuario.
   */
  async flush(store, { force = false, keepalive = false } = {}) {
    if (!store || !store.state) return { ok: false, reason: 'no-store' };

    const config = await store.getSyncConfig();
    const endpoint = (config.endpoint || '').trim().replace(/\/+$/, '');
    const token = (config.token || '').trim();

    const pendingCount = store.state.eventOutbox ? store.state.eventOutbox.length : 0;

    if (!endpoint || !token) {
      if (pendingCount > 0) {
        this.setStatus(SYNC_STATUS.PENDING);
      } else {
        this.setStatus(SYNC_STATUS.SYNCED);
      }
      return { ok: false, reason: 'unconfigured', pending: pendingCount };
    }

    if (pendingCount === 0) {
      this.setStatus(SYNC_STATUS.SYNCED);
      return { ok: true, sent: 0, pending: 0 };
    }

    if (this.isSyncing && !force) {
      return { ok: false, reason: 'already-syncing' };
    }

    this.isSyncing = true;
    this.setStatus(SYNC_STATUS.SYNCING);

    const batchLimit = keepalive ? BATCH_SIZE_KEEPALIVE : BATCH_SIZE_DEFAULT;
    let totalSent = 0;

    try {
      while (store.state.eventOutbox.length > 0) {
        const batch = store.state.eventOutbox.slice(0, batchLimit);
        const url = `${endpoint}/api/events`;

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({ events: batch }),
          keepalive: !!keepalive,
        });

        if (!response.ok) {
          let errText = `HTTP ${response.status}`;
          try {
            const errJson = await response.json();
            if (errJson && errJson.error) errText = errJson.error;
          } catch (_) { /* ignore */ }
          this.setStatus(SYNC_STATUS.ERROR, errText);
          return { ok: false, error: errText, sent: totalSent, remaining: store.state.eventOutbox.length };
        }

        const ids = batch.map((item) => item.id);
        await store.removeEventsFromOutbox(ids);
        totalSent += ids.length;

        // Si es keepalive, solo procesamos un lote por invocación de ciclo de vida
        if (keepalive) break;
      }

      if (store.state.eventOutbox.length === 0) {
        this.setStatus(SYNC_STATUS.SYNCED);
      } else {
        this.setStatus(SYNC_STATUS.PENDING);
      }

      return { ok: true, sent: totalSent, remaining: store.state.eventOutbox.length };
    } catch (err) {
      const msg = err && err.message ? err.message : 'Error de red';
      this.setStatus(SYNC_STATUS.ERROR, msg);
      return { ok: false, error: msg, sent: totalSent, remaining: store.state.eventOutbox.length };
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Verifica la conectividad y validez de credenciales con el worker.
   */
  async testConnection(endpoint, token) {
    const cleanEndpoint = (endpoint || '').trim().replace(/\/+$/, '');
    const cleanToken = (token || '').trim();
    if (!cleanEndpoint || !cleanToken) {
      return { ok: false, error: 'Endpoint y token requeridos' };
    }
    try {
      const response = await fetch(`${cleanEndpoint}/api/events/pending`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${cleanToken}`,
        },
      });
      if (response.status === 401) {
        return { ok: false, error: 'Token de sincronización no autorizado (HTTP 401)' };
      }
      if (!response.ok) {
        return { ok: false, error: `Servidor respondió con código ${response.status}` };
      }
      const data = await response.json();
      return { ok: true, pendingOnServer: data.count ?? data.events?.length ?? 0 };
    } catch (err) {
      return { ok: false, error: `No se pudo conectar: ${err.message}` };
    }
  }
}

export const syncManager = new SyncManager();

export function flushOutbox(store, options) {
  return syncManager.flush(store, options);
}

export function getSyncState() {
  return syncManager.getState();
}

export function onSyncChange(listener) {
  return syncManager.subscribe(listener);
}

export function testSyncConnection(endpoint, token) {
  return syncManager.testConnection(endpoint, token);
}
