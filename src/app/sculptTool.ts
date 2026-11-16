import * as THREE from 'three';
import type { BrushId, Symmetry, Vec3 } from '../core/brushes';
import type { RigSafeSculptTarget } from '../core/rigSafeSculpt';
import type { HistoryEntry } from '../core/history';
import type { StudioViewport } from './viewport';

export type StudioInteractionMode = 'sculpt' | 'transform';

export interface BrushSettings {
  tool: BrushId;
  radiusPx: number;
  strength: number;
  symmetry: Symmetry;
  invertLatch: boolean;
  usePressure: boolean;
}

export interface InputSettings {
  penMode: 'auto' | 'pen' | 'any';
  barrel: 'invert' | 'smooth';
  eraser: 'mask' | 'unmask';
  pressureSize: boolean;
  tiltWidens: boolean;
  palmMs: number;
}

export interface PenSample {
  pressure: number;
  tiltDeg: number;
  twist: number;
  buttons: number;
  hovering: boolean;
  t: number;
}

const BARREL = 2;
const ERASER = 32;

export function tiltFromVertical(e: {
  tiltX?: number;
  tiltY?: number;
  altitudeAngle?: number;
}): number {
  if (
    typeof e.altitudeAngle === 'number' &&
    e.altitudeAngle > 0 &&
    e.altitudeAngle < Math.PI / 2 &&
    !(e.tiltX || e.tiltY)
  ) {
    return 90 - THREE.MathUtils.radToDeg(e.altitudeAngle);
  }
  const tx = THREE.MathUtils.degToRad(e.tiltX ?? 0);
  const ty = THREE.MathUtils.degToRad(e.tiltY ?? 0);
  return THREE.MathUtils.radToDeg(Math.atan(Math.sqrt(Math.tan(tx) ** 2 + Math.tan(ty) ** 2)));
}

export const tiltScale = (deg: number): number =>
  1 + 0.6 * Math.min(1, Math.max(0, deg) / 60);

/**
 * Mouse, S Pen / stylus, and multi-touch sculpt interaction controller.
 * Raycasts directly against each sculpt target's bind-pose BVH so sculpting
 * remains fast, accurate, and aligned with symmetry axes.
 */
export class SculptTool {
  mode: StudioInteractionMode = 'sculpt';
  settings: BrushSettings = {
    tool: 'draw',
    radiusPx: 48,
    strength: 0.45,
    symmetry: { x: true, y: false, z: false },
    invertLatch: false,
    usePressure: true
  };
  input: InputSettings = {
    penMode: 'auto',
    barrel: 'invert',
    eraser: 'mask',
    pressureSize: false,
    tiltWidens: true,
    palmMs: 300
  };
  pen = {
    seen: false,
    down: false,
    hovering: false,
    lastT: -1e9,
    last: null as PenSample | null,
    rejectedTouches: 0
  };
  lastStroke = {
    dabs: 0,
    verts: 0,
    pointerType: '',
    tool: '',
    invert: false,
    maxRadiusScale: 1,
    minPressure: 1,
    maxPressure: 0
  };

  private ray = new THREE.Raycaster();
  private pointers = new Set<number>();
  private rejected = new Set<number>();
  private active: {
    target: RigSafeSculptTarget;
    pointerId: number;
    worldR: number;
    localR: number;
    last: THREE.Vector3 | null;
    tool: BrushId;
    invert: boolean;
    grabPlane?: THREE.Plane;
    grabLast?: THREE.Vector3;
    dabs: number;
    pointerType: string;
  } | null = null;
  private keys = { shift: false, ctrl: false };

  constructor(
    private vp: StudioViewport,
    private getTargets: () => RigSafeSculptTarget[],
    private onCommitStroke: (target: RigSafeSculptTarget, entry: HistoryEntry | null) => void,
    private onEnsureBindPoseForSculpt: () => void,
    public onPenActivity: () => void = () => {},
    /** Session hook: prepare the active sculpt layer for a stroke. Return false to block the stroke. */
    private prepareStroke: (target: RigSafeSculptTarget) => boolean = () => true
  ) {
    (this.ray as any).firstHitOnly = true;
    const cv = vp.renderer.domElement;

    cv.addEventListener('pointerdown', (e) => this.onDown(e));
    cv.addEventListener('pointermove', (e) => this.onMove(e));
    cv.addEventListener('pointerup', (e) => this.onUp(e));
    cv.addEventListener('pointercancel', (e) => this.onCancel(e));
    cv.addEventListener('pointerleave', () => {
      if (this.pen.hovering) {
        this.pen.hovering = false;
        this.pen.lastT = performance.now();
        this.onPenActivity();
      }
      this.vp.showBrushCursor(null, null, 0.05);
    });
    cv.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('keydown', (e) => {
      this.keys.shift = e.shiftKey;
      this.keys.ctrl = e.ctrlKey || e.metaKey;
      if (e.key === 'Escape' && this.active) {
        this.cancelActiveStroke();
      }
    });
    window.addEventListener('keyup', (e) => {
      this.keys.shift = e.shiftKey;
      this.keys.ctrl = e.ctrlKey || e.metaKey;
    });
  }

