// Dispatches UI open events for the active visual's settings panel.
// WireframeHouse3D listens for 'ffw:open-wireframe3d-settings'.
export function openSettingsForActiveVisual(activeVisualKey: string) {
  if (activeVisualKey === 'wireframe3d') {
    window.dispatchEvent(new CustomEvent('ffw:open-wireframe3d-settings'))
    return
  }
  // Fallback: keep your existing 2D/global settings behavior
  window.dispatchEvent(new CustomEvent('ffw:open-wireframe-settings'))
}