import type { BusinessServerEvent, EventMetadata } from "@paper/shared";

export interface Clock {
  now(): string;
}

export interface IdGenerator {
  next(): string;
}

export type Audience = { kind: "public" } | { kind: "user"; userId: string };

type WithoutMetadata<T> = T extends BusinessServerEvent
  ? Omit<T, keyof EventMetadata>
  : never;

export type EventDraft = WithoutMetadata<BusinessServerEvent> & {
  audience: Audience;
};

export type JournalEvent = BusinessServerEvent & {
  audience: Audience;
};

export type EventSubscriber = (event: JournalEvent) => void;

const defaultClock: Clock = {
  now: () => new Date().toISOString()
};

const defaultIds: IdGenerator = {
  next: () => crypto.randomUUID()
};

const clone = <T>(value: T): T => structuredClone(value);

export class EventJournal {
  private version = 0;
  private readonly subscribers = new Set<EventSubscriber>();
  private readonly deliveryQueue: JournalEvent[][] = [];
  private delivering = false;

  constructor(
    private readonly clock: Clock = defaultClock,
    private readonly ids: IdGenerator = defaultIds
  ) {}

  get currentVersion(): number {
    return this.version;
  }

  subscribe(subscriber: EventSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  publish(drafts: readonly EventDraft[]): JournalEvent[] {
    const occurredAt = this.clock.now();
    const firstVersion = this.version + 1;
    const events = drafts.map((draft, index) => ({
      ...clone(draft),
      eventId: this.ids.next(),
      stateVersion: firstVersion + index,
      occurredAt
    })) as JournalEvent[];

    if (events.length > 0) {
      this.version = events[events.length - 1]!.stateVersion;
    }

    if (events.length > 0) {
      this.deliveryQueue.push(events);
      this.drainDeliveryQueue();
    }

    return clone(events);
  }

  private drainDeliveryQueue(): void {
    if (this.delivering) return;

    this.delivering = true;
    try {
      let events = this.deliveryQueue.shift();
      while (events !== undefined) {
        for (const event of events) {
          for (const subscriber of this.subscribers) {
            try {
              subscriber(clone(event));
            } catch {
              // A transport subscriber cannot make an already committed command fail.
            }
          }
        }
        events = this.deliveryQueue.shift();
      }
    } finally {
      this.delivering = false;
    }
  }
}
