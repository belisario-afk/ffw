import React, { createContext, useContext, useEffect, useRef, useState } from 'react'
import { reactivityBus, type ReactiveFrame } from './ReactivityBus'

const ReactivityCtx = createContext<{ get: () => ReactiveFrame | null }>({ get: () => null })

export function ReactivityProvider({ children }: { children: React.ReactNode }) {
  const ref = useRef<ReactiveFrame | null>(null)
  useEffect(() => reactivityBus.on('frame', f => { ref.current = f }), [])
  return <ReactivityCtx.Provider value={{ get: () => ref.current }}>{children}</ReactivityCtx.Provider>
}

export function useReactivity() {
  const ctx = useContext(ReactivityCtx)
  const [frame, setFrame] = useState<ReactiveFrame | null>(null)
  useEffect(() => reactivityBus.on('frame', setFrame), [])
  return { frame, get: ctx.get }
}