// Estado de la aplicación. Mantiene todo en memoria (un historial de años son
// pocos MB) y persiste cada cambio en IndexedDB inmediatamente. Las lecturas
// nunca esperan a disco; las escrituras nunca esperan a la red.

import * as db from './db.js';
import {
  normalizeSet, newSession, closeSession, nextDayId, newId, localDate,
} from './model.js';
import { CATALOG, DAY_BY_ID, EXERCISE_BY_ID } from './catalog.js';

export const APP_VERSION = '1.0.0';
export const EXPORT_SCHEMA = 1;

export function createStore() {
  const listeners = new Set();
  const state = {
    ready: false,
    sets: [],
    sessions: [],
    measurements: [],
    activeSessionId: null,
    catalog: CATALOG,
  };

  let conn = null;

  function emit() {
    for (const fn of listeners) fn(state);
  }

  return {
    state,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    async init(indexedDBImpl) {
      conn = await db.openDb(indexedDBImpl);
      const [sets, sessions, measurements, activeSessionId] = await Promise.all([
        db.getAll(conn, db.STORES.sets),
        db.getAll(conn, db.STORES.sessions),
        db.getAll(conn, db.STORES.measurements),
        db.getMeta(conn, 'activeSessionId', null),
      ]);
      state.sets = sets;
      state.sessions = sessions;
      state.measurements = measurements;
      // Solo se considera activa si la sesión existe y sigue abierta.
      const active = sessions.find((s) => s.id === activeSessionId);
      state.activeSessionId = active && active.status === 'open' ? activeSessionId : null;
      state.ready = true;
      emit();
      return state;
    },

    // --- sesiones ---

    activeSession() {
      return state.sessions.find((s) => s.id === state.activeSessionId) || null;
    },

    /** Último día entrenado en cualquier sesión cerrada o abierta. */
    suggestedDayId() {
      const done = state.sessions
        .filter((s) => s.status !== 'discarded')
        .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
      const last = done.length ? done[done.length - 1] : null;
      if (last && last.status === 'open') return last.dayId;
      return nextDayId(CATALOG.sequence, last ? last.dayId : null);
    },

    async startSession(dayId) {
      const existing = this.activeSession();
      if (existing) return existing;
      const session = newSession({
        dayId,
        day: DAY_BY_ID[dayId],
        routineVersion: CATALOG.routineVersion,
      });
      state.sessions.push(session);
      state.activeSessionId = session.id;
      await db.put(conn, db.STORES.sessions, session);
      await db.setMeta(conn, 'activeSessionId', session.id);
      emit();
      return session;
    },

    /** Reabre una sesión cerrada (olvidaste una serie al terminar). */
    async reopenSession(sessionId) {
      const i = state.sessions.findIndex((s) => s.id === sessionId);
      if (i === -1) return null;
      state.sessions[i] = { ...state.sessions[i], status: 'open', endedAt: null };
      state.activeSessionId = sessionId;
      await db.put(conn, db.STORES.sessions, state.sessions[i]);
      await db.setMeta(conn, 'activeSessionId', sessionId);
      emit();
      return state.sessions[i];
    },

    async finishSession(status = 'completed') {
      const session = this.activeSession();
      if (!session) return null;
      const closed = closeSession(session, status);
      const i = state.sessions.findIndex((s) => s.id === session.id);
      state.sessions[i] = closed;
      state.activeSessionId = null;
      await db.put(conn, db.STORES.sessions, closed);
      await db.setMeta(conn, 'activeSessionId', null);
      emit();
      return closed;
    },

    /** Descarta una sesión vacía sin dejar basura en el historial. */
    async discardSession(sessionId) {
      const setsOfSession = state.sets.filter((s) => s.sessionId === sessionId);
      if (setsOfSession.length) return false;
      state.sessions = state.sessions.filter((s) => s.id !== sessionId);
      if (state.activeSessionId === sessionId) state.activeSessionId = null;
      await db.del(conn, db.STORES.sessions, sessionId);
      await db.setMeta(conn, 'activeSessionId', state.activeSessionId);
      emit();
      return true;
    },

    async setSessionNote(sessionId, note) {
      const i = state.sessions.findIndex((s) => s.id === sessionId);
      if (i === -1) return null;
      state.sessions[i] = { ...state.sessions[i], note: String(note || '').slice(0, 2000) };
      await db.put(conn, db.STORES.sessions, state.sessions[i]);
      emit();
      return state.sessions[i];
    },

    // --- series ---

    setsOfSession(sessionId) {
      return state.sets
        .filter((s) => s.sessionId === sessionId)
        .sort((a, b) => a.setIndex - b.setIndex || String(a.createdAt).localeCompare(String(b.createdAt)));
    },

    setsOfExerciseInSession(sessionId, exerciseId) {
      return this.setsOfSession(sessionId).filter((s) => s.exerciseId === exerciseId);
    },

    /** Guarda una serie. Nunca falla por validación: normaliza y persiste. */
    async saveSet(input) {
      const exercise = EXERCISE_BY_ID[input.exerciseId];
      const set = normalizeSet({
        ...input,
        exerciseName: input.exerciseName || (exercise ? exercise.name : input.exerciseId),
      });
      const i = state.sets.findIndex((s) => s.id === set.id);
      if (i === -1) state.sets.push(set);
      else state.sets[i] = { ...state.sets[i], ...set };
      await db.put(conn, db.STORES.sets, set);
      emit();
      return set;
    },

    async deleteSet(setId) {
      state.sets = state.sets.filter((s) => s.id !== setId);
      await db.del(conn, db.STORES.sets, setId);
      emit();
    },

    // --- medidas corporales ---

    async saveMeasurement({ type, value, unit, date, note }) {
      const row = {
        id: newId(),
        type: type || 'peso',
        value: Number(String(value).replace(',', '.')) || 0,
        unit: unit || (type === 'cintura' ? 'cm' : 'kg'),
        date: date || localDate(),
        note: String(note || '').slice(0, 300),
        createdAt: new Date().toISOString(),
      };
      // Una medida por tipo y día: re-pesarse el mismo día corrige, no duplica.
      const dupe = state.measurements.find((m) => m.type === row.type && m.date === row.date);
      if (dupe) {
        row.id = dupe.id;
        row.createdAt = dupe.createdAt;
        state.measurements = state.measurements.map((m) => (m.id === dupe.id ? row : m));
      } else {
        state.measurements.push(row);
      }
      await db.put(conn, db.STORES.measurements, row);
      emit();
      return row;
    },

    async deleteMeasurement(id) {
      state.measurements = state.measurements.filter((m) => m.id !== id);
      await db.del(conn, db.STORES.measurements, id);
      emit();
    },

    measurementsOfType(type) {
      return state.measurements
        .filter((m) => m.type === type)
        .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    },

    // --- respaldo / integración con el vault ---

    exportData() {
      return {
        schema: EXPORT_SCHEMA,
        appVersion: APP_VERSION,
        exportedAt: new Date().toISOString(),
        routineVersion: CATALOG.routineVersion,
        counts: {
          sessions: state.sessions.length,
          sets: state.sets.length,
          measurements: state.measurements.length,
        },
        sessions: state.sessions,
        sets: state.sets,
        measurements: state.measurements,
      };
    },

    /**
     * Importa un respaldo fusionando por id: reimportar el mismo archivo no
     * duplica nada y nunca borra lo que ya existe en el dispositivo.
     */
    async importData(payload) {
      if (!payload || typeof payload !== 'object') throw new Error('Archivo inválido');
      const report = { sessions: 0, sets: 0, measurements: 0, skipped: 0 };

      const mergeInto = async (arr, incoming, storeName, normalize) => {
        const byId = new Map(arr.map((x) => [x.id, x]));
        const toPut = [];
        for (const raw of incoming || []) {
          if (!raw || !raw.id) { report.skipped += 1; continue; }
          if (byId.has(raw.id)) { report.skipped += 1; continue; }
          const row = normalize ? normalize(raw) : raw;
          byId.set(row.id, row);
          arr.push(row);
          toPut.push(row);
        }
        await db.putMany(conn, storeName, toPut);
        return toPut.length;
      };

      report.sessions = await mergeInto(state.sessions, payload.sessions, db.STORES.sessions);
      report.sets = await mergeInto(state.sets, payload.sets, db.STORES.sets,
        (r) => normalizeSet({ ...r, createdAt: r.createdAt }));
      report.measurements = await mergeInto(state.measurements, payload.measurements, db.STORES.measurements);

      emit();
      return report;
    },

    async wipe() {
      await db.clearAll(conn);
      state.sets = [];
      state.sessions = [];
      state.measurements = [];
      state.activeSessionId = null;
      emit();
    },
  };
}
