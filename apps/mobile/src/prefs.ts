import { useCallback, useState } from 'react';

/**
 * A setting remembered on this phone only (localStorage). Storage can be
 * blocked (private mode), in which case the setting just isn't remembered.
 * An object setting is merged over its default, so a field added later
 * starts at its default instead of undefined.
 */
export function usePref<T>(key: string, fallback: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return fallback;
      const parsed = JSON.parse(raw) as T;
      return isPlainObject(fallback) && isPlainObject(parsed) ? { ...fallback, ...parsed } : parsed;
    } catch {
      return fallback;
    }
  });
  const set = useCallback(
    (next: T) => {
      setValue(next);
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Not remembered.
      }
    },
    [key],
  );
  return [value, set];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
