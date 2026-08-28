// Estado de la aplicación. Mantiene todo en memoria (un historial de años son
// pocos MB) y persiste cada cambio en IndexedDB inmediatamente. Las lecturas
// nunca esperan a disco; las escrituras nunca esperan a la red.

import * as db from './db.js';
import {
  normalizeSet, newSession, closeSession, nextDayId, newId, localDate,
} from './model.js';
import { CATALOG, DAY_BY_ID, EXERCISE_BY_ID } from './catalog.js';
import {
  annulEvent, measurementEvent, sessionEvent, setEvent, toNdjson,
} from './event-log.js';

export const APP_VERSION = '2.0.0';
export const EXPORT_SCHEMA = 1;

export function canonicalMeasurementType(type) {
  return ({ peso: 'weight', cintura: 'waist' })[type] || type || 'weight';
}

export function createStore() {
  const listeners = new Set();
  const state = {
    ready: false,
    sets: [],
    sessions: [],
    measurements: [],
    eventOutbox: [],
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
      const [sets, sessions, measurements, activeSessionId, lastExportAt, eventOutbox] = await Promise.all([
        db.getAll(conn, db.STORES.sets),
        db.getAll(conn, db.STORES.sessions),
        db.getAll(conn, db.STORES.measurements),
        db.getMeta(conn, 'activeSessionId', null),
        db.getMeta(conn, 'lastExportAt', null),
        db.getMeta(conn, 'eventOutbox', []),
      ]);
      state.sets = sets;
      state.sessions = sessions;
      state.measurements = measurements.map((row) => ({
        ...row,
        type: canonicalMeasurementType(row.type),
      }));
      const migratedMeasurements = state.measurements.filter((row, index) => (
        row.type !== measurements[index].type
      ));
      await db.putMany(conn, db.STORES.measurements, migratedMeasurements);
      state.lastExportAt = lastExportAt;
      state.eventOutbox = Array.isArray(eventOutbox) ? eventOutbox : [];
      // Solo se considera activa si la sesión existe y sigue abierta.
      const active = sessions.find((s) => s.id === activeSessionId);
      state.activeSessionId = active && active.status === 'open' ? activeSessionId : null;
      state.ready = true;
      emit();
      return state;
    },

    async queueEvent(item) {
      state.eventOutbox.push(item);
      await db.setMeta(conn, 'eventOutbox', state.eventOutbox);
      return item;
    },

    eventLogExport() {
      return {
        count: state.eventOutbox.length,
        ndjson: toNdjson(state.eventOutbox),
      };
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
      const logEvent = sessionEvent(session);
      session.logRef = logEvent.id;
      await db.put(conn, db.STORES.sessions, session);
      await this.queueEvent(logEvent);
      emit();
      return session;
    },

    /** Reabre una sesión cerrada (olvidaste una serie al terminar). */
    async reopenSession(sessionId) {
      const i = state.sessions.findIndex((s) => s.id === sessionId);
      if (i === -1) return null;
      const previous = state.sessions[i];
      state.sessions[i] = { ...previous, status: 'open', endedAt: null };
      const logEvent = sessionEvent(state.sessions[i], { op: 'corregir', ref: previous.logRef || previous.id });
      state.sessions[i].logRef = logEvent.id;
      state.activeSessionId = sessionId;
      await db.put(conn, db.STORES.sessions, state.sessions[i]);
      await db.setMeta(conn, 'activeSessionId', sessionId);
      await this.queueEvent(logEvent);
      emit();
      return state.sessions[i];
    },

    async finishSession(status = 'completed') {
      const session = this.activeSession();
      if (!session) return null;
      const closed = closeSession(session, status);
      const logEvent = sessionEvent(closed, { op: 'corregir', ref: session.logRef || session.id });
      closed.logRef = logEvent.id;
      const i = state.sessions.findIndex((s) => s.id === session.id);
      state.sessions[i] = closed;
      state.activeSessionId = null;
      await db.put(conn, db.STORES.sessions, closed);
      await db.setMeta(conn, 'activeSessionId', null);
      await this.queueEvent(logEvent);
      emit();
      return closed;
    },

    /** Descarta una sesión vacía sin dejar basura en el historial. */
    async discardSession(sessionId) {
      const setsOfSession = state.sets.filter((s) => s.sessionId === sessionId);
      if (setsOfSession.length) return false;
      const session = state.sessions.find((s) => s.id === sessionId);
      state.sessions = state.sessions.filter((s) => s.id !== sessionId);
      if (state.activeSessionId === sessionId) state.activeSessionId = null;
      await db.del(conn, db.STORES.sessions, sessionId);
      await db.setMeta(conn, 'activeSessionId', state.activeSessionId);
      if (session) await this.queueEvent(annulEvent({ tipo: 'sesion', fecha: session.date, ref: session.logRef || session.id }));
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
      const previous = state.sets.find((s) => s.id === input.id);
      const set = normalizeSet({
        ...input,
        exerciseName: input.exerciseName || (exercise ? exercise.name : input.exerciseId),
      });
      set.canonicalExerciseId = exercise ? exercise.id : set.exerciseId;
      set.routineVersion = input.routineVersion || previous?.routineVersion
        || this.activeSession()?.routineVersion || CATALOG.routineVersion;
      const logEvent = setEvent(set, previous
        ? { op: 'corregir', ref: previous.logRef || previous.id }
        : {});
      set.logRef = logEvent.id;
      const i = state.sets.findIndex((s) => s.id === set.id);
      if (i === -1) state.sets.push(set);
      else state.sets[i] = { ...state.sets[i], ...set };
      await db.put(conn, db.STORES.sets, set);
      await this.queueEvent(logEvent);
      emit();
      return set;
    },

    async deleteSet(setId) {
      const previous = state.sets.find((s) => s.id === setId);
      state.sets = state.sets.filter((s) => s.id !== setId);
      await db.del(conn, db.STORES.sets, setId);
      if (previous) await this.queueEvent(annulEvent({ tipo: 'serie', fecha: previous.date, ref: previous.logRef || previous.id }));
      emit();
    },

    // --- medidas corporales ---

    async saveMeasurement({ type, value, unit, date, note }) {
      const canonicalType = canonicalMeasurementType(type);
      const row = {
        id: newId(),
        type: canonicalType,
        value: Number(String(value).replace(',', '.')) || 0,
        unit: unit || (canonicalType === 'waist' ? 'cm' : 'kg'),
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
      const logEvent = measurementEvent(row, dupe
        ? { op: 'corregir', ref: dupe.logRef || dupe.id }
        : {});
      row.logRef = logEvent.id;
      await db.put(conn, db.STORES.measurements, row);
      await this.queueEvent(logEvent);
      emit();
      return row;
    },

    async deleteMeasurement(id) {
      const previous = state.measurements.find((m) => m.id === id);
      state.measurements = state.measurements.filter((m) => m.id !== id);
      await db.del(conn, db.STORES.measurements, id);
      if (previous) await this.queueEvent(annulEvent({ tipo: 'medida', fecha: previous.date, ref: previous.logRef || previous.id }));
      emit();
    },

    measurementsOfType(type) {
      const canonicalType = canonicalMeasurementType(type);
      return state.measurements
        .filter((m) => canonicalMeasurementType(m.type) === canonicalType)
        .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    },

    // --- respaldo / integración con el vault ---

    /**
     * Estado del respaldo. El único riesgo serio del diseño local-first es
     * perder el teléfono sin haber exportado, así que la app tiene que decirlo
     * en vez de confiar en que el usuario se acuerde.
     */
    backupStatus(now = Date.now()) {
      const last = state.lastExportAt;
      const pending = state.sessions.filter((s) => (
        s.status !== 'open' && (!last || String(s.startedAt) > String(last))
      )).length;
      const days = last ? Math.floor((now - new Date(last).getTime()) / 86400000) : null;
      // Con 6 días de rutina, 4 sesiones son ~4-5 días de entrenamiento.
      const overdue = pending >= 4 || (pending > 0 && days !== null && days >= 7);
      return { pending, days, lastExportAt: last, never: !last, overdue };
    },

    async markExported(when = new Date().toISOString()) {
      state.lastExportAt = when;
      await db.setMeta(conn, 'lastExportAt', when);
      emit();
      return when;
    },

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
        eventOutbox: state.eventOutbox,
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
      report.measurements = await mergeInto(
        state.measurements,
        payload.measurements,
        db.STORES.measurements,
        (row) => ({ ...row, type: canonicalMeasurementType(row.type) }),
      );

      emit();
      return report;
    },

    async wipe() {
      await db.clearAll(conn);
      state.sets = [];
      state.sessions = [];
      state.measurements = [];
      state.eventOutbox = [];
      state.activeSessionId = null;
      emit();
    },
  };
}
