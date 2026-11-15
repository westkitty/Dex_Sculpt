import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';

export type CameraViewPreset = 'threeQuarter' | 'front' | 'back' | 'left' | 'right';
export type LightingPresetId = 'studio' | 'rim' | 'warm' | 'clay';
export type RenderQuality = 'fast' | 'balanced' | 'sharp';

export class FrameStats {
  private buf = new Float64Array(240);
  private n = 0;
  private i = 0;

  push(ms: number): void {
    this.buf[this.i] = ms;
    this.i = (this.i + 1) % this.buf.length;
    this.n = Math.min(this.n + 1, this.buf.length);
  }

  pct(p: number): number {
    if (!this.n) return 0;
    const a = Array.from(this.buf.subarray(0, this.n)).sort((x, y) => x - y);
    return a[Math.min(a.length - 1, Math.floor(p * a.length))];
  }

  reset(): void {
    this.n = 0;
    this.i = 0;
  }

  get count(): number {
    return this.n;
  }
}

/**
 * Installs a non-destructive shader hook on MeshStandardMaterial so `sculptMask`
 * renders as a subtle indigo tint without modifying `geometry.attributes.color`.
 */
export function attachMaskShaderHook(material: THREE.Material): void {
  if (!(material instanceof THREE.MeshStandardMaterial)) return;
  if (material.userData.__dexMaskHooked) return;
  material.userData.__dexMaskHooked = true;
  material.customProgramCacheKey = () => 'dex-sculpt-mask-v1';
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>\nattribute float sculptMask;\nvarying float vSculptMask;`
      )
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvSculptMask = sculptMask;`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying float vSculptMask;`)
      .replace(
        '#include <dithering_fragment>',
        `gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.18, 0.24, 0.62), clamp(vSculptMask, 0.0, 1.0) * 0.55);\n#include <dithering_fragment>`
      );
  };
  material.needsUpdate = true;
}

export class StudioViewport {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly perspCamera: THREE.PerspectiveCamera;
  readonly orthoCamera: THREE.OrthographicCamera;
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  isOrtho = false;

  readonly controls: OrbitControls;
  readonly gizmo: TransformControls;
  readonly cursor: THREE.Mesh;
  readonly mirrorCursor: THREE.Mesh;
  readonly grid: THREE.GridHelper;
  readonly axes: THREE.AxesHelper;

  skeletonHelper: THREE.SkeletonHelper | null = null;
  private lightGroup = new THREE.Group();
  private hemiLight: THREE.HemisphereLight;
  private keyLight: THREE.DirectionalLight;
  private fillLight: THREE.DirectionalLight;
  private rimLight: THREE.DirectionalLight;
  private clayMaterial: THREE.MeshStandardMaterial;
  private claySavedMaterials = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  private clayMode = false;

  needsRender = true;
  continuous = false;
  quality: RenderQuality = 'balanced';
  pixelRatio = 1;
  contextLost = false;
  contextEvents: string[] = [];
  rendererInfo = '';
  readonly frameCpu = new FrameStats();

  onFrame: (dtSec: number) => void = () => {};
  onContextChange: (lost: boolean) => void = () => {};

  private rafId = 0;
  private lastTime = 0;
  private resizeObserver: ResizeObserver | null = null;
  private lightingPreset: LightingPresetId = 'studio';
  private focusCenter = new THREE.Vector3(0, 0.9, 0);
  private focusRadius = 1.1;

  static readonly BUDGET: Record<RenderQuality, number> = {
    fast: 1.6e6,
    balanced: 3.2e6,
    sharp: 8.5e6
  };

  static effectiveDpr(cssW: number, cssH: number, dpr: number, budget: number): number {
    const cap = Math.sqrt(budget / Math.max(1, cssW * cssH));
    return Math.max(1, Math.min(dpr, 3, cap));
  }

