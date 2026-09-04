import {
  GRAPH_ANALYSIS_VERSION,
  type StudyModel,
  type WinProbability,
} from './contracts';

const DATABASE = 'chesspermutations-v1';
const STUDY_STORE = 'generated-studies';
const PROBABILITY_STORE = 'graph-analysis';

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STUDY_STORE))
        request.result.createObjectStore(STUDY_STORE);
      if (!request.result.objectStoreNames.contains(PROBABILITY_STORE))
        request.result.createObjectStore(PROBABILITY_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function readCachedStudy(
  address: string,
): Promise<StudyModel | null> {
  try {
    const db = await database();
    return await new Promise((resolve, reject) => {
      const request = db
        .transaction(STUDY_STORE)
        .objectStore(STUDY_STORE)
        .get(address);
      request.onsuccess = () =>
        resolve((request.result as StudyModel | undefined) ?? null);
      request.onerror = () => reject(request.error);
    });
  } catch {
    return null;
  }
}

export async function writeCachedStudy(
  address: string,
  study: StudyModel,
): Promise<void> {
  try {
    const db = await database();
    await new Promise<void>((resolve, reject) => {
      const request = db
        .transaction(STUDY_STORE, 'readwrite')
        .objectStore(STUDY_STORE)
        .put(study, address);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch {
    /* The local cache is optional. */
  }
}

export function probabilityCacheKey(nodeId: string): string {
  return `${GRAPH_ANALYSIS_VERSION}:${nodeId}`;
}

export async function readCachedProbabilities(
  nodeIds: readonly string[],
): Promise<Record<string, WinProbability>> {
  if (!nodeIds.length) return {};
  try {
    const db = await database();
    const transaction = db.transaction(PROBABILITY_STORE);
    const store = transaction.objectStore(PROBABILITY_STORE);
    const entries = await Promise.all(
      nodeIds.map(
        (nodeId) =>
          new Promise<[string, WinProbability | undefined]>(
            (resolve, reject) => {
              const request = store.get(probabilityCacheKey(nodeId));
              request.onsuccess = () =>
                resolve([nodeId, request.result as WinProbability | undefined]);
              request.onerror = () => reject(request.error);
            },
          ),
      ),
    );
    return Object.fromEntries(
      entries.filter((entry): entry is [string, WinProbability] =>
        Boolean(entry[1]),
      ),
    );
  } catch {
    return {};
  }
}

export async function writeCachedProbabilities(
  probabilities: Readonly<Record<string, WinProbability>>,
): Promise<void> {
  const entries = Object.entries(probabilities);
  if (!entries.length) return;
  try {
    const db = await database();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(PROBABILITY_STORE, 'readwrite');
      const store = transaction.objectStore(PROBABILITY_STORE);
      entries.forEach(([nodeId, probability]) =>
        store.put(probability, probabilityCacheKey(nodeId)),
      );
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } catch {
    /* The local probability cache is optional. */
  }
}
