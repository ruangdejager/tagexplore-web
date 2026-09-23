import { describe, expect, it, vi } from 'vitest';
import { createLiveBus, type LiveEvent } from '../src/events/bus.js';

function event(patch: Partial<LiveEvent> = {}): LiveEvent {
  return { type: 'readings', orgId: 'org-a', imei: '866049074634379', at: 1_787_911_200_000, ...patch };
}

describe('createLiveBus', () => {
  it('delivers only to subscribers of the same organisation', () => {
    const bus = createLiveBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.subscribe('org-a', a);
    bus.subscribe('org-b', b);

    bus.publish(event({ orgId: 'org-a' }));

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
  });

  it('delivers to every subscriber of one organisation', () => {
    const bus = createLiveBus();
    const first = vi.fn();
    const second = vi.fn();
    bus.subscribe('org-a', first);
    bus.subscribe('org-a', second);

    bus.publish(event());

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(bus.subscriberCount('org-a')).toBe(2);
  });

  it('stops delivering once unsubscribed, and forgets the organisation', () => {
    const bus = createLiveBus();
    const listener = vi.fn();
    const off = bus.subscribe('org-a', listener);

    off();
    // Twice, because a closed connection can clean up more than once and that
    // must not throw or corrupt the set.
    off();
    bus.publish(event());

    expect(listener).not.toHaveBeenCalled();
    expect(bus.subscriberCount('org-a')).toBe(0);
  });

  it('does not let one broken subscriber break the publisher or the others', () => {
    // This is the one that matters: `publish` is called from inside ingest
    // transactions, so a wedged SSE connection must never be able to fail a
    // write.
    const bus = createLiveBus();
    const broken = vi.fn(() => {
      throw new Error('this connection is gone');
    });
    const healthy = vi.fn();
    bus.subscribe('org-a', broken);
    bus.subscribe('org-a', healthy);

    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => bus.publish(event())).not.toThrow();
    expect(healthy).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it('survives a subscriber that unsubscribes itself while being notified', () => {
    const bus = createLiveBus();
    const other = vi.fn();
    const off = bus.subscribe('org-a', () => off());
    bus.subscribe('org-a', other);

    expect(() => bus.publish(event())).not.toThrow();
    expect(other).toHaveBeenCalledTimes(1);
    expect(bus.subscriberCount('org-a')).toBe(1);
  });

  it('reports no subscribers for an organisation nobody is watching', () => {
    expect(createLiveBus().subscriberCount('org-a')).toBe(0);
  });
});
