/**
 * PaisaPilot 3D Motion & Accessible 2D Visualization Engine
 * Lazy-loads local Three.js (/vendor/three/three.module.min.js) only when WebGL + 3D mode are active.
 * Always provides an equivalent accessible 2D SVG fallback for reduced-motion or low-power devices.
 */

let threePromise = null;
const activeCleanups = new Map();

function canUseWebGL() {
  try {
    const c = document.createElement('canvas');
    return Boolean(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch {
    return false;
  }
}

export function shouldUse3D(userPrefEnable3D, userReducedMotion) {
  if (!userPrefEnable3D || userReducedMotion) return false;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  // Avoid forcing WebGL on very low-memory devices
  if (navigator.deviceMemory && navigator.deviceMemory < 2) return false;
  return canUseWebGL();
}

async function loadThree() {
  if (!threePromise) {
    threePromise = import('/vendor/three/three.module.min.js');
  }
  return threePromise;
}

export function cleanupScene(key) {
  const fn = activeCleanups.get(key);
  if (fn) {
    try { fn(); } catch {}
    activeCleanups.delete(key);
  }
}

export function cleanupAllScenes() {
  for (const key of Array.from(activeCleanups.keys())) {
    cleanupScene(key);
  }
}

function fmtINR(paise) {
  const v = Number(paise || 0) / 100;
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(v);
}

/**
 * 2D Fallback for Hero Orb & Budget Ring
 */
function renderHero2DFallback(container, summary) {
  const spent = summary.netSpentPaise || 0;
  const budget = summary.overallBudgetPaise || 0;
  const income = summary.incomePaise || 0;
  const pct = budget > 0 ? Math.min(100, Math.round((spent / budget) * 100)) : 0;
  const dash = 2 * Math.PI * 58;
  const offset = dash * (1 - pct / 100);
  const ringColor = pct >= 95 ? '#F87171' : pct >= 75 ? '#FBBF24' : '#10B981';

  container.innerHTML = `
    <div class="flex h-full min-h-[290px] flex-col items-center justify-center gap-3.5 p-5">
      <svg width="160" height="160" viewBox="0 0 150 150" role="img" aria-label="Monthly budget progress ${pct}%">
        <circle cx="75" cy="75" r="58" fill="none" stroke="rgba(148,163,184,0.2)" stroke-width="12"/>
        <circle cx="75" cy="75" r="58" fill="none" stroke="${ringColor}" stroke-width="12"
          stroke-linecap="round" stroke-dasharray="${dash.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}"
          transform="rotate(-90 75 75)" style="transition:stroke-dashoffset 500ms ease;"/>
        <text x="75" y="70" text-anchor="middle" fill="currentColor" font-size="22" font-weight="700">${budget > 0 ? pct + '%' : 'No Limit'}</text>
        <text x="75" y="92" text-anchor="middle" fill="#94A3B8" font-size="11">${budget > 0 ? 'of budget' : 'Set a budget'}</text>
      </svg>
      <div class="flex flex-wrap items-center justify-center gap-2">
        <span class="pp-pill pp-pill-verified">Income: ${fmtINR(income)}</span>
        <span class="pp-pill pp-pill-captured">Spent: ${fmtINR(spent)}</span>
        ${budget > 0 ? `<span class="pp-pill pp-pill-neutral">Remaining: ${fmtINR(Math.max(0, budget - spent))}</span>` : ''}
      </div>
    </div>
  `;
}

/**
 * Scene 1: 3D Financial Orb, Monthly Budget Torus Ring, and Layered Coin Stacks
 */
export async function mountDashboardHero3D(container, summary, { enable3d, reducedMotion }) {
  cleanupScene('hero');
  if (!container) return;

  if (!shouldUse3D(enable3d, reducedMotion)) {
    renderHero2DFallback(container, summary);
    return;
  }

  let THREE;
  try {
    THREE = await loadThree();
  } catch {
    renderHero2DFallback(container, summary);
    return;
  }

  container.innerHTML = '';
  const width = container.clientWidth || 520;
  const height = 290;

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  } catch {
    renderHero2DFallback(container, summary);
    return;
  }

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width, height);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 100);
  camera.position.set(0, 1.35, 6.2);
  camera.lookAt(0, 0.1, 0);

  // Lighting
  scene.add(new THREE.AmbientLight(0xdbeafe, 0.85));
  const keyLight = new THREE.DirectionalLight(0x38bdf8, 1.8);
  keyLight.position.set(4, 6, 5);
  scene.add(keyLight);
  const rimLight = new THREE.PointLight(0x10b981, 2.2, 16);
  rimLight.position.set(-4, 2, 3);
  scene.add(rimLight);

  const rootGroup = new THREE.Group();
  scene.add(rootGroup);

  const spent = summary.netSpentPaise || 0;
  const income = summary.incomePaise || 0;
  const budget = summary.overallBudgetPaise || 0;
  const budgetRatio = budget > 0 ? Math.min(1.15, spent / budget) : 0.35;
  const orbHex = budgetRatio >= 0.95 ? 0xf87171 : budgetRatio >= 0.75 ? 0xfbbf24 : 0x10b981;

  // Central Financial Orb
  const orbGeo = new THREE.IcosahedronGeometry(0.95, 2);
  const orbMat = new THREE.MeshStandardMaterial({
    color: orbHex,
    emissive: orbHex,
    emissiveIntensity: 0.24,
    roughness: 0.22,
    metalness: 0.45
  });
  const orbMesh = new THREE.Mesh(orbGeo, orbMat);
  orbMesh.position.set(-0.7, 0.15, 0);
  rootGroup.add(orbMesh);

  // Wireframe orbital shell
  const wireGeo = new THREE.IcosahedronGeometry(1.18, 1);
  const wireMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8, wireframe: true, transparent: true, opacity: 0.28 });
  const wireMesh = new THREE.Mesh(wireGeo, wireMat);
  wireMesh.position.copy(orbMesh.position);
  rootGroup.add(wireMesh);

  // 3D Monthly Budget Ring (back track + active arc)
  const trackGeo = new THREE.TorusGeometry(1.52, 0.08, 16, 64);
  const trackMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.5, metalness: 0.3 });
  const trackRing = new THREE.Mesh(trackGeo, trackMat);
  trackRing.position.copy(orbMesh.position);
  trackRing.rotation.x = 0.45;
  rootGroup.add(trackRing);

  const arcLen = Math.max(0.15, Math.min(Math.PI * 2, (budget > 0 ? Math.min(1, spent / budget) : 0.25) * Math.PI * 2));
  const arcGeo = new THREE.TorusGeometry(1.52, 0.11, 20, 64, arcLen);
  const arcMat = new THREE.MeshStandardMaterial({
    color: orbHex,
    emissive: orbHex,
    emissiveIntensity: 0.35,
    roughness: 0.25,
    metalness: 0.6
  });
  const arcRing = new THREE.Mesh(arcGeo, arcMat);
  arcRing.position.copy(orbMesh.position);
  arcRing.rotation.x = 0.45;
  arcRing.rotation.z = Math.PI / 2;
  rootGroup.add(arcRing);

  // Layered 3D Coin Stacks (Income, Spent, Remaining)
  const maxVal = Math.max(income, spent, budget, 10000);
  const coinStacks = [
    { label: 'Income', val: income, x: 1.45, color: 0x22c55e },
    { label: 'Spent', val: spent, x: 2.25, color: 0x38bdf8 },
    { label: 'Remaining', val: Math.max(0, (budget || income) - spent), x: 3.05, color: 0x818cf8 }
  ];
  const coinGeo = new THREE.CylinderGeometry(0.32, 0.32, 0.09, 28);
  const stackMeshes = [];
  for (const st of coinStacks) {
    const count = Math.max(1, Math.min(12, Math.round((st.val / maxVal) * 11) + 1));
    const mat = new THREE.MeshStandardMaterial({ color: st.color, metalness: 0.65, roughness: 0.25 });
    for (let i = 0; i < count; i++) {
      const coin = new THREE.Mesh(coinGeo, mat);
      coin.position.set(st.x, -0.85 + i * 0.13, 0);
      rootGroup.add(coin);
      stackMeshes.push({ mesh: coin, baseY: coin.position.y, phase: i * 0.35 });
    }
  }

  // Subtle floating ambient particles
  const pCount = 36;
  const pPos = new Float32Array(pCount * 3);
  for (let i = 0; i < pCount; i++) {
    pPos[i * 3] = (Math.random() - 0.5) * 7.5;
    pPos[i * 3 + 1] = (Math.random() - 0.3) * 3.5;
    pPos[i * 3 + 2] = (Math.random() - 0.5) * 3.5;
  }
  const pGeo = new THREE.BufferGeometry();
  pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
  const pMat = new THREE.PointsMaterial({ color: 0x7dd3fc, size: 0.045, transparent: true, opacity: 0.55 });
  const particles = new THREE.Points(pGeo, pMat);
  scene.add(particles);

  // Overlay synchronized HUD (so exact INR values are always crisp & accessible)
  const topLabel = document.createElement('div');
  topLabel.className = 'scene-hud-top';
  topLabel.textContent = 'Live 3D Money Pulse';
  container.appendChild(topLabel);

  const hud = document.createElement('div');
  hud.className = 'scene-hud';
  hud.innerHTML = `
    <div>
      <div class="small muted">Monthly Budget Ring</div>
      <div style="font-weight:700;font-size:1.05rem;">${budget > 0 ? `${summary.budgetUsedPercent}% used` : 'No budget limit set'}</div>
    </div>
    <div style="text-align:right;">
      <div class="small muted">Income vs Net Spent</div>
      <div style="font-weight:700;font-size:0.95rem;">${fmtINR(income)} / ${fmtINR(spent)}</div>
    </div>
  `;
  container.appendChild(hud);

  let targetRotY = 0;
  let targetRotX = 0;
  const onPointerMove = (e) => {
    const rect = container.getBoundingClientRect();
    const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ny = ((e.clientY - rect.top) / rect.height) * 2 - 1;
    targetRotY = nx * 0.35;
    targetRotX = ny * 0.16;
  };
  container.addEventListener('pointermove', onPointerMove);

  const onResize = () => {
    const w = container.clientWidth || 520;
    camera.aspect = w / height;
    camera.updateProjectionMatrix();
    renderer.setSize(w, height);
  };
  window.addEventListener('resize', onResize);

  let rafId = null;
  const clock = new THREE.Clock();

  const animate = () => {
    if (document.hidden) {
      rafId = null;
      return;
    }
    const t = clock.getElapsedTime();
    orbMesh.rotation.y = t * 0.28;
    wireMesh.rotation.y = -t * 0.18;
    rootGroup.rotation.y += (targetRotY - rootGroup.rotation.y) * 0.06;
    rootGroup.rotation.x += (targetRotX - rootGroup.rotation.x) * 0.06;
    particles.rotation.y = t * 0.04;

    for (const s of stackMeshes) {
      s.mesh.position.y = s.baseY + Math.sin(t * 1.4 + s.phase) * 0.015;
    }
    renderer.render(scene, camera);
    rafId = requestAnimationFrame(animate);
  };

  const onVisibility = () => {
    if (!document.hidden && rafId === null) {
      animate();
    }
  };
  document.addEventListener('visibilitychange', onVisibility);
  animate();

  activeCleanups.set('hero', () => {
    if (rafId !== null) cancelAnimationFrame(rafId);
    container.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('resize', onResize);
    document.removeEventListener('visibilitychange', onVisibility);
    renderer.dispose();
    orbGeo.dispose(); orbMat.dispose();
    wireGeo.dispose(); wireMat.dispose();
    trackGeo.dispose(); trackMat.dispose();
    arcGeo.dispose(); arcMat.dispose();
    coinGeo.dispose(); pGeo.dispose(); pMat.dispose();
  });
}

