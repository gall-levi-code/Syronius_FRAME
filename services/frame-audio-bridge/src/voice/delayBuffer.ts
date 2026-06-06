export interface DelayedItem<T> {
  availableAt: number;
  value: T;
}

export class DelayBuffer<T> {
  private readonly items: DelayedItem<T>[] = [];

  public push(value: T, delayMs: number, now = Date.now()): void {
    this.items.push({
      value,
      availableAt: now + Math.max(0, delayMs),
    });
  }

  public drainReady(now = Date.now()): T[] {
    const ready: T[] = [];
    let index = 0;

    while (index < this.items.length) {
      const item = this.items[index];
      if (item.availableAt <= now) {
        ready.push(item.value);
        this.items.splice(index, 1);
      } else {
        index += 1;
      }
    }

    return ready;
  }

  public popReady(now = Date.now()): T | null {
    const readyIndex = this.items.findIndex((item) => item.availableAt <= now);
    if (readyIndex === -1) {
      return null;
    }

    const [item] = this.items.splice(readyIndex, 1);
    return item.value;
  }

  public clear(): void {
    this.items.length = 0;
  }
}
