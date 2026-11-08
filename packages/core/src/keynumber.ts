/** Native Stream Deck addressing: row-major, left to right, top to bottom, 1-based. */
export function keyNumber(coordinates: { column: number; row: number }, columns: number): number {
  return coordinates.row * columns + coordinates.column + 1;
}

/** `5` on single-page profiles, `2·5` when a page is known. */
export function formatKeyNumber(key: number, page?: number | null): string {
  return page ? `${page}·${key}` : String(key);
}
