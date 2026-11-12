// Hotel Pandia's: the 3D mascot, running entirely in a Web Worker.
//
// Everything heavy (three.js itself, decoding the model, compiling shaders, drawing every frame)
// happens here, off the page's main thread, on an OffscreenCanvas. The page can therefore never
// stutter because of the mascot: scrolling, taps and text stay smooth even while he loads.
// The page (js/main.js) only sends small messages: the canvas, its size, how far the story has
// scrolled, where the pointer is, and taps.
//
// The GLB carries one ~10 s timeline (walk in, present tray, OK sign, spin). Scroll progress
// through the story scrubs that timeline, and he changes sides so each chapter's text has room.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const smooth = (t) => t * t * (3 - 2 * t);
function curve(pts, x, ease = true) {
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x0, y0] = pts[i - 1];
    if (x <= x1) {
      const t = (x - x0) / (x1 - x0 || 1);
      return y0 + (y1 - y0) * (ease ? smooth(t) : t);
    }
  }
  return pts[pts.length - 1][1];
}
const TIME = [
  [0, 2.55],
  [0.1, 3.4],
  [0.3, 5.3],
  [0.4, 5.6],
  [0.5, 6.6],
  [0.66, 7.7],
  [0.78, 8.3],
  [1, 10]
];
const SIDE = [
  [0, 1],
  [0.08, 1],
  [0.3, -1],
  [0.4, -1],
  [0.6, 1],
  [0.72, 1],
  [0.95, -1],
  [1, -1]
];

// Room lighting (what makes the gold shine) is baked into env/room-128.webp: a PMREM sheet with
// each channel stored as sqrt(v / (1 + v)). Expanding it here is a table lookup, instead of
// generating it live (which costs about a second of solid work).
async function roomLight(url) {
  const bmp = await createImageBitmap(await (await fetch(url)).blob());
  const { width: w, height: h } = bmp;
  const ctx = new OffscreenCanvas(w, h).getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const px = ctx.getImageData(0, 0, w, h).data;
  const lut = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    const t = Math.min((i / 255) ** 2, 0.9999);
    lut[i] = THREE.DataUtils.toHalfFloat(t / (1 - t));
  }
  const one = THREE.DataUtils.toHalfFloat(1);
  const data = new Uint16Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const row = (h - 1 - y) * w * 4;
    for (let x = 0; x < w * 4; x += 4) {
      const s = y * w * 4 + x;
      data[row + x] = lut[px[s]];
      data[row + x + 1] = lut[px[s + 1]];
      data[row + x + 2] = lut[px[s + 2]];
      data[row + x + 3] = one;
    }
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.mapping = THREE.CubeUVReflectionMapping;
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

// what the page tells us
const view = { w: 1, h: 1, dpr: 1, mobile: false, solo: false, progress: 0, visible: true };
const ptr = { x: 0, y: 0, seen: 0 };
let onResize = () => {};
let onTap = () => {};
let lastScroll = 0;

self.onmessage = ({ data: m }) => {
  if (m.type === "init") init(m).catch((err) => self.postMessage({ type: "error", message: String(err?.message || err) }));
  else if (m.type === "size") (Object.assign(view, m.view), onResize());
  else if (m.type === "scroll") ((view.progress = m.progress), (lastScroll = performance.now()));
  else if (m.type === "visible") view.visible = m.visible;
  else if (m.type === "pointer") ((ptr.x = m.x), (ptr.y = m.y), (ptr.seen = m.x === null ? 0 : performance.now() / 1e3));
  else if (m.type === "tap") ((ptr.x = m.x), (ptr.y = m.y), (ptr.seen = performance.now() / 1e3), onTap());
};

