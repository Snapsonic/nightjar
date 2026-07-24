/** Minimal typed event emitter (single event type per emitter). */
export class Emitter<T> {
  private readonly listeners = new Set<(value: T) => void>();

  /** Subscribe. Returns an unsubscribe function. */
  on(listener: (value: T) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(value: T): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(value);
      } catch {
        // Listener errors must never break the emitter.
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
