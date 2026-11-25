// =========================================================================
// 汽車模組：3D 車輛模型（雙色雙門轎跑）＋甩尾白煙
//
// 用法（index.html 主程式）：
//   const car = createCar(scene, renderer);
//   car.group          // 車體 Group（driving 模組每幀設定位置與姿態）
//   car.wheelMeshes    // [{ pivot, mesh, front }]：pivot 轉向（rotation.y）、mesh 滾動（rotation.x）
//   car.brakeLightMat  // 煞車燈材質（driving 模組踩煞車時調亮）
//   car.spawnDriftSmoke(worldPos)
//   car.updateEffects(dt)  // 每幀更新白煙粒子
//
// 座標：車頭朝 +Z、+Y 向上、原點在車底中心地面；長約 4.4 m、寬 1.8 m、高 1.4 m
// 車身用「沿車長的斷面放樣」建成：每個斷面是超橢圓，前後輪處抬高底緣形成輪拱開口
// =========================================================================
(function () {
  const sgnPow = (v, e) => Math.sign(v) * Math.pow(Math.abs(v), e);

  // 依 z（由大到小排序的表）做 Catmull-Rom 內插
  function interp(table, col, z) {
    const n = table.length;
    if (z >= table[0][0]) return table[0][col];
    if (z <= table[n - 1][0]) return table[n - 1][col];
    let i = 0;
    while (i < n - 2 && z < table[i + 1][0]) i++;
    const t = (table[i][0] - z) / (table[i][0] - table[i + 1][0]);
    const p0 = table[Math.max(0, i - 1)][col], p1 = table[i][col], p2 = table[i + 1][col], p3 = table[Math.min(n - 1, i + 2)][col];
    const t2 = t * t, t3 = t2 * t;
    return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
  }

  // 參數曲面 fn(s,t) → Vector3 取樣成網格；offset 沿法線外推（貼在另一層曲面上的飾板用）
  // outward(p) 給大約的朝外方向，用來統一法線與三角形方向
  function buildPatch(fn, s0, s1, t0, t1, ns, nt, outward, offset = 0) {
    const pts = [];
    const e = 1e-3;
    const tmpN = new THREE.Vector3(), dS = new THREE.Vector3(), dT = new THREE.Vector3();
    for (let i = 0; i <= ns; i++) {
      const s = s0 + (s1 - s0) * i / ns;
      for (let j = 0; j <= nt; j++) {
        const t = t0 + (t1 - t0) * j / nt;
        const p = fn(s, t);
        if (offset) {
          dS.subVectors(fn(s + e, t), fn(s - e, t));
          dT.subVectors(fn(s, t + e), fn(s, t - e));
          tmpN.crossVectors(dS, dT).normalize();
          if (tmpN.dot(outward(p)) < 0) tmpN.negate();
          p.addScaledVector(tmpN, offset);
        }
        pts.push(p);
      }
    }
    const pos = new Float32Array(pts.length * 3);
    pts.forEach((p, k) => { pos[k * 3] = p.x; pos[k * 3 + 1] = p.y; pos[k * 3 + 2] = p.z; });
    const idx = [];
    const W = nt + 1;
    for (let i = 0; i < ns; i++) {
      for (let j = 0; j < nt; j++) {
        const a = i * W + j, b = a + W, c = b + 1, d = a + 1;
        idx.push(a, b, d, b, c, d);
      }
    }
    // 依多數三角形的法線方向決定是否整體翻面，確保朝外
    let vote = 0;
    const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3(), N = new THREE.Vector3();
    for (let k = 0; k < idx.length; k += 3 * 7) {
      A.copy(pts[idx[k]]); B.copy(pts[idx[k + 1]]); C.copy(pts[idx[k + 2]]);
      N.crossVectors(B.clone().sub(A), C.clone().sub(A));
      if (N.lengthSq() < 1e-12) continue;
      vote += N.dot(outward(A)) > 0 ? 1 : -1;
    }
    if (vote < 0) for (let k = 0; k < idx.length; k += 3) { const tmp = idx[k + 1]; idx[k + 1] = idx[k + 2]; idx[k + 2] = tmp; }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  // 天空／地面漸層的環境反射貼圖（讓烤漆、玻璃、鍍鉻有反光）
  function makeEnvMap(renderer) {
    const c = document.createElement('canvas'); c.width = 512; c.height = 256;
    const g = c.getContext('2d');
    const grd = g.createLinearGradient(0, 0, 0, 256);
    grd.addColorStop(0.00, '#5d93c4');
    grd.addColorStop(0.42, '#cfe0ea');
    grd.addColorStop(0.50, '#eef3f4');
    grd.addColorStop(0.53, '#7d8b68');
    grd.addColorStop(1.00, '#2e3a25');
    g.fillStyle = grd; g.fillRect(0, 0, 512, 256);
    // 幾朵亮雲，讓車頂與引擎蓋有流動的反光
    g.fillStyle = 'rgba(255,255,255,0.55)';
    for (let i = 0; i < 14; i++) { g.beginPath(); g.ellipse((i * 97) % 512, 40 + (i * 37) % 60, 40 + (i * 13) % 30, 10 + (i * 7) % 8, 0, 0, Math.PI * 2); g.fill(); }
    const tex = new THREE.CanvasTexture(c);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.encoding = THREE.sRGBEncoding;
    const pm = new THREE.PMREMGenerator(renderer);
    const env = pm.fromEquirectangular(tex).texture;
    pm.dispose(); tex.dispose();
    return env;
  }

  function makePlateTexture(text) {
    const c = document.createElement('canvas'); c.width = 256; c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = '#f4f4f0'; g.fillRect(0, 0, 256, 128);
    g.strokeStyle = '#222'; g.lineWidth = 6; g.strokeRect(5, 5, 246, 118);
    g.fillStyle = '#111'; g.font = 'bold 54px Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, 128, 70);
    const t = new THREE.CanvasTexture(c); t.anisotropy = 4; return t;
  }

  function createCar(scene, renderer) {
    const group = new THREE.Group();
    scene.add(group);
    const env = renderer ? makeEnvMap(renderer) : null;

    // ---- 材質 ----
    const paintMat = new THREE.MeshPhysicalMaterial({
      color: 0xf3f3ef, metalness: 0.08, roughness: 0.32, clearcoat: 1.0, clearcoatRoughness: 0.08,
      envMap: env, envMapIntensity: 0.9
    });
    const trimMat = new THREE.MeshStandardMaterial({ color: 0x17191c, metalness: 0.2, roughness: 0.55, envMap: env, envMapIntensity: 0.4 });
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x0c1218, metalness: 0.1, roughness: 0.04, envMap: env, envMapIntensity: 1.6 });
    const chromeMat = new THREE.MeshStandardMaterial({ color: 0xd8dce0, metalness: 1.0, roughness: 0.18, envMap: env, envMapIntensity: 1.2 });
    const darkChromeMat = new THREE.MeshStandardMaterial({ color: 0x3a3e44, metalness: 0.9, roughness: 0.25, envMap: env });
    const seamMat = new THREE.MeshBasicMaterial({ color: 0x1a1a1a });
    const underMat = new THREE.MeshStandardMaterial({ color: 0x0f1012, roughness: 0.95 });

    const addMesh = (geo, mat, parent = group, shadow = true) => {
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = shadow; m.receiveShadow = true;
      parent.add(m);
      return m;
    };

    // =====================================================================
    // 1. 車身下半部（引擎蓋、車門、後廂）：沿車長放樣
    // =====================================================================
    // [z, 半寬, 底緣 y, 頂緣 y]（車頭 → 車尾）
    const BODY = [
      [ 2.215, 0.66, 0.40, 0.58 ],
      [ 2.19,  0.76, 0.33, 0.64 ],
      [ 2.12,  0.83, 0.29, 0.71 ],
      [ 1.95,  0.87, 0.27, 0.78 ],
      [ 1.60,  0.885, 0.26, 0.84 ],
      [ 1.27,  0.90, 0.26, 0.875 ],
      [ 0.95,  0.895, 0.26, 0.915 ],
      [ 0.40,  0.885, 0.25, 0.945 ],
      [-0.40,  0.885, 0.25, 0.955 ],
      [-1.00,  0.89, 0.25, 0.96 ],
      [-1.27,  0.90, 0.26, 0.965 ],
      [-1.50,  0.895, 0.26, 0.97 ],
      [-1.85,  0.88, 0.27, 0.965 ],
      [-2.08,  0.85, 0.29, 0.93 ],
      [-2.17,  0.80, 0.32, 0.86 ],
      [-2.20,  0.72, 0.38, 0.78 ]
    ];
    const Z_FRONT = 2.215, Z_REAR = -2.20;
    const WHEEL_Z = [1.27, -1.27], WHEEL_X = 0.80, WHEEL_R = 0.32, ARCH_R = 0.41;
    const SUPER_E = 0.36;   // 超橢圓指數（越小越方正）

    const archY = z => {
      let y = -Infinity;
      for (const zc of WHEEL_Z) {
        const dz = z - zc;
        if (Math.abs(dz) < ARCH_R) y = Math.max(y, WHEEL_R + Math.sqrt(ARCH_R * ARCH_R - dz * dz));
      }
      return y;
    };
    const bodySection = z => {
      const w = interp(BODY, 1, z);
      const yb = Math.max(interp(BODY, 2, z), archY(z));
      const yt = interp(BODY, 3, z);
      return { w, yb, yt, yc: (yb + yt) / 2, h: (yt - yb) / 2 };
    };
    // s：0 車頭 → 1 車尾；t：0 由車底中心起算繞一圈（0.25 右側、0.5 頂部、0.75 左側）
    const zOfS = s => Z_FRONT + (Z_REAR - Z_FRONT) * s;
    const bodyFn = (s, t) => {
      const z = zOfS(s);
      const { w, yc, h } = bodySection(z);
      const th = -Math.PI / 2 + Math.PI * 2 * t;
      const c = Math.cos(th), sn = Math.sin(th);
      const x = w * sgnPow(c, SUPER_E) * (1 - 0.05 * Math.max(0, sn));
      const y = yc + h * sgnPow(sn, SUPER_E);
      return new THREE.Vector3(x, y, z);
    };
    const bodyOut = p => { const { yc } = bodySection(p.z); return new THREE.Vector3(p.x, p.y - yc, 0); };

    addMesh(buildPatch(bodyFn, 0, 1, 0, 1, 230, 72, bodyOut), paintMat);

    // 前後端封口
    [[0, 1], [1, -1]].forEach(([s, dir]) => {
      const z = zOfS(s), { yc } = bodySection(z);
      const ring = [];
      for (let j = 0; j <= 72; j++) ring.push(bodyFn(s, j / 72));
      const pos = [0, yc, z + dir * 0.004];
      ring.forEach(p => pos.push(p.x, p.y, p.z));
      const idx = [];
      for (let j = 0; j < 72; j++) idx.push(0, j + 1, j + 2);
      // 法線朝前（車頭）或朝後（車尾）
      const a = ring[0], b = ring[18];
      const n = new THREE.Vector3().crossVectors(new THREE.Vector3(a.x, a.y - yc, 0), new THREE.Vector3(b.x, b.y - yc, 0));
      if (n.z * dir < 0) for (let k = 0; k < idx.length; k += 3) { const tmp = idx[k + 1]; idx[k + 1] = idx[k + 2]; idx[k + 2] = tmp; }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setIndex(idx); g.computeVertexNormals();
      addMesh(g, paintMat);
    });

    // 下緣黑色飾板（上白下黑）：車身斷面下方約 1/5
    const T_CLAD = 0.192;
    addMesh(buildPatch(bodyFn, 0.005, 0.995, 0, T_CLAD, 200, 10, bodyOut, 0.004), trimMat);
    addMesh(buildPatch(bodyFn, 0.005, 0.995, 1 - T_CLAD, 1, 200, 10, bodyOut, 0.004), trimMat);

    // 車門縫（細黑線）：前門前緣、前後門之間、後門後緣
    const sOfZ = z => (Z_FRONT - z) / (Z_FRONT - Z_REAR);
    [0.86, -0.30, -1.13].forEach(z => {
      const s = sOfZ(z), ds = 0.0018;
      addMesh(buildPatch(bodyFn, s - ds, s + ds, 0.20, 0.372, 1, 14, bodyOut, 0.003), seamMat, group, false);
      addMesh(buildPatch(bodyFn, s - ds, s + ds, 0.628, 0.80, 1, 14, bodyOut, 0.003), seamMat, group, false);
    });
    // 引擎蓋縫（橫向）
    {
      const s = sOfZ(2.02), ds = 0.0007;
      addMesh(buildPatch(bodyFn, s - ds, s + ds, 0.36, 0.64, 1, 24, bodyOut, 0.003), seamMat, group, false);
    }

    // 車身側面某高度的 x（右側），擺門把等小零件用
    const bodySideX = (z, y) => {
      const s = sOfZ(z);
      let lo = 0.0, hi = 0.5; // t: 0 底部 → 0.5 頂部（右半圈），y 單調遞增
      for (let k = 0; k < 30; k++) { const mid = (lo + hi) / 2; if (bodyFn(s, mid).y < y) lo = mid; else hi = mid; }
      return bodyFn(s, (lo + hi) / 2).x;
    };

    // 底盤（填滿輪拱內側與車底，從輪拱看進去是黑色內襯）
    {
      const tub = addMesh(new THREE.BoxGeometry(1.32, 0.56, 3.9), underMat, group, false);
      tub.position.set(0, 0.52, 0);
    }

    // =====================================================================
    // 2. 座艙（車窗、車頂、A/B/C 柱）：同樣用參數曲面
    // =====================================================================
    const CAB_Z0 = 0.95, CAB_Z1 = -1.48, S_WIND = 0.30, S_ROOF = 0.76, ROOF_H = 0.44, CAB_E = 0.6;
    const cabH = s => {
      if (s <= S_WIND) { const a = s / S_WIND; return ROOF_H * a * (1.25 - 0.25 * a); }
      if (s <= S_ROOF) { const b = (s - S_WIND) / (S_ROOF - S_WIND); return ROOF_H + 0.014 * Math.sin(Math.PI * b); }
      const c = Math.min(1, (s - S_ROOF) / (1 - S_ROOF));
      return ROOF_H * (1 - (0.6 * c + 0.4 * c * c));
    };
    const cabFn = (s, t) => {
      const z = CAB_Z0 + (CAB_Z1 - CAB_Z0) * s;
      const yb = interp(BODY, 3, z) - 0.006;
      const H = Math.max(0, cabH(s));
      const th = Math.PI * Math.min(1, Math.max(0, t));
      const y = yb + H * Math.pow(Math.max(0, Math.sin(th)), CAB_E);
      const wB = 0.79;
      const x = sgnPow(Math.cos(th), CAB_E) * (wB - 0.17 * (y - yb));
      return new THREE.Vector3(x, y, z);
    };
    const cabOut = p => {
      const yb = interp(BODY, 3, p.z);
      return new THREE.Vector3(p.x, p.y - yb + 0.15, 0);
    };

    addMesh(buildPatch(cabFn, 0, 1, 0, 1, 90, 60, cabOut), glassMat);                       // 整片玻璃
    addMesh(buildPatch(cabFn, S_WIND - 0.004, S_ROOF + 0.02, 0.305, 0.695, 50, 30, cabOut, 0.008), paintMat); // 車頂
    [[0.268, 0.336], [0.664, 0.732]].forEach(([t0, t1]) => {                                 // A 柱
      addMesh(buildPatch(cabFn, 0.0, S_WIND + 0.01, t0, t1, 24, 4, cabOut, 0.006), paintMat);
    });
    [[0, 0.336], [0.664, 1]].forEach(([t0, t1]) => {                                         // C 柱（後側窗後方）
      addMesh(buildPatch(cabFn, 0.715, 1.0, t0, t1, 24, 14, cabOut, 0.006), paintMat);
    });
    [[0, 0.315], [0.685, 1]].forEach(([t0, t1]) => {                                         // B 柱（黑色）
      addMesh(buildPatch(cabFn, 0.432, 0.456, t0, t1, 2, 12, cabOut, 0.007), trimMat);
    });
    [[0.012, 0.03], [0.97, 0.988]].forEach(([t0, t1]) => {                                   // 側窗下緣鍍鉻飾條
      addMesh(buildPatch(cabFn, 0.06, 0.715, t0, t1, 40, 1, cabOut, 0.007), chromeMat, group, false);
    });

    // =====================================================================
    // 3. 燈具、水箱罩、保桿細節、後照鏡、門把、雨刷、車牌、排氣管
    // =====================================================================
    const box = (w, h, d, mat, x, y, z, parent = group) => {
      const m = addMesh(new THREE.BoxGeometry(w, h, d), mat, parent, false);
      m.position.set(x, y, z);
      return m;
    };

    // 頭燈：深色燈殼＋兩顆投射燈＋上緣日行燈條（高亮度，配合後處理泛光）
    const headMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.6, 2.5, 2.1) });
    const drlMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 2.3, 2.6) });
    const projGeo = new THREE.CylinderGeometry(0.036, 0.036, 0.02, 20); projGeo.rotateX(Math.PI / 2);
    [-1, 1].forEach(side => {
      const hl = new THREE.Group();
      hl.position.set(side * 0.585, 0.625, 2.115);
      hl.rotation.y = side * 0.2;
      group.add(hl);
      box(0.40, 0.12, 0.12, darkChromeMat, 0, 0, 0, hl);
      [-0.09, 0.05].forEach(px => { const p = addMesh(projGeo, headMat, hl, false); p.position.set(side * px, -0.005, 0.062); });
      box(0.34, 0.016, 0.01, drlMat, 0, 0.047, 0.062, hl);
    });

    // 水箱罩：黑色框＋三條鍍鉻橫條
    box(0.66, 0.09, 0.04, trimMat, 0, 0.535, 2.205);
    [0.51, 0.535, 0.56].forEach(y => box(0.60, 0.008, 0.012, chromeMat, 0, y, 2.226));
    // 前保桿下進氣口與霧燈
    box(1.10, 0.10, 0.06, trimMat, 0, 0.365, 2.17);
    [-1, 1].forEach(side => {
      const fog = addMesh(new THREE.CylinderGeometry(0.04, 0.04, 0.02, 16), new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 1.5, 1.1) }), group, false);
      fog.rotation.x = Math.PI / 2; fog.position.set(side * 0.62, 0.38, 2.14);
    });

    // 尾燈：紅色燈罩＋煞車燈條（brakeLightMat 由駕駛模組控制亮度）＋白色倒車燈
    const tailLensMat = new THREE.MeshStandardMaterial({ color: 0x5c0b0b, emissive: 0x2a0000, metalness: 0.1, roughness: 0.2, envMap: env, envMapIntensity: 1.0 });
    const brakeLightMat = new THREE.MeshBasicMaterial({ color: 0x7f1d1d });
    const reverseMat = new THREE.MeshStandardMaterial({ color: 0xdedede, metalness: 0.1, roughness: 0.15, envMap: env });
    [-1, 1].forEach(side => {
      const tl = new THREE.Group();
      tl.position.set(side * 0.56, 0.80, -2.135);
      tl.rotation.y = -side * 0.18;
      group.add(tl);
      box(0.40, 0.125, 0.08, tailLensMat, 0, 0, 0, tl);
      box(0.32, 0.045, 0.012, brakeLightMat, side * 0.02, 0.018, -0.044, tl);
      box(0.08, 0.04, 0.012, reverseMat, -side * 0.13, -0.035, -0.044, tl);
    });
    box(0.66, 0.09, 0.03, trimMat, 0, 0.80, -2.183);            // 尾燈間黑色飾板
    box(1.30, 0.012, 0.012, chromeMat, 0, 0.74, -2.19);         // 後廂鍍鉻飾條

    // 第三煞車燈（後擋上緣，貼在玻璃外）
    {
      const s3 = S_ROOF + 0.02;
      const p = cabFn(s3, 0.5);
      box(0.34, 0.025, 0.03, brakeLightMat, 0, p.y - 0.004, p.z - 0.02);
    }

    // 車牌
    const plateGeo = new THREE.PlaneGeometry(0.42, 0.21);
    const plateMat = new THREE.MeshStandardMaterial({ map: makePlateTexture('ABC-1234'), roughness: 0.5 });
    const frontPlate = addMesh(plateGeo, plateMat, group, false); frontPlate.position.set(0, 0.395, 2.232);
    const rearPlate = addMesh(plateGeo, plateMat, group, false); rearPlate.position.set(0, 0.55, -2.207); rearPlate.rotation.y = Math.PI;

    // 後照鏡：黑色支架＋車身色鏡殼＋鏡面
    [-1, 1].forEach(side => {
      box(0.14, 0.08, 0.06, trimMat, side * 0.87, 0.955, 0.80);
      const housing = addMesh(new THREE.SphereGeometry(1, 20, 14), paintMat);
      housing.scale.set(0.085, 0.058, 0.055);
      housing.position.set(side * 0.94, 0.99, 0.78);
      const mirror = addMesh(new THREE.PlaneGeometry(0.13, 0.07), glassMat, group, false);
      mirror.rotation.y = Math.PI;
      mirror.position.set(side * 0.94, 0.99, 0.726);
    });

    // 門把
    [0.18, -0.92].forEach(z => {
      const x = bodySideX(z, 0.83);
      [-1, 1].forEach(side => box(0.02, 0.025, 0.16, chromeMat, side * (x + 0.008), 0.83, z));
    });

    // 雨刷
    [-0.28, 0.24].forEach(x => {
      const w = box(0.56, 0.012, 0.022, trimMat, x, interp(BODY, 3, 0.92) + 0.03, 0.92);
      w.rotation.z = 0.04;
    });

    // 排氣管（右後下方）
    {
      const pipe = addMesh(new THREE.CylinderGeometry(0.038, 0.038, 0.16, 18, 1, true), chromeMat, group, false);
      pipe.rotation.x = Math.PI / 2; pipe.position.set(-0.52, 0.28, -2.15);
      const hole = addMesh(new THREE.CircleGeometry(0.032, 18), underMat, group, false);
      hole.rotation.y = Math.PI; hole.position.set(-0.52, 0.28, -2.20);
    }

    // 車頂天線
    {
      const ant = addMesh(new THREE.CylinderGeometry(0.004, 0.006, 0.32, 6), trimMat, group, false);
      ant.position.set(0, 1.47, -0.95); ant.rotation.x = -0.55;
    }

    // 車底接地陰影
    {
      const sc = document.createElement('canvas'); sc.width = sc.height = 64; const sg = sc.getContext('2d');
      const rg = sg.createRadialGradient(32, 32, 4, 32, 32, 32); rg.addColorStop(0, 'rgba(0,0,0,0.6)'); rg.addColorStop(1, 'rgba(0,0,0,0)');
      sg.fillStyle = rg; sg.fillRect(0, 0, 64, 64);
      const shadow = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 4.9), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(sc), transparent: true, depthWrite: false }));
      shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.06; group.add(shadow);
    }

    // =====================================================================
    // 4. 輪胎與鋁圈：圓弧胎壁、五輻鋁圈、碟盤、卡鉗
    // =====================================================================
    const tireMat = new THREE.MeshStandardMaterial({ color: 0x080808, roughness: 0.95, side: THREE.DoubleSide });
    const rimMat = new THREE.MeshStandardMaterial({ color: 0xc4c8cd, metalness: 0.85, roughness: 0.28, envMap: env, envMapIntensity: 1.1 });
    const barrelMat = new THREE.MeshStandardMaterial({ color: 0x80858b, metalness: 0.8, roughness: 0.4, side: THREE.DoubleSide, envMap: env });
    const discMat = new THREE.MeshStandardMaterial({ color: 0x6b6b6b, metalness: 0.7, roughness: 0.45 });
    const caliperMat = new THREE.MeshStandardMaterial({ color: 0x9b1c1c, metalness: 0.3, roughness: 0.4 });

    // 胎體斷面（半徑, 軸向位置）
    const TIRE_PROFILE = [
      [0.205, -0.098], [0.255, -0.106], [0.292, -0.106], [0.312, -0.094], [0.320, -0.065],
      [0.322, 0.0], [0.320, 0.065], [0.312, 0.094], [0.292, 0.106], [0.255, 0.106], [0.205, 0.098]
    ];
    const tireGeo = new THREE.LatheGeometry(TIRE_PROFILE.map(([r, a]) => new THREE.Vector2(r, a)), 40);
    tireGeo.rotateZ(-Math.PI / 2);   // 旋轉軸 Y → X

    // 五輻鋁圈：圓盤挖五個窗
    const rimShape = new THREE.Shape();
    rimShape.absarc(0, 0, 0.198, 0, Math.PI * 2, false);
    for (let k = 0; k < 5; k++) {
      const base = k * Math.PI * 2 / 5;
      const span = Math.PI * 2 / 5;
      const hole = new THREE.Path();
      const N = 8, ri = 0.07, ro = 0.178;
      const inA0 = base + 0.34, inA1 = base + span - 0.34;   // 輻條往中心變寬
      const outA0 = base + 0.17, outA1 = base + span - 0.17;
      for (let i = 0; i <= N; i++) { const a = outA0 + (outA1 - outA0) * i / N; const p = [Math.cos(a) * ro, Math.sin(a) * ro]; i === 0 ? hole.moveTo(p[0], p[1]) : hole.lineTo(p[0], p[1]); }
      for (let i = N; i >= 0; i--) { const a = inA0 + (inA1 - inA0) * i / N; hole.lineTo(Math.cos(a) * ri, Math.sin(a) * ri); }
      hole.closePath();
      rimShape.holes.push(hole);
    }
    const rimGeo = new THREE.ExtrudeGeometry(rimShape, { depth: 0.022, bevelEnabled: true, bevelThickness: 0.008, bevelSize: 0.006, bevelSegments: 2, curveSegments: 40 });
    rimGeo.rotateY(Math.PI / 2);     // 正面朝 +X（外側）
    rimGeo.translate(0.03, 0, 0);
    const barrelGeo = new THREE.CylinderGeometry(0.2, 0.2, 0.17, 32, 1, true); barrelGeo.rotateZ(Math.PI / 2);
    const capGeo = new THREE.CylinderGeometry(0.034, 0.034, 0.02, 18); capGeo.rotateZ(Math.PI / 2);
    const nutGeo = new THREE.CylinderGeometry(0.01, 0.01, 0.02, 6); nutGeo.rotateZ(Math.PI / 2);
    const discGeo = new THREE.CylinderGeometry(0.165, 0.165, 0.022, 32); discGeo.rotateZ(Math.PI / 2);
    const caliperGeo = new THREE.BoxGeometry(0.05, 0.12, 0.085);

    const wheelMeshes = [];
    [
      { x: -WHEEL_X, z: WHEEL_Z[0], front: true }, { x: WHEEL_X, z: WHEEL_Z[0], front: true },
      { x: -WHEEL_X, z: WHEEL_Z[1], front: false }, { x: WHEEL_X, z: WHEEL_Z[1], front: false }
    ].forEach(wc => {
      const side = Math.sign(wc.x);   // +1 右側（外側朝 +X）、-1 左側
      const pivot = new THREE.Group(); pivot.position.set(wc.x, WHEEL_R, wc.z);
      const wheel = new THREE.Group();          // 滾動（rotation.x）
      const content = new THREE.Group();        // 左右鏡射，讓鋁圈正面朝外
      content.scale.x = side;
      wheel.add(content);
      addMesh(tireGeo, tireMat, content);
      addMesh(rimGeo, rimMat, content);
      const barrel = addMesh(barrelGeo, barrelMat, content, false); barrel.position.x = -0.035;
      const cap = addMesh(capGeo, chromeMat, content, false); cap.position.x = 0.07;
      for (let k = 0; k < 5; k++) {
        const a = k * Math.PI * 2 / 5 + Math.PI / 5;
        const nut = addMesh(nutGeo, chromeMat, content, false);
        nut.position.set(0.064, Math.cos(a) * 0.052, Math.sin(a) * 0.052);
      }
      const disc = addMesh(discGeo, discMat, content, false); disc.position.x = -0.03;
      pivot.add(wheel);
      // 卡鉗跟著轉向但不跟著滾動
      const caliper = addMesh(caliperGeo, caliperMat, pivot, false);
      caliper.position.set(side * -0.03, 0.11, wc.front ? -0.1 : 0.1);
      group.add(pivot);
      wheelMeshes.push({ pivot, mesh: wheel, front: wc.front });
    });

    // =====================================================================
    // 5. 甩尾白煙粒子池
    // =====================================================================
    const SMOKE_COUNT = 90;
    const smokeParticles = [];
    const smokeGeo = new THREE.SphereGeometry(0.32, 6, 6);
    for (let i = 0; i < SMOKE_COUNT; i++) {
      const m = new THREE.Mesh(smokeGeo, new THREE.MeshBasicMaterial({ color: 0xf1f5f9, transparent: true, opacity: 0 }));
      m.visible = false;
      scene.add(m);
      smokeParticles.push({ mesh: m, life: 0, maxLife: 0.55, vel: new THREE.Vector3() });
    }
    let smokeCursor = 0;

    function spawnDriftSmoke(pos) {
      const p = smokeParticles[smokeCursor];
      smokeCursor = (smokeCursor + 1) % SMOKE_COUNT;
      p.mesh.visible = true;
      p.mesh.position.copy(pos);
      p.mesh.position.y += 0.18;
      p.mesh.scale.setScalar(0.5);
      p.life = p.maxLife;
      p.vel.set((Math.random() - 0.5) * 1.4, 0.9 + Math.random() * 0.7, (Math.random() - 0.5) * 1.4);
    }

    function updateEffects(dt) {
      for (let i = 0; i < SMOKE_COUNT; i++) {
        const p = smokeParticles[i];
        if (!p.mesh.visible) continue;
        p.life -= dt;
        if (p.life <= 0) {
          p.mesh.visible = false;
        } else {
          p.mesh.position.addScaledVector(p.vel, dt);
          const ratio = 1 - p.life / p.maxLife;
          p.mesh.scale.setScalar(0.5 + ratio * 1.9);
          p.mesh.material.opacity = (1 - ratio) * 0.42;
        }
      }
    }

    return { group, wheelMeshes, brakeLightMat, spawnDriftSmoke, updateEffects };
  }

  window.createCar = createCar;
})();
