// Minimal IndexedDB KV with localStorage fallback.
// Stores { value, savedAt } and supports TTL on get.

const DB_NAME = 'ffw-cache'
const STORE = 'kv'
let dbPromise: Promise<IDBDatabase> | null = null

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE)
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    } catch (e) {
      reject(e)
    }
  })
  return dbPromise
}

export async function kvSet<T>(key: string, value: T): Promise<void> {
  try {
    const db = await openDB()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put({ value, savedAt: Date.now() }, key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch {
    try {
      localStorage.setItem(`kv:${key}`, JSON.stringify({ value, savedAt: Date.now() }))
    } catch {}
  }
}

export async function kvGet<T>(key: string, maxAgeMs?: number): Promise<T | null> {
  try {
    const db = await openDB()
    const entry = await new Promise<any>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(key)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    if (!entry) return null
    if (maxAgeMs && Date.now() - (entry.savedAt || 0) > maxAgeMs) return null
    return entry.value as T
  } catch {
    try {
      const raw = localStorage.getItem(`kv:${key}`)
      if (!raw) return null
      const entry = JSON.parse(raw)
      if (maxAgeMs && Date.now() - (entry.savedAt || 0) > maxAgeMs) return null
      return entry.value as T
    } catch {
      return null
    }
  }
}

export async function kvDel(key: string): Promise<void> {
  try {
    const db = await openDB()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).delete(key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch {
    try { localStorage.removeItem(`kv:${key}`) } catch {}
  }
}