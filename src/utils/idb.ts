// Minimal IDB wrapper for caching album art with ETag
export async function cacheAlbumArt(url: string): Promise<string> {
  const db = await openDB()
  const tx = db.transaction('art', 'readwrite')
  const store = tx.objectStore('art')
  const cached = await store.get(url)
  let etag: string | undefined
  if (cached?.etag) etag = cached.etag
  const res = await fetch(url, {
    headers: etag ? { 'If-None-Match': etag } : undefined
  })
  if (res.status === 304 && cached?.blob) {
    return URL.createObjectURL(cached.blob)
  }
  const blob = await res.blob()
  const newEtag = res.headers.get('ETag') || undefined
  await store.put({ url, etag: newEtag, blob }, url)
  await tx.done
  return URL.createObjectURL(blob)
}

type DB = {
  transaction: (name: string, mode: IDBTransactionMode) => {
    objectStore: (name: string) => {
      get: (key: string) => Promise<any>
      put: (value: any, key: string) => Promise<void>
    }
    done: Promise<void>
  }
}

async function openDB(): Promise<DB> {
  const req = indexedDB.open('ffw-cache', 1)
  const db: IDBDatabase = await new Promise((resolve, reject) => {
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('art')) db.createObjectStore('art')
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  function promisify<T>(r: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      r.onsuccess = () => resolve(r.result)
      r.onerror = () => reject(r.error)
    })
  }
  return {
    transaction(name: string, mode: IDBTransactionMode) {
      const tx = db.transaction(name, mode)
      const store = tx.objectStore(name)
      return {
        objectStore() {
          return {
            get(key: string) { return promisify<any>(store.get(key)) },
            put(value: any, key: string) { return promisify<void>(store.put(value, key)) }
          }
        },
        done: new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve()
          tx.onerror = () => reject(tx.error)
          tx.onabort = () => reject(tx.error)
        })
      }
    }
  }
}