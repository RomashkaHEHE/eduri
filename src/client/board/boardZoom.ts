export const MIN_BOARD_ZOOM = 0.02;
export const MAX_BOARD_ZOOM = 20;

export function clampBoardZoom(zoom: number): number {
  return Math.max(MIN_BOARD_ZOOM, Math.min(MAX_BOARD_ZOOM, zoom));
}
