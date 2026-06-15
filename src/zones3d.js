// 3D zone view (Three.js): zone-surface meshes from epJSON geometry,
// orbit/zoom/pick interaction, and the temperature-heatmap overlay synced
// to the shared selection + playback time. Reads app state via live ES
// module bindings; calls back into selection for zone picking.
import * as THREE from 'three';
import {
  $, upper, geometry, currentTheme, playbackStats, selection, zoneOpacity,
  hiddenZones, selectedTimeIndex, zoneSeriesFor, selectZone, clearSelection,
  scopeZoneNames
} from './app.js';
import { colorForTemperature } from './palette.js';

let threeView = null;

export function renderZones3d() {
  if (!geometry || !geometry.zones.length) {
    $('zone3dEmpty').style.display = 'flex';
    $('zone3dEmpty').textContent = 'No BuildingSurface:Detailed zone geometry found.';
    return;
  }
  if (typeof THREE === 'undefined') {
    $('zone3dEmpty').style.display = 'flex';
    $('zone3dEmpty').textContent = 'Three.js did not load; check network access.';
    return;
  }
  $('zone3dEmpty').style.display = 'none';
  if (!threeView) {
    try {
      initThree();
    } catch (error) {
      $('zone3dEmpty').style.display = 'flex';
      $('zone3dEmpty').textContent = `3D view unavailable — WebGL context failed (${error.message}).`;
      return;
    }
  }
  // dispose old GPU resources before dropping the meshes, or repeated
  // dataset switches leak geometries/materials on the GPU
  for (const child of threeView.zoneGroup.children) {
    if (child.geometry) child.geometry.dispose();
    if (child.material) child.material.dispose();
  }
  threeView.zoneGroup.clear();

  const center = boundsCenter(geometry.bounds);
  for (const zone of geometry.zones) {
    const color = colorForZoneStatic(zone.name);
    for (const surface of zone.surfaces) {
      const mesh = meshForSurface(surface, center, color);
      mesh.userData.zoneName = zone.name;
      mesh.userData.baseColor = color;
      threeView.zoneGroup.add(mesh);
      const edge = edgeLinesForSurface(surface, center);
      edge.userData.zoneName = zone.name; // tagged so it hides with its zone
      edge.userData.isEdge = true;
      threeView.zoneGroup.add(edge);
    }
  }
  fitThreeCamera();
  updateZoneHighlights();
}

function initThree() {
  const root = $('zone3d');
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(currentTheme === 'light' ? 0xeef1f5 : 0x0e1219);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100000);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  root.appendChild(renderer.domElement);
  const zoneGroup = new THREE.Group();
  scene.add(zoneGroup);
  scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x20242c, 1.5));
  const light = new THREE.DirectionalLight(0xffffff, 1.1);
  light.position.set(80, 120, 80);
  scene.add(light);
  threeView = {
    scene, camera, renderer, zoneGroup,
    raycaster: new THREE.Raycaster(),
    pointer: new THREE.Vector2(),
    dragging: false, last: null, moved: false
  };
  root.addEventListener('pointerdown', onThreePointerDown);
  root.addEventListener('pointermove', onThreePointerMove);
  root.addEventListener('pointerup', onThreePointerUp);
  // leaving the area only cancels an in-progress orbit — it must NOT pick
  // (that cleared the selection whenever the mouse left the 3D pane)
  root.addEventListener('pointerleave', onThreePointerLeave);
  root.addEventListener('wheel', onThreeWheel, { passive: false });
  // window resize is handled by the single combined listener (resizeThree
  // + alignScrubber) at module scope — no separate listener here
  resizeThree();
}

function meshForSurface(surface, center, color) {
  const positions = surface.vertices.map(v => toThreeVector(v, center));
  const indices = [];
  for (let i = 1; i < positions.length - 1; i++) indices.push(0, i, i + 1);
  const geo = new THREE.BufferGeometry();
  geo.setFromPoints(positions);
  geo.setIndex(indices);
  geo.computeVertexNormals();
  const material = new THREE.MeshLambertMaterial({
    color, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false
  });
  return new THREE.Mesh(geo, material);
}

function edgeLinesForSurface(surface, center) {
  const points = surface.vertices.map(v => toThreeVector(v, center));
  points.push(points[0]);
  const geo = new THREE.BufferGeometry().setFromPoints(points);
  const material = new THREE.LineBasicMaterial({ color: 0x46546b, transparent: true, opacity: 0.7 });
  return new THREE.Line(geo, material);
}

function toThreeVector(v, center) {
  return new THREE.Vector3(v.x - center.x, v.z - center.z, -(v.y - center.y));
}

function boundsCenter(bounds) {
  return {
    x: (bounds.min.x + bounds.max.x) / 2,
    y: (bounds.min.y + bounds.max.y) / 2,
    z: (bounds.min.z + bounds.max.z) / 2
  };
}

// bounds of the currently-visible (non-hidden) zones, in model space
function visibleZoneBounds() {
  if (!geometry) return null;
  const b = { min: { x: Infinity, y: Infinity, z: Infinity }, max: { x: -Infinity, y: -Infinity, z: -Infinity } };
  let any = false;
  for (const z of geometry.zones) {
    if (hiddenZones.has(upper(z.name))) continue;
    for (const surf of z.surfaces) for (const v of surf.vertices) {
      any = true;
      b.min.x = Math.min(b.min.x, v.x); b.max.x = Math.max(b.max.x, v.x);
      b.min.y = Math.min(b.min.y, v.y); b.max.y = Math.max(b.max.y, v.y);
      b.min.z = Math.min(b.min.z, v.z); b.max.z = Math.max(b.max.z, v.z);
    }
  }
  return any ? b : geometry.bounds;
}

