/** Centre of the fleet's usual range, and a zoom wide enough to show all of South Africa at once. */
export const SOUTH_AFRICA: [number, number] = [-28.8, 24.5];
export const DEFAULT_ZOOM = 5;

/** Where a map is looking — shared between the global map and the movement map so switching between them doesn't reset the view. */
export interface MapViewState {
  center: [number, number];
  zoom: number;
}

export const DEFAULT_MAP_VIEW: MapViewState = { center: SOUTH_AFRICA, zoom: DEFAULT_ZOOM };
