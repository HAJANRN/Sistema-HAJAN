import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDistance, getEtaSettings } from './store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const COORDS_FILE = path.join(here, 'data', 'municipios.json');

const START_HOUR = 6;
const END_HOUR = 18;
const ROAD_FACTOR = 1.25;

let coords = null;
const byName = new Map();

const norm = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function load() {
  if (coords) return;
  coords = JSON.parse(fs.readFileSync(COORDS_FILE, 'utf8'));
  for (const [key, point] of Object.entries(coords)) {
    const [name, uf] = key.split('|');
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push({ point, uf });
  }
}

export function cityKey(city, uf) {
  return `${norm(city)}|${String(uf ?? '')
    .trim()
    .toUpperCase()}`;
}

export function resolve(city, uf) {
  load();
  const name = norm(city);
  if (!name) return null;
  const state = String(uf ?? '')
    .trim()
    .toUpperCase();
  if (state && coords[`${name}|${state}`]) return { point: coords[`${name}|${state}`], uf: state };
  const matches = byName.get(name);
  return matches?.length === 1 ? matches[0] : null;
}

const EARTH_KM = 6371;

export function haversine([lat1, lon1], [lat2, lon2]) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(a));
}

const pad = (value) => String(value).padStart(2, '0');
const toLocalISO = (date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;

const HOUR_MS = 3600 * 1000;

const startOfDay = (date) => {
  const next = new Date(date);
  next.setHours(START_HOUR, 0, 0, 0);
  return next;
};

const isWeekend = (date) => date.getDay() === 0 || date.getDay() === 6;

function nextWorkdayStart(date) {
  const next = startOfDay(date);
  while (isWeekend(next)) next.setDate(next.getDate() + 1);
  return next;
}

function clampToWindow(date) {
  if (isWeekend(date)) return nextWorkdayStart(date);
  const hour = date.getHours() + date.getMinutes() / 60;
  if (hour > END_HOUR) {
    const next = startOfDay(date);
    next.setDate(next.getDate() + 1);
    return nextWorkdayStart(next);
  }
  if (hour < START_HOUR) return startOfDay(date);
  return date;
}

export function estimateDeliveries(order) {
  const list = [...order.deliveries].sort((a, b) => a.seq - b.seq);
  if (!order.deliveryDate) return list.map((delivery) => ({ seq: delivery.seq, eta: null }));
  const { speedKmh, stopMinutes } = getEtaSettings();
  const stopHours = stopMinutes / 60;
  let clock = clampToWindow(new Date(`${order.deliveryDate}T${pad(START_HOUR)}:00:00`));
  let previous = null;
  let prevMeta = null;

  return list.map((delivery, index) => {
    const place = resolve(delivery.city, delivery.uf);
    const point = place?.point ?? null;
    const uf = place?.uf ?? delivery.uf;
    const anchor = delivery.scheduledAt
      ? clampToWindow(new Date(`${delivery.scheduledAt}T${pad(START_HOUR)}:00:00`))
      : null;
    if (index === 0) {
      if (anchor) clock = anchor;
      previous = point;
      prevMeta = { city: delivery.city, uf };
      return { seq: delivery.seq, eta: toLocalISO(clock), uf };
    }
    if (previous && point) {
      const road = getDistance(cityKey(prevMeta.city, prevMeta.uf), cityKey(delivery.city, uf));
      const km = road?.km ?? haversine(previous, point) * ROAD_FACTOR;
      clock =
        anchor ?? clampToWindow(new Date(clock.getTime() + (km / speedKmh + stopHours) * HOUR_MS));
      previous = point;
      prevMeta = { city: delivery.city, uf };
      return { seq: delivery.seq, eta: toLocalISO(clock), uf };
    }
    clock = anchor ?? clampToWindow(new Date(clock.getTime() + stopHours * HOUR_MS));
    if (point) {
      previous = point;
      prevMeta = { city: delivery.city, uf };
    }
    return { seq: delivery.seq, eta: anchor ? toLocalISO(anchor) : null, uf };
  });
}

export function withEstimates(order) {
  if (!order) return order;
  const rows = new Map(estimateDeliveries(order).map((item) => [item.seq, item]));
  return {
    ...order,
    deliveries: order.deliveries.map((delivery) => {
      const row = rows.get(delivery.seq);
      return { ...delivery, uf: row?.uf ?? delivery.uf, eta: row?.eta ?? null };
    }),
  };
}
