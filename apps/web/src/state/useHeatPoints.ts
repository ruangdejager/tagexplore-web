import { useEffect, useState } from 'react';
import type { GpsPoint } from '@tagexplore/core';
import * as api from '../api.js';

/**
 * Raw GPS fixes for the heatmap, refetched whenever the window or organisation
 * changes. Deliberately only active while the heatmap view is actually on —
 * every whitelisted tag's full reading history in a window is a much bigger
 * pull than the one-row-per-tag `/snapshots` the map normally shows, so there
 * is no reason to fetch it while nobody is looking at it.
 */
export function useHeatPoints(orgId: string | null, hours: number, enabled: boolean): GpsPoint[] {
  const [points, setPoints] = useState<GpsPoint[]>([]);

  useEffect(() => {
    if (!enabled) {
      setPoints([]);
      return;
    }

    let cancelled = false;
    api
      .fetchPositions(orgId, hours)
      .then((res) => {
        if (!cancelled) setPoints(res.points);
      })
      .catch(() => {
        if (!cancelled) setPoints([]);
      });
    return () => {
      cancelled = true;
    };
  }, [orgId, hours, enabled]);

  return points;
}
