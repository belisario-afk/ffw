// Minimal type shims for Spotify Web Playback SDK
declare namespace Spotify {
  interface PlayerInit {
    name: string
    getOAuthToken: (cb: (token: string) => void) => void
    volume?: number
  }
  class Player {
    constructor(init: PlayerInit)
    connect(): Promise<boolean>
    disconnect(): void
    addListener(event: string, cb: (payload: any) => void): boolean
    removeListener(event: string, cb?: (payload: any) => void): void
    getCurrentState(): Promise<any>
    setName(name: string): Promise<void>
    getVolume(): Promise<number>
    setVolume(volume: number): Promise<void>
    togglePlay(): Promise<void>
    seek(position: number): Promise<void>
    previousTrack(): Promise<void>
    nextTrack(): Promise<void>
  }
}