export async function detectGPUInfo(): Promise<string> {
  try {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl')
    if (!gl) return 'WebGL unavailable'
    const ext = (gl as any).getExtension('WEBGL_debug_renderer_info')
    if (ext) {
      const vendor = (gl as any).getParameter(ext.UNMASKED_VENDOR_WEBGL)
      const renderer = (gl as any).getParameter(ext.UNMASKED_RENDERER_WEBGL)
      return `${vendor} | ${renderer}`
    }
    return 'WebGL renderer (debug info unavailable)'
  } catch {
    return 'GPU detection failed'
  }
}