/**
 * 2D Interactive Fallback for Category Explorer
 */
function renderCategory2DFallback(container, categories, onSelect) {
  if (!categories || categories.length === 0) {
    container.innerHTML = `<div class="flex flex-col items-center justify-center gap-2 p-6 text-center"><img src="/images/empty-transactions.svg" alt="" width="128"><div class="text-xs text-slate-300">Add expenses to inspect category segments.</div></div>`;
    return;
  }
  const top = categories.slice(0, 7);
  container.innerHTML = `
    <div class="flex flex-col gap-2 p-3.5">
      ${top.map((c, idx) => `
        <button type="button" class="flex w-full items-center justify-between rounded-xl border border-slate-700/60 bg-slate-900/70 px-3 py-2 text-left text-xs text-slate-100 transition hover:border-sky-400/60" data-cat-idx="${idx}">
          <span class="flex items-center gap-2"><img src="${c.iconPath}" alt="" width="22" height="22"><span>${c.name}</span></span>
          <span><strong>${fmtINR(c.totalPaise)}</strong> <span class="text-slate-400">(${c.sharePercent}%)</span></span>
        </button>
      `).join('')}
    </div>
  `;
  container.querySelectorAll('[data-cat-idx]').forEach((btn) => {
    btn.addEventListener('click', () => onSelect(top[Number(btn.dataset.catIdx)]));
  });
}

