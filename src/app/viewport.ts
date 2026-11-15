/**
 * Three.js viewport: renderer, lighting, navigation, picking, brush cursor,
 * skeleton overlay and context-loss handling.
 *
 * Rendering is on demand: `needsRender` is set by interaction, animation and
 * geometry edits, so an idle studio costs ~0% GPU.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { Character } from '../character/character';

export type ViewPreset = 'three-quarter' | 'front' | 'side' | 'back' | 'top';
export type LightPreset = 'studio' | 'clay' | 'dramatic';
export type Projection = 'perspective' | 'ortho';
export type Quality = 'auto' | 'sharp' | 'fast';

export interface PickHit {
  mesh: THREE.Mesh;
  world: THREE.Vector3;
  local: THREE.Vector3;
  worldNormal: THREE.Vector3;
  localNormal: THREE.Vector3;
  distance: number;
  faceIndex: number | undefined;
}

export interface ViewportHooks {
  onContextLost?: () => void;
  onContextRestored?: () => void;
  onNavigate?: () => void;
}

const PIXEL_BUDGET = 3_200_000;

export class Viewport {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(32, 1, 0.01, 120);
  readonly ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -60, 120);
  readonly controls: OrbitControls;
  readonly renderer: THREE.WebGLRenderer;
  readonly raycaster = new THREE.Raycaster();
  readonly pointer = new THREE.Vector2();

  needsRender = true;
  quality: Quality = 'auto';
  dpr = 1;
  contextLost = false;
  frameMs = 0;
  fps = 0;

  private canvas: HTMLCanvasElement;
  private hooks: ViewportHooks;
  private grid: THREE.GridHelper;
  private axes: THREE.AxesHelper;
  private lights = new THREE.Group();
  private keyLight!: THREE.DirectionalLight;
  private fillLight!: THREE.DirectionalLight;
  private rimLight!: THREE.DirectionalLight;
  private hemi!: THREE.HemisphereLight;
  private ground: THREE.Mesh;
  private cursorGroup: THREE.Group;
  private cursorRing: THREE.Mesh;
  private cursorDot: THREE.Mesh;
  private skeletonHelper: THREE.SkeletonHelper | null = null;
  private boneMarker: THREE.Mesh;
  private character: Character | null = null;
  private lightPreset: LightPreset = 'studio';
  private projection: Projection = 'perspective';
  private resizeObserver: ResizeObserver | null = null;
  private pmrem: THREE.PMREMGenerator | null = null;
  private lastFrameTime = performance.now();
  private fpsAccum = 0;
  private fpsFrames = 0;

  constructor(canvas: HTMLCanvasElement, hooks: ViewportHooks = {}) {
    this.canvas = canvas;
    this.hooks = hooks;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true,
    });
    this.renderer.setClearColor(0x0a0c10, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene.background = new THREE.Color(0x0a0c10);

    // Environment: a neutral studio room gives PBR materials something to reflect.
    try {
      this.pmrem = new THREE.PMREMGenerator(this.renderer);
      this.scene.environment = this.pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      this.scene.environmentIntensity = 0.26;
    } catch {
      /* environment is a nicety; proceed with analytic lights only */
    }

    this.camera.position.set(2.2, 1.55, 2.7);
    this.camera.lookAt(0, 1, 0);
    this.ortho.position.copy(this.camera.position);
    this.ortho.lookAt(0, 1, 0);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, 0.95, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.09;
    this.controls.rotateSpeed = 0.85;
    this.controls.zoomSpeed = 0.9;
    this.controls.panSpeed = 0.8;
    this.controls.screenSpacePanning = true;
    this.controls.minDistance = 0.35;
    this.controls.maxDistance = 14;
    this.controls.maxPolarAngle = Math.PI * 0.96;
    this.controls.addEventListener('change', () => {
      this.needsRender = true;
    });
    this.controls.addEventListener('end', () => {
      this.hooks.onNavigate?.();
    });

    this.grid = new THREE.GridHelper(6, 30, 0x2f3843, 0x1a2129);
    this.grid.position.y = 0.001;
    (this.grid.material as THREE.Material).transparent = true;
    (this.grid.material as THREE.Material).opacity = 0.55;
    this.scene.add(this.grid);

    this.axes = new THREE.AxesHelper(0.32);
    (this.axes.material as THREE.Material).transparent = true;
    (this.axes.material as THREE.Material).opacity = 0.85;
    this.axes.position.y = 0.002;
    this.scene.add(this.axes);

    this.scene.add(this.lights);
    this.applyLightPreset('studio');

    // Soft contact shadow under the character, generated without a render target.
    this.ground = new THREE.Mesh(
      new THREE.CircleGeometry(1.6, 64),
      new THREE.MeshBasicMaterial({
        map: makeRadialShadowTexture(),
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
        color: 0x000000,
      }),
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = 0.002;
    this.ground.renderOrder = -1;
    this.scene.add(this.ground);

    // Brush cursor
    this.cursorGroup = new THREE.Group();
    this.cursorRing = new THREE.Mesh(
      new THREE.RingGeometry(0.92, 1, 64),
      new THREE.MeshBasicMaterial({ color: 0x5ee0c2, transparent: true, opacity: 0.95, depthTest: false, side: THREE.DoubleSide }),
    );
    this.cursorDot = new THREE.Mesh(
      new THREE.CircleGeometry(0.045, 16),
      new THREE.MeshBasicMaterial({ color: 0x5ee0c2, transparent: true, opacity: 0.9, depthTest: false }),
    );
    this.cursorGroup.add(this.cursorRing, this.cursorDot);
    this.cursorGroup.visible = false;
    this.cursorGroup.renderOrder = 999;
    this.scene.add(this.cursorGroup);

    this.boneMarker = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.018),
      new THREE.MeshBasicMaterial({ color: 0xffcf6b, depthTest: false, transparent: true, opacity: 0.95 }),
    );
    this.boneMarker.visible = false;
    this.boneMarker.renderOrder = 998;
    this.scene.add(this.boneMarker);

    canvas.addEventListener('webglcontextlost', this.onContextLost, false);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored, false);

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(canvas);
    }
    window.addEventListener('resize', this.resize);
    this.resize();
  }

  private onContextLost = (event: Event) => {
    event.preventDefault();
    this.contextLost = true;
    this.hooks.onContextLost?.();
  };

  private onContextRestored = () => {
    this.contextLost = false;
    if (this.character) {
      for (const rec of this.character.meshes) {
        for (const attr of Object.values(rec.mesh.geometry.attributes)) {
          (attr as THREE.BufferAttribute).needsUpdate = true;
        }
        rec.mesh.geometry.getIndex() && (rec.mesh.geometry.getIndex()!.needsUpdate = true);
      }
    }
    this.needsRender = true;
    this.hooks.onContextRestored?.();
  };

  get activeCamera(): THREE.Camera {
    return this.projection === 'ortho' ? this.ortho : this.camera;
  }

  get canvasElement(): HTMLCanvasElement {
    return this.canvas;
  }

  setPausedNavigation(paused: boolean): void {
    this.controls.enabled = !paused;
  }

  resize(): void {
    const width = this.canvas.clientWidth || this.canvas.parentElement?.clientWidth || 1;
    const height = this.canvas.clientHeight || this.canvas.parentElement?.clientHeight || 1;
    const dprCap = this.quality === 'sharp' ? 2.5 : this.quality === 'fast' ? 1 : 2;
    const budgetDpr = Math.sqrt(PIXEL_BUDGET / Math.max(1, width * height));
    this.dpr = Math.max(0.75, Math.min(window.devicePixelRatio || 1, dprCap, budgetDpr));
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.syncOrthoFrustum();
    this.needsRender = true;
  }

  setQuality(quality: Quality): void {
    this.quality = quality;
    this.resize();
  }

  private syncOrthoFrustum(): void {
    const width = this.canvas.clientWidth || 1;
    const height = this.canvas.clientHeight || 1;
    const distance = this.camera.position.distanceTo(this.controls.target);
    const halfHeight = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * distance;
    const halfWidth = halfHeight * (width / height);
    this.ortho.left = -halfWidth;
    this.ortho.right = halfWidth;
    this.ortho.top = halfHeight;
    this.ortho.bottom = -halfHeight;
    this.ortho.near = 0.01;
    this.ortho.far = 200;
    this.ortho.zoom = 1;
    this.ortho.updateProjectionMatrix();
  }

  setProjection(projection: Projection): void {
    this.projection = projection;
    if (projection === 'ortho') {
      this.ortho.position.copy(this.camera.position);
      this.ortho.quaternion.copy(this.camera.quaternion);
      this.syncOrthoFrustum();
    }
    this.needsRender = true;
  }

  getProjection(): Projection {
    return this.projection;
  }

  setViewPreset(preset: ViewPreset): void {
    const target = this.controls.target.clone();
    const distance = Math.max(1.6, this.camera.position.distanceTo(target));
    const dir = new THREE.Vector3();
    switch (preset) {
      case 'front':
        dir.set(0, 0.06, 1);
        break;
      case 'back':
        dir.set(0, 0.06, -1);
        break;
      case 'side':
        dir.set(1, 0.06, 0);
        break;
      case 'top':
        dir.set(0, 1, 0.02);
        break;
      default:
        dir.set(0.72, 0.34, 0.86);
        break;
    }
    dir.normalize().multiplyScalar(distance);
    this.camera.position.copy(target).add(dir);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(target);
    this.ortho.position.copy(this.camera.position);
    this.ortho.quaternion.copy(this.camera.quaternion);
    this.controls.update();
    this.syncOrthoFrustum();
    this.needsRender = true;
  }

  setLightPreset(preset: LightPreset): void {
    this.lightPreset = preset;
    this.applyLightPreset(preset);
    this.needsRender = true;
  }

  getLightPreset(): LightPreset {
    return this.lightPreset;
  }

  private applyLightPreset(preset: LightPreset): void {
    this.lights.clear();
    this.hemi = new THREE.HemisphereLight(0x9fb6c9, 0x1a1f26, preset === 'clay' ? 1.5 : 0.85);
    this.keyLight = new THREE.DirectionalLight(0xfff3e2, preset === 'dramatic' ? 2.4 : 2.1);
    this.keyLight.position.set(2.6, 3.6, 2.8);
    this.fillLight = new THREE.DirectionalLight(0xa9c6ff, preset === 'dramatic' ? 0.35 : 0.85);
    this.fillLight.position.set(-3, 1.6, 1.8);
    this.rimLight = new THREE.DirectionalLight(0x9ff0e0, preset === 'dramatic' ? 1.9 : 1.05);
    this.rimLight.position.set(-1.4, 2.2, -3.2);
    this.lights.add(this.hemi, this.keyLight, this.fillLight, this.rimLight);
    this.renderer.toneMappingExposure = preset === 'clay' ? 1.2 : preset === 'dramatic' ? 0.95 : 1.05;
    if (this.scene.environment) this.scene.environmentIntensity = preset === 'clay' ? 0.22 : 0.4;
  }

  setGridVisible(visible: boolean): void {
    this.grid.visible = visible;
    this.needsRender = true;
  }

  setAxesVisible(visible: boolean): void {
    this.axes.visible = visible;
    this.needsRender = true;
  }

  setCharacter(character: Character | null): void {
    this.clearSkeleton();
    if (this.character) {
      this.scene.remove(this.character.root);
    }
    this.character = character;
    if (!character) {
      this.needsRender = true;
      return;
    }
    this.scene.add(character.root);
    character.root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = false;
        mesh.receiveShadow = false;
      }
    });
    this.frameCharacter();
    this.needsRender = true;
  }

  frameCharacter(padding = 1.32): void {
    if (!this.character) return;
    const box = new THREE.Box3().setFromObject(this.character.root);
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const target = sphere.center.clone();
    const distance = (sphere.radius * padding) / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2));
    this.controls.target.copy(target);
    const dir = new THREE.Vector3(0.72, 0.34, 0.86).normalize();
    this.camera.position.copy(target).addScaledVector(dir, Math.max(0.9, distance));
    this.camera.lookAt(target);
    this.ortho.position.copy(this.camera.position);
    this.ortho.quaternion.copy(this.camera.quaternion);
    this.controls.update();
    this.syncOrthoFrustum();
    this.ground.position.set(target.x, 0.002, target.z);
    const radius = Math.max(0.7, sphere.radius * 1.5);
    this.ground.scale.setScalar(radius / 1.6);
    this.needsRender = true;
  }

  setSkeletonVisible(visible: boolean): void {
    if (!this.character) return;
    if (visible && !this.skeletonHelper) {
      const helper = new THREE.SkeletonHelper(this.character.root);
      const material = helper.material as THREE.LineBasicMaterial;
      material.color = new THREE.Color(0x5ee0c2);
      material.transparent = true;
      material.opacity = 0.55;
      material.depthTest = false;
      helper.renderOrder = 900;
      helper.frustumCulled = false;
      this.scene.add(helper);
      this.skeletonHelper = helper;
    } else if (!visible && this.skeletonHelper) {
      this.scene.remove(this.skeletonHelper);
      this.skeletonHelper.geometry.dispose();
      (this.skeletonHelper.material as THREE.Material).dispose();
      this.skeletonHelper = null;
    }
    this.needsRender = true;
  }

  skeletonVisible(): boolean {
    return !!this.skeletonHelper;
  }

  setSelectedBone(boneName: string | null): void {
    if (!boneName || !this.character) {
      this.boneMarker.visible = false;
      this.needsRender = true;
      return;
    }
    const bone = this.character.bones.find((b) => b.name === boneName);
    if (!bone) {
      this.boneMarker.visible = false;
      return;
    }
    bone.updateWorldMatrix(true, false);
    const position = new THREE.Vector3().setFromMatrixPosition(bone.matrixWorld);
    this.boneMarker.position.copy(position);
    this.boneMarker.visible = true;
    this.needsRender = true;
  }

  private clearSkeleton(): void {
    if (this.skeletonHelper) {
      this.scene.remove(this.skeletonHelper);
      this.skeletonHelper.geometry.dispose();
      (this.skeletonHelper.material as THREE.Material).dispose();
      this.skeletonHelper = null;
    }
    this.boneMarker.visible = false;
  }

  updateCursor(hit: PickHit | null, radiusWorld: number): void {
    if (!hit) {
      this.cursorGroup.visible = false;
      this.needsRender = true;
      return;
    }
    this.cursorGroup.visible = true;
    this.cursorGroup.position.copy(hit.world).addScaledVector(hit.worldNormal, 0.0015);
    const look = hit.world.clone().add(hit.worldNormal);
    this.cursorGroup.lookAt(look);
    this.cursorRing.scale.setScalar(Math.max(0.002, radiusWorld));
    this.cursorDot.scale.setScalar(Math.max(0.002, radiusWorld));
    this.needsRender = true;
  }

  hideCursor(): void {
    if (this.cursorGroup.visible) {
      this.cursorGroup.visible = false;
      this.needsRender = true;
    }
  }

  setCursorInvert(invert: boolean): void {
    const color = invert ? 0xff8b8b : 0x5ee0c2;
    (this.cursorRing.material as THREE.MeshBasicMaterial).color.setHex(color);
    (this.cursorDot.material as THREE.MeshBasicMaterial).color.setHex(color);
  }

  pick(clientX: number, clientY: number): PickHit | null {
    if (!this.character) return null;
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.activeCamera);
    const meshes = this.character.meshes.map((m) => m.mesh);
    const targets = this.character.attachments.map((a) => a.root).flatMap((root) => {
      const list: THREE.Object3D[] = [];
      root.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) list.push(o);
      });
      return list;
    });
    const hits = this.raycaster.intersectObjects([...meshes, ...targets], false);
    if (!hits.length) return null;
    const hit = hits[0];
    const mesh = hit.object as THREE.Mesh;
    if (!this.character.meshes.some((m) => m.mesh === mesh)) {
      // attachments are pickable for selection, but not sculptable
      return {
        mesh,
        world: hit.point.clone(),
        local: mesh.worldToLocal(hit.point.clone()),
        worldNormal: new THREE.Vector3(0, 1, 0),
        localNormal: new THREE.Vector3(0, 1, 0),
        distance: hit.distance,
        faceIndex: hit.faceIndex ?? undefined,
      };
    }
    const worldNormal = new THREE.Vector3(0, 1, 0);
    if (hit.face) {
      const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
      worldNormal.copy(hit.face.normal).applyMatrix3(normalMatrix).normalize();
    }
    const local = mesh.worldToLocal(hit.point.clone());
    const localNormal = worldNormal.clone().applyMatrix3(new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld).invert()).normalize();
    return {
      mesh,
      world: hit.point.clone(),
      local,
      worldNormal,
      localNormal,
      distance: hit.distance,
      faceIndex: hit.faceIndex ?? undefined,
    };
  }

  /** Project a world point into CSS pixel coordinates (used by tests and marker overlays). */
  projectToScreen(world: THREE.Vector3): { x: number; y: number; visible: boolean } {
    const rect = this.canvas.getBoundingClientRect();
    const projected = world.clone().project(this.activeCamera);
    return {
      x: rect.left + (projected.x * 0.5 + 0.5) * rect.width,
      y: rect.top + (-projected.y * 0.5 + 0.5) * rect.height,
      visible: projected.z > -1 && projected.z < 1,
    };
  }

  /** World units per screen pixel at the given world point. */
  worldPerPixel(point: THREE.Vector3): number {
    const height = this.canvas.clientHeight || 1;
    if (this.projection === 'ortho') {
      return (this.ortho.top - this.ortho.bottom) / height;
    }
    const distance = this.camera.position.distanceTo(point);
    return (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * distance) / height;
  }

  /** Mean world scale of an object (used to convert world lengths into mesh-local units). */
  objectScale(object: THREE.Object3D): number {
    const scale = new THREE.Vector3();
    object.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), scale);
    return (Math.abs(scale.x) + Math.abs(scale.y) + Math.abs(scale.z)) / 3 || 1;
  }

  tick(): boolean {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastFrameTime) / 1000);
    this.lastFrameTime = now;
    this.fpsAccum += dt;
    this.fpsFrames++;
    if (this.fpsAccum > 0.5) {
      this.fps = this.fpsFrames / this.fpsAccum;
      this.fpsAccum = 0;
      this.fpsFrames = 0;
    }

    if (this.projection === 'ortho') {
      // OrbitControls drives the perspective camera; mirror it to the ortho camera.
      this.ortho.position.copy(this.camera.position);
      this.ortho.quaternion.copy(this.camera.quaternion);
      this.syncOrthoFrustum();
    }
    this.controls.update();
    if (this.skeletonHelper) this.skeletonHelper.updateMatrixWorld(true);
    if (!this.needsRender || this.contextLost) return false;
    const start = performance.now();
    this.renderer.render(this.scene, this.activeCamera);
    this.frameMs = performance.now() - start;
    this.needsRender = false;
    return true;
  }

  render(): void {
    if (this.contextLost) return;
    this.renderer.render(this.scene, this.activeCamera);
    this.needsRender = false;
  }

  invalidate(): void {
    this.needsRender = true;
  }

  /** Diagnostic snapshot used by the debug API and the e2e suite. */
  info(): { calls: number; triangles: number; dpr: number; fps: number; frameMs: number; contextLost: boolean } {
    return {
      calls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      dpr: this.dpr,
      fps: Math.round(this.fps),
      frameMs: Math.round(this.frameMs * 100) / 100,
      contextLost: this.contextLost,
    };
  }

  dispose(): void {
    window.removeEventListener('resize', this.resize);
    this.resizeObserver?.disconnect();
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.clearSkeleton();
    this.controls.dispose();
    this.pmrem?.dispose();
    this.ground.geometry.dispose();
    const groundMaterial = this.ground.material as THREE.MeshBasicMaterial;
    groundMaterial.map?.dispose();
    groundMaterial.dispose();
    this.grid.geometry.dispose();
    (this.grid.material as THREE.Material).dispose();
    this.axes.geometry.dispose();
    (this.axes.material as THREE.Material).dispose();
    this.cursorRing.geometry.dispose();
    (this.cursorRing.material as THREE.Material).dispose();
    this.cursorDot.geometry.dispose();
    (this.cursorDot.material as THREE.Material).dispose();
    this.boneMarker.geometry.dispose();
    (this.boneMarker.material as THREE.Material).dispose();
    this.renderer.dispose();
  }
}

function makeRadialShadowTexture(): THREE.Texture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, 'rgba(0,0,0,0.55)');
    gradient.addColorStop(0.45, 'rgba(0,0,0,0.28)');
    gradient.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