  private samplePen(e: PointerEvent, hovering: boolean): PenSample {
    const tiltDeg = tiltFromVertical(e);
    const sample: PenSample = {
      pressure: e.pressure > 0 ? e.pressure : hovering ? 0 : 0.5,
      tiltDeg,
      twist: (e as any).twist ?? 0,
      buttons: e.buttons,
      hovering,
      t: performance.now()
    };
    this.pen.last = sample;
    this.pen.lastT = sample.t;
    this.pen.seen = true;
    this.onPenActivity();
    return sample;
  }

  private isTouchPalmRejected(e: PointerEvent): boolean {
    if (e.pointerType !== 'touch') return false;
    if (this.pen.down || this.pen.hovering) return true;
    return performance.now() - this.pen.lastT < this.input.palmMs;
  }

  private canSculptWithPointer(e: PointerEvent): boolean {
    if (this.mode !== 'sculpt') return false;
    if (e.pointerType === 'mouse') return e.button === 0 && !e.altKey;
    if (e.pointerType === 'pen') return true;
    if (e.pointerType === 'touch') {
      if (this.input.penMode === 'pen') return false;
      if (this.input.penMode === 'auto' && this.pen.seen) return false;
      return this.pointers.size === 1;
    }
    return false;
  }

  private pickSurface(clientX: number, clientY: number): {
    target: RigSafeSculptTarget;
    worldPoint: THREE.Vector3;
    worldNormal: THREE.Vector3;
    localPoint: THREE.Vector3;
    distance: number;
  } | null {
    const rect = this.vp.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    this.ray.setFromCamera(ndc, this.vp.camera);

    let best: {
      target: RigSafeSculptTarget;
      worldPoint: THREE.Vector3;
      worldNormal: THREE.Vector3;
      localPoint: THREE.Vector3;
      distance: number;
    } | null = null;

    for (const t of this.getTargets()) {
      if (!t.object.visible) continue;
      // Raycast in object local space directly against BVH (works in bind pose without SkinnedMesh slowdown)
      const invMat = new THREE.Matrix4().copy(t.object.matrixWorld).invert();
      const localRay = this.ray.ray.clone().applyMatrix4(invMat);
      const bvh = (t.geometry as any).boundsTree;
      const hits = bvh
        ? bvh.raycast(localRay, THREE.FrontSide)
        : this.ray.intersectObject(t.object, false);

      if (!hits || hits.length === 0) continue;
      const hit = hits[0];
      const localPoint: THREE.Vector3 = bvh
        ? hit.point.clone()
        : t.object.worldToLocal(hit.point.clone());
      const worldPoint = bvh ? localPoint.clone().applyMatrix4(t.object.matrixWorld) : hit.point.clone();
      const distance = worldPoint.distanceTo(this.ray.ray.origin);
      if (best && distance >= best.distance) continue;

      const localNrm = hit.face ? hit.face.normal.clone() : new THREE.Vector3(0, 0, 1);
      const nrmMat = new THREE.Matrix3().getNormalMatrix(t.object.matrixWorld);
      const worldNormal = localNrm.applyMatrix3(nrmMat).normalize();

      best = { target: t, worldPoint, worldNormal, localPoint, distance };
    }
    return best;
  }

  private worldRadiusAt(distance: number, radiusPx: number): number {
    const h = Math.max(1, this.vp.renderer.domElement.clientHeight);
    if (this.vp.isOrtho) {
      const orthoH = this.vp.orthoCamera.top - this.vp.orthoCamera.bottom;
      return (radiusPx / h) * orthoH;
    }
    const fovRad = THREE.MathUtils.degToRad(this.vp.perspCamera.fov);
    const viewH = 2 * distance * Math.tan(fovRad * 0.5);
    return (radiusPx / h) * viewH;
  }

  private resolveToolAndInvert(e: PointerEvent): { tool: BrushId; invert: boolean } {
    let tool = this.settings.tool;
    let invert = this.settings.invertLatch || this.keys.ctrl;

    if (this.keys.shift) tool = 'smooth';
    if (e.pointerType === 'pen') {
      if ((e.buttons & ERASER) !== 0 || e.button === 5) {
        tool = 'mask';
        invert = this.input.eraser === 'unmask';
      } else if ((e.buttons & BARREL) !== 0) {
        if (this.input.barrel === 'smooth') tool = 'smooth';
        else invert = !invert;
      }
    }
    return { tool, invert };
  }

