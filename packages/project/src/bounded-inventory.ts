/** Keep the best candidates seen so far without accumulating an unbounded inventory. */
export class BoundedInventory<T> {
  readonly items: T[] = [];
  truncated = false;
  private readonly keys = new Set<string>();

  constructor(private readonly limit: number, private readonly compare: (left: T, right: T) => number, private readonly key: (item: T) => string) {}

  add(item: T): void {
    const key = this.key(item);
    if (this.keys.has(key)) return;
    if (this.items.length === this.limit) {
      this.truncated = true;
      if (this.compare(item, this.items[this.items.length - 1]!) >= 0) return;
    }
    let low = 0;
    let high = this.items.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.compare(item, this.items[middle]!) < 0) high = middle;
      else low = middle + 1;
    }
    this.items.splice(low, 0, item);
    this.keys.add(key);
    if (this.items.length > this.limit) this.keys.delete(this.key(this.items.pop()!));
  }
}
