import type { StudyModel } from './contracts';

const DATABASE = 'chess-universe-v1';
const STORE = 'generated-studies';

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function readCachedStudy(address: string): Promise<StudyModel | null> {
  try {
    const db = await database();
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE).objectStore(STORE).get(address);
      request.onsuccess = () => resolve((request.result as StudyModel | undefined) ?? null);
      request.onerror = () => reject(request.error);
    });
  } catch { return null; }
}

export async function writeCachedStudy(address: string, study: StudyModel): Promise<void> {
  try {
    const db = await database();
    await new Promise<void>((resolve, reject) => {
      const request = db.transaction(STORE, 'readwrite').objectStore(STORE).put(study, address);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch { /* The local cache is optional. */ }
}