  private onDown(e: PointerEvent): void {
    if (this.isTouchPalmRejected(e)) {
      this.rejected.add(e.pointerId);
      this.pen.rejectedTouches++;
      this.onPenActivity();
      return;
    }

    this.pointers.add(e.pointerId);

    // If a second touch arrives during an active touch stroke, cancel stroke byte-exactly so OrbitControls can take over
    if (e.pointerType === 'touch' && this.pointers.size > 1 && this.active?.pointerType === 'touch') {
      this.cancelActiveStroke();
      this.vp.controls.enabled = true;
      return;
    }

    if (e.pointerType === 'pen') {
      this.pen.down = true;
      this.pen.hovering = false;
      this.samplePen(e, false);
    }

    if (!this.canSculptWithPointer(e)) return;

    this.onEnsureBindPoseForSculpt();
    const hit = this.pickSurface(e.clientX, e.clientY);
    if (!hit) return;

    // Layer-aware gate: blocks strokes onto hidden layers and prepares the active layer.
    if (!this.prepareStroke(hit.target)) return;

    // Begin sculpt stroke: disable camera orbit while dragging on character mesh
    this.vp.controls.enabled = false;
    try {
      this.vp.renderer.domElement.setPointerCapture(e.pointerId);
    } catch {
      // Ignore synthetic events
    }

    const { tool, invert } = this.resolveToolAndInvert(e);
    const scaleObj = hit.target.object.getWorldScale(new THREE.Vector3());
    const avgScale = (scaleObj.x + scaleObj.y + scaleObj.z) / 3 || 1;
    const worldR = this.worldRadiusAt(hit.distance, this.settings.radiusPx);
    const localR = worldR / avgScale;

    hit.target.engine.begin(tool);
    this.lastStroke = {
      dabs: 0,
      verts: 0,
      pointerType: e.pointerType,
      tool,
      invert,
      maxRadiusScale: 1,
      minPressure: 1,
      maxPressure: 0
    };

    if (tool === 'grab') {
      const camDir = new THREE.Vector3();
      this.vp.camera.getWorldDirection(camDir);
      const grabPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(camDir, hit.worldPoint);
      hit.target.engine.grabStart(
        [hit.localPoint.x, hit.localPoint.y, hit.localPoint.z],
        localR,
        this.settings.symmetry
      );
      this.active = {
        target: hit.target,
        pointerId: e.pointerId,
        worldR,
        localR,
        last: hit.localPoint.clone(),
        tool,
        invert,
        grabPlane,
        grabLast: hit.worldPoint.clone(),
        dabs: 0,
        pointerType: e.pointerType
      };
    } else {
      this.active = {
        target: hit.target,
        pointerId: e.pointerId,
        worldR,
        localR,
        last: null,
        tool,
        invert,
        dabs: 0,
        pointerType: e.pointerType
      };
      this.applyDabAt(hit.localPoint, e);
    }

    this.updateHoverRing(hit.worldPoint, hit.worldNormal, worldR, hit.target);
  }