async function init({ canvas, model, env, reduce, lowEnd, intro, view: v }) {
  Object.assign(view, v);
  const mobile = () => view.mobile;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setClearColor(0, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.05;
  const scene = new THREE.Scene();
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  // the model and the lighting download side by side
  const [gltf, envTex] = await Promise.all([loader.loadAsync(model), roomLight(env)]);
  scene.environment = envTex;
  scene.environmentIntensity = 0.75;
  const key = new THREE.DirectionalLight(16773600, 2.2);
  key.position.set(-3, 5, 6);
  const rim = new THREE.DirectionalLight(16766888, 1.6);
  rim.position.set(3, 4, -5);
  scene.add(key, rim, new THREE.HemisphereLight(16774888, 5904914, 0.6));
  const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 100);
  const root = gltf.scene;
  const holder = new THREE.Group();
  holder.add(root);
  scene.add(holder);
  const hullMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: { uColor: { value: new THREE.Color("#3a1410") }, uThick: { value: 22e-4 } },
    vertexShader: `uniform float uThick;
      void main(){
        vec3 n = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        mv.xyz += n * uThick * (-mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `uniform vec3 uColor; void main(){ gl_FragColor = vec4(uColor, 1.0); }`
  });
  const SKIP_OUTLINE = /Rice|Onion|Mint|Steam|Eye|Lash|Brow|Placket|Lapel|Stripe|Knob|Grain|Jewel|Ring|Hem|Trim/i;
  const steam = [];
  const steamRest = /* @__PURE__ */ new Map();
  const meshes = [];
  root.traverse((o) => {
    const m = o;
    if (!m.isMesh) return;
    meshes.push(m);
  });
  const headSrc = root.getObjectByName("Head");
  const headAnchor = new THREE.Object3D();
  if (headSrc?.parent) {
    headAnchor.position.copy(headSrc.position);
    headSrc.parent.add(headAnchor);
  }
  const NORM = { Int8Array: 127, Uint8Array: 255, Int16Array: 32767, Uint16Array: 65535 };
  const toFloat = (g, m) => {
    const out = new THREE.BufferGeometry();
    for (const [name, a] of Object.entries(g.attributes)) {
      let arr;
      if (a.isInterleavedBufferAttribute) {
        arr = new Float32Array(a.count * a.itemSize);
        for (let i = 0; i < a.count; i++) for (let c = 0; c < a.itemSize; c++) arr[i * a.itemSize + c] = a.getComponent(i, c);
      } else {
        arr = Float32Array.from(a.array);
        const div = a.normalized ? NORM[a.array.constructor.name] : 0;
        if (div) for (let i = 0; i < arr.length; i++) arr[i] = Math.max(arr[i] / div, -1);
      }
      out.setAttribute(name, new THREE.BufferAttribute(arr, a.itemSize));
    }
    if (g.index) out.setIndex(new THREE.BufferAttribute(g.index.array.slice(), 1));
    out.applyMatrix4(m);
    return out;
  };
  const isSteam = (m) => /Steam/i.test(m.name) || /Steam/i.test(m.material.name);
  const outlined = (name) => !SKIP_OUTLINE.test(name);
  const groups = /* @__PURE__ */ new Map();
  for (const m of meshes) {
    if (isSteam(m) || m.children.length || !m.parent || m.isSkinnedMesh || Object.keys(m.geometry.morphAttributes).length) continue;
    const key2 = [m.parent.uuid, m.material.uuid, outlined(m.name), Object.keys(m.geometry.attributes).sort().join(), !!m.geometry.index].join("|");
    groups.set(key2, [...groups.get(key2) || [], m]);
  }
  for (const parts of groups.values()) {
    if (parts.length < 2) continue;
    const parent = parts[0].parent;
    const geoms = parts.map((m) => (m.updateMatrix(), toFloat(m.geometry, m.matrix)));
    const merged = mergeGeometries(geoms, false);
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, parts[0].material);
    mesh.name = parts.map((m) => m.name).join("+");
    parent.add(mesh);
    for (const m of parts) {
      parent.remove(m);
      meshes.splice(meshes.indexOf(m), 1);
    }
    meshes.push(mesh);
  }
  for (const m of meshes) {
    const mat = m.material;
    if (isSteam(m)) {
      const own = mat.clone();
      own.transparent = true;
      own.opacity = 0.4;
      own.depthWrite = false;
      m.material = own;
      m.geometry.computeBoundingBox();
      steamRest.set(m, { pos: m.position.clone(), scale: m.scale.clone(), foot: m.geometry.boundingBox.min.y });
      steam.push(m);
      continue;
    }
    if (mat.name === "Gold") {
      mat.metalness = 1;
      mat.roughness = 0.28;
    }
    if (outlined(m.name.split("+")[0]) && m.geometry.attributes.normal) {
      const hull = new THREE.Mesh(m.geometry, hullMat);
      hull.name = m.name + "_outline";
      hull.renderOrder = -1;
      m.add(hull);
    }
  }
  // soft contact shadow under his feet
  const sc = new OffscreenCanvas(128, 128);
  const sctx = sc.getContext("2d");
  const grd = sctx.createRadialGradient(64, 64, 4, 64, 64, 62);
  grd.addColorStop(0, "rgba(40,6,8,0.42)");
  grd.addColorStop(1, "rgba(40,6,8,0)");
  sctx.fillStyle = grd;
  sctx.fillRect(0, 0, 128, 128);
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(1.7, 1),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(sc), transparent: true, depthWrite: false })
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 5e-3;
  holder.add(shadow);
  const mixer = new THREE.AnimationMixer(root);
  for (const clip of gltf.animations) {
    const a = mixer.clipAction(clip);
    a.setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = true;
    a.play();
  }
  const DURATION = Math.max(...gltf.animations.map((c) => c.duration), 10);
  const chest = root.getObjectByName("Chest");
  const neck = root.getObjectByName("Neck");
  const head = headSrc?.parent ? headAnchor : neck;
  const neckPose = neck ? neck.quaternion.clone() : null;
  const headMeshes = [];
  neck?.traverse((o) => o.isMesh && !o.name.endsWith("_outline") && headMeshes.push(o));
  const raycaster = new THREE.Raycaster();
  const headNdc = new THREE.Vector3();
  let maxDpr = lowEnd ? 1 : 1.5;
  let halfW = 1;
  function resize() {
    const { w, h } = view;
    renderer.setPixelRatio(Math.min(view.dpr || 1, maxDpr));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // solo: he stands alone in his own box (the landing page); otherwise the full-screen scroll story
    const share = view.solo ? 0.9 : mobile() ? 0.46 : 0.74;
    const fovR = THREE.MathUtils.degToRad(camera.fov);
    const dist = 2.75 / share / (2 * Math.tan(fovR / 2));
    camera.position.set(0, !view.solo && mobile() ? 1.25 - 0.8 : 1.25, dist);
    camera.lookAt(0, !view.solo && mobile() ? 1.25 - 0.8 : 1.2, 0);
    camera.updateProjectionMatrix();
    halfW = Math.tan(fovR / 2) * dist * camera.aspect;
  }
  onResize = resize;
  let tShown = 0;
  let xShown = 0;
  let introT = reduce || !intro ? 1 : 0;
  const introStart = performance.now();
  let yaw = 0;
  let pitch = 0;
  let nodAt = -10;
  let sinceRender = 1;
  let slowFrames = 0;
  const sideX = (side) => {
    if (view.solo) return 0;
    const m = mobile();
    if (m) return side * halfW * 0.07;
    return side * clamp(halfW * (side < 0 ? 0.5 : 0.6), 0.9, 3.2); // a little further in on the left: the tray sticks out that way
  };
  const startedAtTop = view.progress < 0.02;
  let lastNow = performance.now();
  let announced = false;
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, Math.max(0, (now - lastNow) / 1e3));
    lastNow = now;
    if (!view.visible) return;
    const progress = view.progress;
    const kT = 1 - Math.exp(-dt * 7.5);
    const kX = 1 - Math.exp(-dt * 6);
    if (introT < 1) introT = startedAtTop ? clamp((now - introStart) / 2600) : 1;
    const scrollT = curve(TIME, progress);
    const targetT = introT < 1 ? 2.55 * introT : scrollT;
    tShown += (targetT - tShown) * (introT < 1 ? 1 : kT);
    const side = curve(SIDE, progress);
    const homeX = sideX(side);
    const offX = -halfW - 1.4;
    const targetX = introT < 1 ? offX + (homeX - offX) * smooth(clamp(introT * 1.05)) : homeX;
    xShown += (targetX - xShown) * (introT < 1 ? 1 : kX);
    if (neck && neckPose) neck.quaternion.copy(neckPose);
    const settled = introT >= 1 && Math.abs(targetT - tShown) < 2e-3 && Math.abs(targetX - xShown) < 2e-3 && now / 1e3 - ptr.seen > 0.4 && now - lastScroll > 300 && now / 1e3 - nodAt > 1;
    sinceRender += dt;
    if (settled && sinceRender < 1 / 31) return;
    if (!settled && dt > 0.024) {
      if (++slowFrames > 45 && maxDpr > 1) {
        maxDpr = Math.max(1, maxDpr - 0.25);
        slowFrames = 0;
        resize();
      }
    } else slowFrames = Math.max(0, slowFrames - 1);
    sinceRender = 0;
    mixer.setTime(clamp(tShown, 0, DURATION - 1e-3));
    if (neck && neckPose) neckPose.copy(neck.quaternion);
    holder.position.x = xShown;
    const faceText = introT < 1 || mobile() || view.solo ? 0 : -side * 0.42;
    holder.rotation.y += (faceText - holder.rotation.y) * kX;
    const s = now / 1e3;
    if (!reduce) {
      if (chest) chest.scale.setScalar(1 + Math.sin(s * 2.2) * 0.012);
      if (neck && introT >= 1) {
        holder.updateMatrixWorld();
        head.getWorldPosition(headNdc).project(camera);
        const active = s - ptr.seen < 2.5;
        const gain = 1 - 0.6 * clamp((progress - 0.04) / 0.1);
        let ty, tp;
        if (active) {
          ty = clamp((ptr.x - headNdc.x) * 0.9, -1, 1) * 0.75 * gain;
          tp = clamp((headNdc.y - ptr.y) * 0.8, -1, 1) * 0.32 * gain;
        } else {
          ty = -side * 0.22 + Math.sin(s * 0.45) * 0.16 + Math.sin(s * 1.1) * 0.04;
          tp = 0.05 + Math.sin(s * 0.7 + 1) * 0.05;
        }
        const k = 1 - Math.exp(-dt * (active ? 6 : 2));
        yaw += (ty - yaw) * k;
        pitch += (tp - pitch) * k;
        const nt = s - nodAt;
        const nod = nt < 0.9 ? Math.sin(nt * Math.PI * 2.2) * 0.32 * (1 - nt / 0.9) : 0;
        neck.rotateY(yaw);
        neck.rotateX(pitch + nod);
        neck.rotateZ(-yaw * 0.18);
      }
      steam.forEach((m, i) => {
        const rest = steamRest.get(m);
        const p = (s / (2.8 + i * 0.5) + i * 0.5) % 1;
        const f = 0.85 + 0.3 * p;
        m.material.opacity = 0.05 + 0.4 * Math.sin(Math.PI * p);
        m.scale.set(rest.scale.x, rest.scale.y * f, rest.scale.z);
        m.position.y = rest.pos.y + rest.scale.y * rest.foot * (1 - f) + 0.1 * p;
        m.position.x = rest.pos.x + 0.012 * Math.sin(s * 1.6 + i * 2);
      });
    }
    renderer.render(scene, camera);
    if (!announced) ((announced = true), self.postMessage({ type: "ready" }));
  }
  onTap = () => {
    if (!view.visible) return;
    raycaster.setFromCamera(new THREE.Vector2(ptr.x, ptr.y), camera);
    if (raycaster.intersectObjects(headMeshes, false).length) nodAt = performance.now() / 1e3;
  };
  resize();
  const walkIn = startedAtTop && !reduce && intro;
  tShown = walkIn ? 0 : curve(TIME, view.progress);
  xShown = walkIn ? -halfW - 1.4 : sideX(curve(SIDE, view.progress));
  // compile every shader before the first frame (in parallel where the GPU driver allows)
  try {
    await renderer.compileAsync?.(scene, camera);
  } catch {}
  requestAnimationFrame(frame);
}