  constructor(public readonly host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false
    });
    this.renderer.setClearColor(0x0f1115, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    const cv = this.renderer.domElement;
    cv.id = 'viewport-canvas';
    cv.setAttribute('aria-label', '3D Character Sculpt Viewport');
    cv.tabIndex = 0;
    host.appendChild(cv);

    const gl = this.renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    this.rendererInfo = dbg
      ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL))
      : String(gl.getParameter(gl.RENDERER));

    this.perspCamera = new THREE.PerspectiveCamera(36, 1, 0.02, 200);
    this.perspCamera.position.set(0.95, 1.35, 2.65);

    this.orthoCamera = new THREE.OrthographicCamera(-1.2, 1.2, 1.2, -1.2, 0.02, 200);
    this.orthoCamera.position.copy(this.perspCamera.position);
    this.camera = this.perspCamera;

    this.controls = new OrbitControls(this.camera, cv);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.16;
    this.controls.target.copy(this.focusCenter);
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.PAN,
      RIGHT: THREE.MOUSE.ROTATE
    };
    this.controls.touches = {
      ONE: THREE.TOUCH.ROTATE,
      TWO: THREE.TOUCH.DOLLY_PAN
    };
    this.controls.addEventListener('change', () => {
      this.needsRender = true;
    });

    this.gizmo = new TransformControls(this.camera, cv);
    this.gizmo.setSize(0.75);
    this.gizmo.addEventListener('dragging-changed', (e: any) => {
      this.controls.enabled = !e.value;
    });
    this.gizmo.addEventListener('change', () => {
      this.needsRender = true;
    });
    this.scene.add(this.gizmo.getHelper());

    // Studio lighting rig
    this.hemiLight = new THREE.HemisphereLight(0xeef2f7, 0x1a1e26, 1.15);
    this.keyLight = new THREE.DirectionalLight(0xffffff, 1.9);
    this.keyLight.position.set(2.4, 3.6, 2.8);
    this.fillLight = new THREE.DirectionalLight(0xb8d4f0, 0.75);
    this.fillLight.position.set(-2.5, 1.8, 1.5);
    this.rimLight = new THREE.DirectionalLight(0x6ee7d8, 0.85);
    this.rimLight.position.set(-0.6, 2.5, -2.8);
    this.lightGroup.add(this.hemiLight, this.keyLight, this.fillLight, this.rimLight);
    this.scene.add(this.lightGroup);

    // Subtle dark floor grid + axis lines
    this.grid = new THREE.GridHelper(6, 24, 0x334155, 0x1e2430);
    this.grid.position.y = 0;
    this.scene.add(this.grid);

    this.axes = new THREE.AxesHelper(0.6);
    this.axes.visible = false;
    this.scene.add(this.axes);

    // 3D brush hover ring + symmetry mirror ring
    const ringGeo = new THREE.RingGeometry(0.92, 1.0, 48);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x2dd4bf,
      side: THREE.DoubleSide,
      depthTest: false,
      transparent: true,
      opacity: 0.9
    });
    this.cursor = new THREE.Mesh(ringGeo, ringMat);
    this.cursor.visible = false;
    this.cursor.renderOrder = 999;

    const mirrorMat = ringMat.clone();
    mirrorMat.color.setHex(0xf59e0b);
    mirrorMat.opacity = 0.55;
    this.mirrorCursor = new THREE.Mesh(ringGeo, mirrorMat);
    this.mirrorCursor.visible = false;
    this.mirrorCursor.renderOrder = 998;
    this.scene.add(this.cursor, this.mirrorCursor);

    this.clayMaterial = new THREE.MeshStandardMaterial({
      name: 'Clay_Preview_Mat',
      color: 0xc2b5a8,
      roughness: 0.78,
      metalness: 0.04
    });
    attachMaskShaderHook(this.clayMaterial);

    cv.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
      this.contextEvents.push('lost');
      this.onContextChange(true);
    });
    cv.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      this.contextEvents.push('restored');
      this.needsRender = true;
      this.onContextChange(false);
    });

    this.resize();
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(host);
    }

    this.startLoop();
  }

  resize(): void {
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    const dpr = StudioViewport.effectiveDpr(
      w,
      h,
      window.devicePixelRatio || 1,
      StudioViewport.BUDGET[this.quality]
    );
    this.pixelRatio = dpr;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);

    const aspect = w / h;
    this.perspCamera.aspect = aspect;
    this.perspCamera.updateProjectionMatrix();

    const orthoHalf = this.focusRadius * 1.25;
    this.orthoCamera.left = -orthoHalf * aspect;
    this.orthoCamera.right = orthoHalf * aspect;
    this.orthoCamera.top = orthoHalf;
    this.orthoCamera.bottom = -orthoHalf;
    this.orthoCamera.updateProjectionMatrix();
    this.needsRender = true;
  }

  setQuality(q: RenderQuality): void {
    this.quality = q;
    this.resize();
  }

  setProjection(ortho: boolean): void {
    if (this.isOrtho === ortho) return;
    const prev = this.camera;
    this.isOrtho = ortho;
    this.camera = ortho ? this.orthoCamera : this.perspCamera;
    this.camera.position.copy(prev.position);
    this.camera.quaternion.copy(prev.quaternion);
    this.controls.object = this.camera;
    this.gizmo.camera = this.camera;
    this.resize();
  }

  setViewPreset(preset: CameraViewPreset): void {
    const dist = Math.max(1.5, this.focusRadius * 2.45);
    const c = this.focusCenter;
    switch (preset) {
      case 'front':
        this.camera.position.set(c.x, c.y, c.z + dist);
        break;
      case 'back':
        this.camera.position.set(c.x, c.y, c.z - dist);
        break;
      case 'left':
        this.camera.position.set(c.x + dist, c.y, c.z);
        break;
      case 'right':
        this.camera.position.set(c.x - dist, c.y, c.z);
        break;
      case 'threeQuarter':
      default:
        this.camera.position.set(c.x + dist * 0.36, c.y + dist * 0.18, c.z + dist * 0.92);
        break;
    }
    this.controls.target.copy(c);
    this.controls.update();
    this.needsRender = true;
  }

  frameObject(obj: THREE.Object3D): void {
    const box = new THREE.Box3().setFromObject(obj);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(0.25, size.length() * 0.5);
    this.focusCenter.copy(center);
    this.focusRadius = radius;
    this.setViewPreset('threeQuarter');
  }

  setLightingPreset(preset: LightingPresetId): void {
    this.lightingPreset = preset;
    // Restore materials if leaving clay mode
    if (this.clayMode && preset !== 'clay') {
      for (const [mesh, mat] of this.claySavedMaterials.entries()) {
        mesh.material = mat;
      }
      this.claySavedMaterials.clear();
      this.clayMode = false;
    }

    if (preset === 'studio') {
      this.renderer.setClearColor(0x0f1115, 1);
      this.hemiLight.color.setHex(0xeef2f7);
      this.hemiLight.groundColor.setHex(0x1a1e26);
      this.hemiLight.intensity = 1.15;
      this.keyLight.color.setHex(0xffffff);
      this.keyLight.intensity = 1.9;
      this.fillLight.intensity = 0.75;
      this.rimLight.color.setHex(0x6ee7d8);
      this.rimLight.intensity = 0.85;
    } else if (preset === 'rim') {
      this.renderer.setClearColor(0x090b0f, 1);
      this.hemiLight.intensity = 0.45;
      this.keyLight.intensity = 1.35;
      this.fillLight.intensity = 0.35;
      this.rimLight.color.setHex(0x38bdf8);
      this.rimLight.intensity = 2.1;
    } else if (preset === 'warm') {
      this.renderer.setClearColor(0x131110, 1);
      this.hemiLight.color.setHex(0xfff1dc);
      this.hemiLight.groundColor.setHex(0x2a1f18);
      this.hemiLight.intensity = 1.1;
      this.keyLight.color.setHex(0xffe6c7);
      this.keyLight.intensity = 2.0;
      this.fillLight.intensity = 0.65;
      this.rimLight.color.setHex(0xf59e0b);
      this.rimLight.intensity = 0.9;
    } else if (preset === 'clay') {
      this.renderer.setClearColor(0x14161a, 1);
      this.hemiLight.intensity = 1.05;
      this.keyLight.intensity = 1.75;
      this.fillLight.intensity = 0.7;
      this.rimLight.color.setHex(0xd4d4d8);
      this.rimLight.intensity = 0.75;
      this.applyClayPreview(true);
    }
    this.needsRender = true;
  }

  getLightingPreset(): LightingPresetId {
    return this.lightingPreset;
  }

  applyClayPreview(enable: boolean, targetRoot?: THREE.Object3D): void {
    if (!enable) {
      for (const [mesh, mat] of this.claySavedMaterials.entries()) {
        mesh.material = mat;
      }
      this.claySavedMaterials.clear();
      this.clayMode = false;
      this.needsRender = true;
      return;
    }
    this.clayMode = true;
    const root = targetRoot ?? this.scene;
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || mesh === this.cursor || mesh === this.mirrorCursor) return;
      if (mesh.userData.__dexHelper) return;
      if (!this.claySavedMaterials.has(mesh)) {
        this.claySavedMaterials.set(mesh, mesh.material);
      }
      mesh.material = this.clayMaterial;
    });
    this.needsRender = true;
  }

  setSkeletonVisible(visible: boolean, targetRoot?: THREE.Object3D): void {
    if (this.skeletonHelper) {
      this.scene.remove(this.skeletonHelper);
      this.skeletonHelper.dispose();
      this.skeletonHelper = null;
    }
    if (visible && targetRoot) {
      let hasSkinned = false;
      targetRoot.traverse((o) => {
        if ((o as THREE.SkinnedMesh).isSkinnedMesh) hasSkinned = true;
      });
      if (hasSkinned) {
        this.skeletonHelper = new THREE.SkeletonHelper(targetRoot);
        this.skeletonHelper.userData.__dexHelper = true;
        this.scene.add(this.skeletonHelper);
      }
    }
    this.needsRender = true;
  }

  showBrushCursor(
    worldPos: THREE.Vector3 | null,
    worldNormal: THREE.Vector3 | null,
    worldRadius: number,
    mirrorWorldPos?: THREE.Vector3 | null,
    mirrorWorldNormal?: THREE.Vector3 | null
  ): void {
    if (!worldPos || !worldNormal) {
      this.cursor.visible = false;
      this.mirrorCursor.visible = false;
      this.needsRender = true;
      return;
    }
    const q = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      worldNormal.clone().normalize()
    );
    this.cursor.position.copy(worldPos).addScaledVector(worldNormal, 0.002);
    this.cursor.quaternion.copy(q);
    this.cursor.scale.setScalar(Math.max(0.005, worldRadius));
    this.cursor.visible = true;

    if (mirrorWorldPos && mirrorWorldNormal) {
      const mq = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 0, 1),
        mirrorWorldNormal.clone().normalize()
      );
      this.mirrorCursor.position.copy(mirrorWorldPos).addScaledVector(mirrorWorldNormal, 0.002);
      this.mirrorCursor.quaternion.copy(mq);
      this.mirrorCursor.scale.setScalar(Math.max(0.005, worldRadius));
      this.mirrorCursor.visible = true;
    } else {
      this.mirrorCursor.visible = false;
    }
    this.needsRender = true;
  }

  private startLoop(): void {
    const tick = (now: number) => {
      this.rafId = requestAnimationFrame(tick);
      const dt = this.lastTime ? Math.min(0.1, (now - this.lastTime) / 1000) : 0;
      this.lastTime = now;

      if (this.contextLost) return;

      this.onFrame(dt);
      if (this.controls.update()) this.needsRender = true;

      if (this.needsRender || this.continuous) {
        const t0 = performance.now();
        this.renderer.render(this.scene, this.camera);
        this.frameCpu.push(performance.now() - t0);
        this.needsRender = false;
      }
    };
    this.rafId = requestAnimationFrame(tick);
  }

  dispose(): void {
    cancelAnimationFrame(this.rafId);
    this.resizeObserver?.disconnect();
    this.setSkeletonVisible(false);
    this.gizmo.dispose();
    this.controls.dispose();
    this.clayMaterial.dispose();
    this.cursor.geometry.dispose();
    (this.cursor.material as THREE.Material).dispose();
    (this.mirrorCursor.material as THREE.Material).dispose();
    this.grid.dispose();
    this.axes.dispose();
    this.renderer.dispose();
  }
}
