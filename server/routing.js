import { cityKey, haversine, resolve } from './estimates.js';
import { deliveryLegs, getDistance, setDistance, touchRevision } from './store.js';

const ROUTE_API = (process.env.ROUTE_API ?? 'https://router.project-osrm.org').replace(/\/+$/, '');
const REQUEST_TIMEOUT_MS = 8000;
const REQUEST_GAP_MS = 150;
const MAX_PER_RUN = 300;

let running = false;

async function roadKm(a, b) {
  const [lat1, lon1] = a;
  const [lat2, lon2] = b;
  const url = `${ROUTE_API}/route/v1/driving/${lon1},${lat1};${lon2},${lat2}?overview=false`;
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = await response.json();
    const meters = body?.routes?.[0]?.distance;
    if (!Number.isFinite(meters) || meters <= 0) return null;
    const km = meters / 1000;
    const straight = haversine(a, b);
    if (straight > 1 && km > straight * 6) return null;
    return km;
  } catch {
    return null;
  }
}

export async function fillMissingDistances() {
  if (running) return { skipped: true };
  running = true;
  let fetched = 0;
  let failed = 0;
  try {
    const pending = new Map();
    const byOrder = new Map();
    for (const row of deliveryLegs()) {
      if (!byOrder.has(row.order_id)) byOrder.set(row.order_id, []);
      byOrder.get(row.order_id).push(row);
    }
    for (const list of byOrder.values()) {
      let prev = null;
      for (const delivery of list) {
        const place = resolve(delivery.city, delivery.uf);
        if (prev && place && delivery.city) {
          const aKey = cityKey(prev.city, prev.uf);
          const bKey = cityKey(delivery.city, place.uf ?? delivery.uf);
          const pairKey = `${aKey}>${bKey}`;
          if (aKey !== bKey && !pending.has(pairKey) && !getDistance(aKey, bKey)) {
            pending.set(pairKey, { aKey, bKey, a: prev.point, b: place.point });
          }
        }
        if (place)
          prev = {
            point: place.point,
            city: delivery.city,
            uf: place.uf ?? delivery.uf,
          };
      }
    }

    const queue = [...pending.values()].slice(0, MAX_PER_RUN);
    for (const item of queue) {
      const km = await roadKm(item.a, item.b);
      if (km == null) failed += 1;
      else {
        setDistance(item.aKey, item.bKey, km, 'rota');
        fetched += 1;
      }
      await new Promise((resolveGap) => setTimeout(resolveGap, REQUEST_GAP_MS));
    }
    const remaining = pending.size - queue.length;
    if (fetched > 0) touchRevision();
    console.log(
      `Distâncias rodoviárias: ${fetched} calculadas, ${failed} sem resposta` +
        (remaining > 0 ? `, ${remaining} ficaram para a próxima leitura` : ''),
    );
    return { fetched, failed, remaining };
  } finally {
    running = false;
  }
}
