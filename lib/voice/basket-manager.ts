import type { BasketItem, BasketSnapshot } from '@/lib/realtime/tool-protocol';

export type BasketStatus = 'editing' | 'ready_to_confirm' | 'confirmed';

export type CatalogEntry = {
  productId: string;
  name: string;
  price: number;
  available?: boolean;
};

export type OptimisticOperation =
  | { kind: 'add'; productId: string; quantity: number; customizations?: string[] }
  | { kind: 'remove'; productId: string; quantity?: number }
  | { kind: 'set_quantity'; productId: string; quantity: number };

export class BasketManager {
  private committedSnapshot: BasketSnapshot;
  private catalog: Map<string, CatalogEntry> = new Map();
  private pendingOperations = new Map<string, OptimisticOperation>();
  private changeListeners: Array<(snapshot: BasketSnapshot) => void> = [];

  constructor(restaurantId: string, catalog: CatalogEntry[] = [], initialSnapshot?: BasketSnapshot) {
    this.committedSnapshot = {
      restaurantId,
      items: initialSnapshot?.items ? initialSnapshot.items.map((item) => ({ ...item })) : [],
      total: initialSnapshot?.total ?? 0,
      status: initialSnapshot?.status ?? 'editing',
    };
    for (const entry of catalog) {
      this.catalog.set(entry.productId, entry);
    }
  }

  onChange(listener: (snapshot: BasketSnapshot) => void) {
    this.changeListeners.push(listener);
    return () => {
      const index = this.changeListeners.indexOf(listener);
      if (index >= 0) this.changeListeners.splice(index, 1);
    };
  }

  setCatalog(catalog: CatalogEntry[]) {
    this.catalog = new Map();
    for (const entry of catalog) {
      this.catalog.set(entry.productId, entry);
    }
  }

  getSnapshot(): BasketSnapshot {
    return this.recomputeSnapshot();
  }

  applyServerSnapshot(snapshot: BasketSnapshot) {
    this.committedSnapshot = {
      restaurantId: snapshot.restaurantId,
      items: Array.isArray(snapshot.items) ? snapshot.items.map((item) => ({ ...item })) : [],
      total: snapshot.total ?? 0,
      status: snapshot.status ?? 'editing',
    };
    this.pendingOperations.clear();
    this.emit();
  }

  applyOptimisticOperation(operationId: string, operation: OptimisticOperation) {
    if (this.pendingOperations.has(operationId)) return;
    this.pendingOperations.set(operationId, operation);
    this.emit();
  }

  rollbackOperation(operationId: string) {
    if (!this.pendingOperations.has(operationId)) return;
    this.pendingOperations.delete(operationId);
    this.emit();
  }

  setStatus(status: BasketStatus) {
    if (this.committedSnapshot.status === status) return;
    this.committedSnapshot.status = status;
    this.emit();
  }

  reset() {
    this.committedSnapshot = {
      restaurantId: this.committedSnapshot.restaurantId,
      items: [],
      total: 0,
      status: 'editing',
    };
    this.pendingOperations.clear();
    this.emit();
  }

  private recomputeSnapshot(): BasketSnapshot {
    let items = this.committedSnapshot.items.map((item) => ({ ...item }));

    for (const operation of this.pendingOperations.values()) {
      switch (operation.kind) {
        case 'add':
          items = this.applyAdd(items, operation);
          break;
        case 'remove':
          items = this.applyRemove(items, operation);
          break;
        case 'set_quantity':
          items = this.applySetQuantity(items, operation);
          break;
      }
    }

    const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0);

    return {
      restaurantId: this.committedSnapshot.restaurantId,
      items,
      total,
      status: this.committedSnapshot.status,
    };
  }

  private applyAdd(items: BasketItem[], operation: OptimisticOperation & { kind: 'add' }): BasketItem[] {
    const customizationKey = (operation.customizations ?? []).join('|');
    const existing = items.find(
      (item) => item.productId === operation.productId && (item.customizations ?? []).join('|') === customizationKey,
    );

    if (existing) {
      return items.map((item) =>
        item === existing ? { ...item, quantity: item.quantity + operation.quantity } : item,
      );
    }

    const catalogEntry = this.catalog.get(operation.productId);
    return [
      ...items,
      {
        id: `${operation.productId}-${items.length + 1}`,
        productId: operation.productId,
        name: catalogEntry?.name ?? operation.productId,
        detail: '',
        price: catalogEntry?.price ?? 0,
        quantity: operation.quantity,
        customizations: operation.customizations ?? [],
      },
    ];
  }

  private applyRemove(items: BasketItem[], operation: OptimisticOperation & { kind: 'remove' }): BasketItem[] {
    const targetQuantity = operation.quantity;
    const result: BasketItem[] = [];
    let removed = 0;

    for (const item of items) {
      if (item.productId === operation.productId && removed === 0) {
        const current = item.quantity;
        const toRemove = targetQuantity === undefined ? current : Math.min(targetQuantity, current);
        if (current > toRemove) {
          result.push({ ...item, quantity: current - toRemove });
        }
        removed = toRemove;
      } else {
        result.push(item);
      }
    }

    return result;
  }

  private applySetQuantity(items: BasketItem[], operation: OptimisticOperation & { kind: 'set_quantity' }): BasketItem[] {
    if (operation.quantity <= 0) {
      return items.filter((item) => item.productId !== operation.productId);
    }

    return items.map((item) =>
      item.productId === operation.productId ? { ...item, quantity: operation.quantity } : item,
    );
  }

  private emit() {
    const snapshot = this.getSnapshot();
    for (const listener of this.changeListeners) {
      try {
        listener(snapshot);
      } catch (error) {
        console.error('[basket-manager] listener error', error);
      }
    }
  }
}