// frame the visible zones (so hiding some zooms to extents); meshes are
// positioned relative to the full-building center, so look at the visible
// centroid in that frame
export function fitThreeCamera() {
  if (!threeView || !geometry) return;
  const b = visibleZoneBounds();
  if (!b) return;
  const span = Math.max(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z, 1);
  const fc = boundsCenter(geometry.bounds);
  const vc = { x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2, z: (b.min.z + b.max.z) / 2 };
  const t = toThreeVector(vc, fc);
  threeView.zoneGroup.rotation.set(0, 0, 0);
  threeView.camera.position.set(t.x + span * 0.95, t.y + span * 0.65, t.z + span * 0.95);
  threeView.camera.near = Math.max(span / 1000, 0.01);
  threeView.camera.far = span * 10;
  threeView.camera.lookAt(t.x, t.y, t.z);
  threeView.camera.updateProjectionMatrix();
  renderThree();
}

export function resizeThree() {
  if (!threeView) return;
  const root = $('zone3d');
  const width = Math.max(root.clientWidth, 1);
  const height = Math.max(root.clientHeight, 1);
  threeView.renderer.setSize(width, height, false);
  threeView.camera.aspect = width / height;
  threeView.camera.updateProjectionMatrix();
  renderThree();
}

function renderThree() {
  if (threeView) threeView.renderer.render(threeView.scene, threeView.camera);
}

// Selected zone glows amber; others heatmap by zone temp (dimmed when a
// selection exists) or fall back to the static palette.
export function updateZoneHighlights() {
  if (!threeView) return;
  const s = playbackStats || {};
  const selectedZone = selection && selection.zoneName ? upper(selection.zoneName) : null;
  for (const child of threeView.zoneGroup.children) {
    const zn = child.userData.zoneName;
    if (!zn || !child.material) continue;
    child.visible = true;
    const inactive = hiddenZones.has(upper(zn)); // toggled off in the tree
    if (child.userData.isEdge) {
      // edges carry no heatmap — just an opacity for active vs inactive
      child.material.opacity = inactive ? 0.12 : 0.7;
      continue;
    }
    if (inactive) {
      // off on the branch graph, but kept as faint translucent context in 3D
      child.material.color.setHex(child.userData.baseColor);
      child.material.opacity = 0.05;
      continue;
    }
    const isSel = selectedZone && upper(zn) === selectedZone;
    if (isSel) {
      // the focused zone is always fully opaque; the slider only fades the
      // surrounding context (or the whole building when nothing is selected)
      child.material.color.set('#ffc66b');
      child.material.opacity = 1;
      continue;
    }
    // isolate: a zone the selection doesn't engage fades to faint context
    if (scopeZoneNames && !scopeZoneNames.has(upper(zn))) {
      child.material.color.setHex(child.userData.baseColor);
      child.material.opacity = 0.06;
      continue;
    }
    const series = zoneSeriesFor(zn);
    const temp = series && series.temperature && series.temperature.values[selectedTimeIndex];
    if (Number.isFinite(temp)) {
      child.material.color.set(colorForTemperature(temp, s.zoneMin, s.zoneMax));
      child.material.opacity = zoneOpacity;
    } else {
      child.material.color.setHex(child.userData.baseColor);
      child.material.opacity = zoneOpacity * 0.7;
    }
  }
  renderThree();
}

function colorForZoneStatic(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  const color = new THREE.Color();
  color.setHSL(hue / 360, 0.3, 0.45);
  return color.getHex();
}

function onThreePointerDown(event) {
  if (!threeView) return;
  threeView.dragging = true;
  threeView.last = { x: event.clientX, y: event.clientY };
  threeView.moved = false;
}

function onThreePointerMove(event) {
  if (!threeView || !threeView.dragging || !threeView.last) return;
  const dx = event.clientX - threeView.last.x;
  const dy = event.clientY - threeView.last.y;
  if (Math.abs(dx) + Math.abs(dy) > 2) threeView.moved = true;
  threeView.zoneGroup.rotation.y += dx * 0.006;
  threeView.zoneGroup.rotation.x += dy * 0.006;
  threeView.last = { x: event.clientX, y: event.clientY };
  renderThree();
}

function onThreePointerUp(event) {
  if (!threeView) return;
  const moved = threeView.moved;
  threeView.dragging = false;
  if (!moved) pickThreeZone(event); // a click (no drag) selects/deselects
}

// mouse left the 3D pane: just end any orbit — never pick/clear
function onThreePointerLeave() {
  if (threeView) { threeView.dragging = false; threeView.moved = false; }
}

function onThreeWheel(event) {
  if (!threeView) return;
  event.preventDefault();
  const factor = event.deltaY > 0 ? 1.12 : 0.88;
  threeView.camera.position.multiplyScalar(factor);
  renderThree();
}

function pickThreeZone(event) {
  const rect = $('zone3d').getBoundingClientRect();
  threeView.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  threeView.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  threeView.raycaster.setFromCamera(threeView.pointer, threeView.camera);
  const hits = threeView.raycaster.intersectObjects(threeView.zoneGroup.children, false)
    .filter(hit => hit.object.userData.zoneName);
  if (hits.length) selectZone(hits[0].object.userData.zoneName);
  else clearSelection();
}

// re-apply theme-dependent scene chrome (called from app.js theme toggle)
export function applyTheme3d() {
  if (!threeView) return;
  threeView.scene.background = new THREE.Color(currentTheme === 'light' ? 0xeef1f5 : 0x0e1219);
  updateZoneHighlights();
}