/**
 * Scene 2: Interactive 3D Category Segment Explorer
 */
export async function mountCategoryExplorer3D(container, categories, onSelect, { enable3d, reducedMotion }) {
  cleanupScene('categories');
  if (!container) return;

  if (!categories || categories.length === 0 || !shouldUse3D(enable3d, reducedMotion)) {
    renderCategory2DFallback(container, categories, onSelect);
    return;
  }

  let THREE;
  try {
    THREE = await loadThree();
  } catch {
    renderCategory2DFallback(container, categories, onSelect);
    return;
  }

  container.innerHTML = '';
  const topCats = categories.slice(0, 8);
  const width = container.clientWidth || 440;
  const height = 290;

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch {
    renderCategory2DFallback(container, categories, onSelect);
    return;
  }

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width, height);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 100);
  camera.position.set(0, 2.5, 4.8);
  camera.lookAt(0, 0.2, 0);

  scene.add(new THREE.AmbientLight(0xe2e8f0, 0.9));
  const dir = new THREE.DirectionalLight(0xffffff, 1.4);
  dir.position.set(3, 6, 4);
  scene.add(dir);

  const carousel = new THREE.Group();
  scene.add(carousel);

  // Base disc
  const baseGeo = new THREE.CylinderGeometry(2.15, 2.25, 0.12, 48);
  const baseMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, metalness: 0.5, roughness: 0.4 });
  carousel.add(new THREE.Mesh(baseGeo, baseMat));

  const maxCatPaise = Math.max(...topCats.map((c) => c.totalPaise), 1);
  const pillars = [];
  topCats.forEach((cat, idx) => {
    const angle = (idx / topCats.length) * Math.PI * 2;
    const radius = 1.42;
    const h = Math.max(0.35, (cat.totalPaise / maxCatPaise) * 1.9);
    const geo = new THREE.CylinderGeometry(0.26, 0.28, h, 24);
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(cat.color || '#38BDF8'),
      roughness: 0.28,
      metalness: 0.4
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(Math.cos(angle) * radius, h / 2 + 0.06, Math.sin(angle) * radius);
    mesh.userData = { cat, idx };
    carousel.add(mesh);
    pillars.push({ mesh, geo, mat });
  });

  const topLabel = document.createElement('div');
  topLabel.className = 'scene-hud-top';
  topLabel.textContent = '3D Category Explorer (Drag or Click)';
  container.appendChild(topLabel);

  const hud = document.createElement('div');
  hud.className = 'scene-hud';
  const updateHud = (cat) => {
    hud.innerHTML = `
      <div>
        <div class="small muted">Selected Category</div>
        <div style="font-weight:700;">${cat.name} (${cat.count} txns)</div>
      </div>
      <div style="text-align:right;">
        <div class="small muted">Share: ${cat.sharePercent}%</div>
        <div style="font-weight:700;color:${cat.color};">${fmtINR(cat.totalPaise)}</div>
      </div>
    `;
  };
  updateHud(topCats[0]);
  container.appendChild(hud);

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let dragging = false;
  let lastX = 0;
  let rotOffset = 0;

  const onDown = (e) => { dragging = true; lastX = e.clientX; };
  const onMove = (e) => {
    if (!dragging) return;
    rotOffset += (e.clientX - lastX) * 0.01;
    lastX = e.clientX;
  };
  const onUp = (e) => {
    const moved = Math.abs(e.clientX - lastX);
    dragging = false;
    if (moved < 5) {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(pillars.map((p) => p.mesh));
      if (hits.length > 0) {
        const hitCat = hits[0].object.userData.cat;
        updateHud(hitCat);
        if (onSelect) onSelect(hitCat);
      }
    }
  };

  renderer.domElement.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);

  let rafId = null;
  const animate = () => {
    if (document.hidden) { rafId = null; return; }
    carousel.rotation.y += (rotOffset - carousel.rotation.y) * 0.12;
    if (!dragging) rotOffset += 0.0022;
    renderer.render(scene, camera);
    rafId = requestAnimationFrame(animate);
  };
  const onVis = () => { if (!document.hidden && rafId === null) animate(); };
  document.addEventListener('visibilitychange', onVis);
  animate();

  activeCleanups.set('categories', () => {
    if (rafId !== null) cancelAnimationFrame(rafId);
    renderer.domElement.removeEventListener('pointerdown', onDown);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    document.removeEventListener('visibilitychange', onVis);
    renderer.dispose();
    baseGeo.dispose(); baseMat.dispose();
    pillars.forEach((p) => { p.geo.dispose(); p.mat.dispose(); });
  });
}
