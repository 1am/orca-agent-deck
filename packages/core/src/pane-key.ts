/** A pane key is `${tabId}:${leafId}`, stable across handle changes; it is stored and sent as is. */
export const paneKey = (tabId: string, leafId: string): string => `${tabId}:${leafId}`;

/** The two parts of a pane key; a missing part is an empty string. */
export function splitPaneKey(key: string): { tabId: string; leafId: string } {
  const [tabId = '', leafId = ''] = key.split(':');
  return { tabId, leafId };
}
