import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js'
import { FilmPass } from 'three/examples/jsm/postprocessing/FilmPass.js'

export type PostFX = {
  bloom: boolean
  bloomStrength: number
  bloomRadius: number
  bloomThreshold: number
  fxaa: boolean
  vignette: boolean
  vignetteStrength: number // 0..1
  filmGrain: boolean
  filmGrainStrength: number // 0..1
}

export function createRenderer(canvas: HTMLCanvasElement, scale = 1) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: 'high-performance' })
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.0
  const setSize = () => {
    const dpr = Math.min(2, window.devicePixelRatio || 1) * scale
    const w = Math.floor(canvas.clientWidth * dpr)
    const h = Math.floor(canvas.clientHeight * dpr)
    renderer.setSize(w, h, false)
  }
  setSize()
  window.addEventListener('resize', setSize)
  return { renderer, dispose: () => window.removeEventListener('resize', setSize) }
}

export function createComposer(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, post: PostFX) {
  const size = renderer.getSize(new THREE.Vector2())
  const composer = new EffectComposer(renderer)
  const renderPass = new RenderPass(scene, camera)
  composer.addPass(renderPass)

  let fxaaPass: ShaderPass | null = null
  if (post.fxaa) {
    fxaaPass = new ShaderPass(FXAAShader)
    const px = 1 / size.x, py = 1 / size.y
    fxaaPass.material.uniforms['resolution'].value.set(px, py)
    composer.addPass(fxaaPass)
  }

  let bloomPass: UnrealBloomPass | null = null
  if (post.bloom) {
    bloomPass = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), post.bloomStrength, post.bloomRadius, post.bloomThreshold)
    composer.addPass(bloomPass)
  }

  let vignettePass: ShaderPass | null = null
  if (post.vignette) {
    vignettePass = new ShaderPass({
      uniforms: {
        tDiffuse: { value: null },
        strength: { value: post.vignetteStrength }
      },
      vertexShader: /* glsl */`
        varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*position; }
      `,
      fragmentShader: /* glsl */`
        varying vec2 vUv; uniform sampler2D tDiffuse; uniform float strength;
        void main(){
          vec2 uv=vUv-0.5; float r=length(uv)*1.4142; float v=smoothstep(0.0,1.0,r);
          vec4 col=texture2D(tDiffuse, vUv);
          col.rgb *= mix(1.0, 1.0 - 0.85*v, clamp(strength,0.0,1.0));
          gl_FragColor=col;
        }
      `
    } as any)
    composer.addPass(vignettePass)
  }

  let filmPass: FilmPass | null = null
  if (post.filmGrain) {
    filmPass = new FilmPass(0.35 * post.filmGrainStrength, 0.025, 648, false)
    composer.addPass(filmPass)
  }

  const onResize = () => {
    const s = renderer.getSize(new THREE.Vector2())
    composer.setSize(s.x, s.y)
    if (fxaaPass) {
      fxaaPass.material.uniforms['resolution'].value.set(1 / s.x, 1 / s.y)
    }
    if (bloomPass) {
      bloomPass.setSize(s.x, s.y)
    }
  }

  return {
    composer,
    updatePost(post2: PostFX) {
      // In this simple scaffold, recreate composer externally if topology changes drastically
      if (bloomPass) {
        bloomPass.strength = post2.bloomStrength
        bloomPass.radius = post2.bloomRadius
        bloomPass.threshold = post2.bloomThreshold
      }
      if (vignettePass) vignettePass.material.uniforms['strength'].value = post2.vignetteStrength
      if (filmPass) filmPass.uniforms['grayscale'].value = 0 // keep color
    },
    onResize,
    dispose() {
      composer.dispose()
    }
  }
}