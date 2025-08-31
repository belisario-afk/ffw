// PKCE helpers
export function randomString(bytes = 32) {
  const arr = new Uint8Array(bytes)
  crypto.getRandomValues(arr)
  return base64UrlEncode(arr)
}

export async function sha256(input: string): Promise<ArrayBuffer> {
  const data = new TextEncoder().encode(input)
  return crypto.subtle.digest('SHA-256', data)
}

export function base64UrlEncode(buffer: ArrayBuffer | Uint8Array | string): string {
  let bytes: Uint8Array
  if (typeof buffer === 'string') {
    bytes = new TextEncoder().encode(buffer)
  } else if (buffer instanceof ArrayBuffer) {
    bytes = new Uint8Array(buffer)
  } else {
    bytes = buffer
  }
  let binary = ''
  bytes.forEach((b) => binary += String.fromCharCode(b))
  const base64 = btoa(binary)
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function pkceChallengeFromVerifier(verifier: string) {
  const hashed = await sha256(verifier)
  return base64UrlEncode(hashed)
}