  private onMove(e: PointerEvent): void {
    if (this.rejected.has(e.pointerId)) return;

    if (e.pointerType === 'pen') {
      this.samplePen(e, !this.active && e.buttons === 0);
      this.pen.hovering = !this.active && e.buttons === 0;
    }

    if (!this.active || this.active.pointerId !== e.pointerId) {
      if (this.mode === 'sculpt' && e.buttons === 0) {
        const hit = this.pickSurface(e.clientX, e.clientY);
        if (hit) {
          const r = this.worldRadiusAt(hit.distance, this.settings.radiusPx);
          this.updateHoverRing(hit.worldPoint, hit.worldNormal, r, hit.target);
        } else {
          this.vp.showBrushCursor(null, null, 0.05);
        }
      }
      return;
    }

    const st = this.active;
    if (st.tool === 'grab' && st.grabPlane && st.grabLast) {
      const rect = this.vp.renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1
      );
      this.ray.setFromCamera(ndc, this.vp.camera);
      const planeHit = new THREE.Vector3();
      if (this.ray.ray.intersectPlane(st.grabPlane, planeHit)) {
        const worldDelta = planeHit.clone().sub(st.grabLast);
        st.grabLast.copy(planeHit);
        const invRot = new THREE.Matrix4().copy(st.target.object.matrixWorld).invert();
        invRot.setPosition(0, 0, 0);
        const localDelta = worldDelta.applyMatrix4(invRot);
        const changed = st.target.engine.grabMove(
          [localDelta.x, localDelta.y, localDelta.z],
          Math.min(1, this.settings.strength * 1.4)
        );
        st.target.applyChangedVertices(changed);
        st.dabs++;
        this.lastStroke.dabs = st.dabs;
        this.lastStroke.verts = Math.max(this.lastStroke.verts, changed.length);
        this.vp.needsRender = true;
      }
      return;
    }

    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [e];
    const list = events.length > 0 ? events : [e];
    for (const ev of list) {
      const hit = this.pickSurface(ev.clientX, ev.clientY);
      if (!hit || hit.target !== st.target) continue;
      this.applyDabAt(hit.localPoint, ev);
      this.updateHoverRing(hit.worldPoint, hit.worldNormal, st.worldR, hit.target);
    }
  }

  private applyDabAt(localPoint: THREE.Vector3, e: PointerEvent): void {
    const st = this.active;
    if (!st) return;

    const pressure =
      e.pointerType === 'pen' && this.settings.usePressure
        ? Math.max(0.05, Math.min(1, e.pressure || 0.5))
        : 1;
    this.lastStroke.minPressure = Math.min(this.lastStroke.minPressure, pressure);
    this.lastStroke.maxPressure = Math.max(this.lastStroke.maxPressure, pressure);

    let radiusScale = 1;
    if (e.pointerType === 'pen') {
      if (this.input.tiltWidens) radiusScale *= tiltScale(tiltFromVertical(e));
      if (this.input.pressureSize) radiusScale *= 0.5 + 0.5 * pressure;
    }
    this.lastStroke.maxRadiusScale = Math.max(this.lastStroke.maxRadiusScale, radiusScale);

    const effR = st.localR * radiusScale;
    const stepDist = Math.max(effR * 0.22, st.target.mesh.meanEdge * 0.5);

    const runDab = (pt: Vec3) => {
      const changed = st.target.engine.dab(pt, {
        radius: effR,
        strength: this.settings.strength,
        invert: st.invert,
        symmetry: this.settings.symmetry,
        pressure
      });
      st.target.applyChangedVertices(changed);
      st.dabs++;
      this.lastStroke.dabs = st.dabs;
      this.lastStroke.verts = Math.max(this.lastStroke.verts, changed.length);
    };

    if (!st.last) {
      runDab([localPoint.x, localPoint.y, localPoint.z]);
      st.last = localPoint.clone();
    } else {
      const dist = st.last.distanceTo(localPoint);
      if (dist >= stepDist * 0.4) {
        const steps = Math.min(12, Math.max(1, Math.ceil(dist / stepDist)));
        for (let i = 1; i <= steps; i++) {
          const p = st.last.clone().lerp(localPoint, i / steps);
          runDab([p.x, p.y, p.z]);
        }
        st.last.copy(localPoint);
      }
    }
    st.target.maintainBvh();
    this.vp.needsRender = true;
  }

  private updateHoverRing(
    worldPoint: THREE.Vector3,
    worldNormal: THREE.Vector3,
    worldR: number,
    target: RigSafeSculptTarget
  ): void {
    if (this.settings.symmetry.x) {
      const localP = target.object.worldToLocal(worldPoint.clone());
      localP.x = -localP.x;
      const mirrorWorldP = localP.applyMatrix4(target.object.matrixWorld);
      const mirrorN = worldNormal.clone();
      mirrorN.x = -mirrorN.x;
      this.vp.showBrushCursor(worldPoint, worldNormal, worldR, mirrorWorldP, mirrorN);
    } else {
      this.vp.showBrushCursor(worldPoint, worldNormal, worldR);
    }
  }

  private onUp(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    this.rejected.delete(e.pointerId);
    if (e.pointerType === 'pen') {
      this.pen.down = false;
      this.pen.lastT = performance.now();
    }
    if (!this.active || this.active.pointerId !== e.pointerId) return;

    const st = this.active;
    this.active = null;
    this.vp.controls.enabled = true;
    try {
      this.vp.renderer.domElement.releasePointerCapture(e.pointerId);
    } catch {
      // Ignore
    }

    const entry = st.target.engine.end((ids) => {
      st.target.applyChangedVertices(ids);
      st.target.endStrokeMaintenance();
      this.vp.needsRender = true;
    });
    st.target.endStrokeMaintenance();
    this.onCommitStroke(st.target, entry);
    this.vp.needsRender = true;
  }

  private onCancel(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    this.rejected.delete(e.pointerId);
    if (e.pointerType === 'pen') {
      this.pen.down = false;
      this.pen.lastT = performance.now();
    }
    if (this.active && this.active.pointerId === e.pointerId) {
      this.cancelActiveStroke();
    }
  }

  cancelActiveStroke(): void {
    if (!this.active) return;
    const st = this.active;
    this.active = null;
    this.vp.controls.enabled = true;
    const touched = st.target.engine.cancel();
    if (touched.length > 0) {
      st.target.applyChangedVertices(touched);
    }
    st.target.endStrokeMaintenance();
    this.vp.needsRender = true;
  }
}
