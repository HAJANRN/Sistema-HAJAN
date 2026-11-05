import Dexie, { type Table } from 'dexie';
import type { AttachmentJob, Order, OutboxEntry } from './types';

class ExpedicaoDB extends Dexie {
  orders!: Table<Order, string>;
  outbox!: Table<OutboxEntry, number>;
  meta!: Table<{ key: string; value: string }, string>;
  files!: Table<AttachmentJob, number>;

  constructor() {
    super('expedicao-pedidos');
    this.version(1).stores({
      orders: 'id, deliveryDate, type, route, number',
      outbox: '++id, orderId, queuedAt',
      meta: 'key',
    });
    this.version(2).stores({
      files: '++id, orderId, queuedAt',
    });
  }
}

export const db = new ExpedicaoDB();
