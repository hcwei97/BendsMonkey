// =========================================================================
// 駕駛模組：車輛狀態、操控輸入、車輛物理、道路貼合與護欄／起終點碰撞、車身姿態
//
// 用法（index.html 主程式）：
//   const driving = createDriving({ roadSamples, NUM_SAMPLES, ROAD_HALF_WIDTH, START_SAMPLE_INDEX,
//                                   carGroup, wheelMeshes, brakeLightMat, spawnDriftSmoke, onImpact });
//   driving.bindKeyboard();               // WASD／方向鍵／空白鍵
//   driving.bindTouchHold('touch-gas', 'forward');
//   const frame = driving.update(dt);     // 每幀呼叫一次，回傳 HUD 需要的資訊
//
// 不負責：HUD、計時與完賽、地標提示、攝影機（由主程式依 carState 與 update() 回傳值處理）
// =========================================================================
(function () {
  function createDriving(opts) {
    const {
      roadSamples, NUM_SAMPLES, ROAD_HALF_WIDTH, START_SAMPLE_INDEX,
      carGroup, wheelMeshes, brakeLightMat,
      spawnDriftSmoke = () => {},
      onImpact = () => {}          // 撞護欄／起終點護欄時呼叫，參數為建議的鏡頭震動量
    } = opts;

    const carState = {
      pos: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      heading: 0,
      steerAngle: 0,
      speed: 0,
      nearestSampleIdx: START_SAMPLE_INDEX,
      lateralOffset: 0,
      wheelSpin: 0,
      roll: 0,
      pitch: 0,
      driftScore: 0,
      maxSpeedKmh: 0,
      elapsedTime: 0,
      raceStarted: false,
      raceFinished: false
    };

    const keys = { forward: false, backward: false, left: false, right: false, handbrake: false };

    // 把車放到某個道路取樣點上、車頭朝路線前進方向、速度歸零
    function placeAtSample(sampleIdx) {
      const idx = THREE.MathUtils.clamp(Math.round(sampleIdx), 0, NUM_SAMPLES - 1);
      const s = roadSamples[idx];
      carState.pos.copy(s.pos);
      carState.vel.set(0, 0, 0);
      carState.speed = 0;
      carState.steerAngle = 0;
      carState.heading = Math.atan2(s.flatTangent.x, s.flatTangent.z);
      carState.nearestSampleIdx = idx;
      carState.lateralOffset = 0;
      carState.roll = 0;
      return idx;
    }

    // 在目前路段原地回正（不重設統計）
    function recoverOnRoad() {
      const s = roadSamples[carState.nearestSampleIdx];
      carState.pos.copy(s.pos);
      carState.vel.set(0, 0, 0);
      carState.speed = 0;
      carState.steerAngle = 0;
      carState.heading = Math.atan2(s.flatTangent.x, s.flatTangent.z);
      carState.lateralOffset = 0;
    }

    // ---- 操控輸入 ----
    function bindKeyboard(target = window) {
      target.addEventListener('keydown', e => {
        const k = e.key.toLowerCase();
        if (k === 'w' || e.key === 'ArrowUp') keys.forward = true;
        if (k === 's' || e.key === 'ArrowDown') keys.backward = true;
        if (k === 'a' || e.key === 'ArrowLeft') keys.left = true;
        if (k === 'd' || e.key === 'ArrowRight') keys.right = true;
        if (e.code === 'Space') { e.preventDefault(); keys.handbrake = true; }
      });
      target.addEventListener('keyup', e => {
        const k = e.key.toLowerCase();
        if (k === 'w' || e.key === 'ArrowUp') keys.forward = false;
        if (k === 's' || e.key === 'ArrowDown') keys.backward = false;
        if (k === 'a' || e.key === 'ArrowLeft') keys.left = false;
        if (k === 'd' || e.key === 'ArrowRight') keys.right = false;
        if (e.code === 'Space') keys.handbrake = false;
      });
    }

    // 手機觸控：按住按鈕＝按住對應按鍵
    function bindTouchHold(btnId, keyName) {
      const el = document.getElementById(btnId);
      if (!el) return;
      const onDown = e => { e.preventDefault(); keys[keyName] = true; el.classList.add('active'); };
      const onUp = e => { e.preventDefault(); keys[keyName] = false; el.classList.remove('active'); };
      el.addEventListener('pointerdown', onDown);
      el.addEventListener('pointerup', onUp);
      el.addEventListener('pointerleave', onUp);
      el.addEventListener('pointercancel', onUp);
    }

    // 尋找最近道路投影點（局部窗口搜尋＋全域備援）
    function projectCarOntoRoad() {
      let bestIdx = carState.nearestSampleIdx;
      let bestDistSq = Infinity;
      const winStart = Math.max(0, carState.nearestSampleIdx - 28);
      const winEnd = Math.min(NUM_SAMPLES, carState.nearestSampleIdx + 28);

      for (let i = winStart; i <= winEnd; i++) {
        const p = roadSamples[i].pos;
        const d2 = (carState.pos.x - p.x) ** 2 + (carState.pos.z - p.z) ** 2 + ((carState.pos.y - p.y) * 1.4) ** 2;
        if (d2 < bestDistSq) {
          bestDistSq = d2;
          bestIdx = i;
        }
      }

      if (bestDistSq > 450) {
        for (let i = 0; i <= NUM_SAMPLES; i += 2) {
          const p = roadSamples[i].pos;
          const d2 = (carState.pos.x - p.x) ** 2 + (carState.pos.z - p.z) ** 2 + ((carState.pos.y - p.y) * 1.4) ** 2;
          if (d2 < bestDistSq) {
            bestDistSq = d2;
            bestIdx = i;
          }
        }
      }

      carState.nearestSampleIdx = bestIdx;
      const s0 = roadSamples[bestIdx];
      const s1 = roadSamples[Math.min(NUM_SAMPLES, bestIdx + 1)];
      const seg = new THREE.Vector3().subVectors(s1.pos, s0.pos);
      const segLenSq = seg.x * seg.x + seg.z * seg.z || 1;
      const t = THREE.MathUtils.clamp(
        ((carState.pos.x - s0.pos.x) * seg.x + (carState.pos.z - s0.pos.z) * seg.z) / segLenSq,
        0, 1
      );

      const projPos = new THREE.Vector3().lerpVectors(s0.pos, s1.pos, t);
      const smoothTangent = new THREE.Vector3().lerpVectors(s0.flatTangent, s1.flatTangent, t).normalize();
      const smoothRight = new THREE.Vector3(-smoothTangent.z, 0, smoothTangent.x).normalize();

      const dx = carState.pos.x - projPos.x;
      const dz = carState.pos.z - projPos.z;
      carState.lateralOffset = dx * smoothRight.x + dz * smoothRight.z;

      return { projPos, smoothTangent, smoothRight, sample: s0 };
    }

    // ---- 每幀車輛物理 ----
    // 回傳 { sample, forwardSpeed, lateralSpeed, isDrifting, slipSpeed }
    function update(dt) {
      const forwardDir = new THREE.Vector3(Math.sin(carState.heading), 0, Math.cos(carState.heading));
      const rightDir = new THREE.Vector3(Math.cos(carState.heading), 0, -Math.sin(carState.heading));

      const forwardSpeed = carState.vel.dot(forwardDir);
      const lateralSpeed = carState.vel.dot(rightDir);
      const absSpeed = Math.abs(forwardSpeed);

      // 方向盤轉向輸入
      const steerInput = (keys.left ? 1 : 0) - (keys.right ? 1 : 0);
      const speedSteerFactor = THREE.MathUtils.lerp(1.0, 0.52, THREE.MathUtils.clamp(absSpeed / 38.0, 0, 1));
      const targetSteer = steerInput * 0.62 * speedSteerFactor;
      carState.steerAngle = THREE.MathUtils.lerp(carState.steerAngle, targetSteer, Math.min(1, dt * 11.0));

      // 縱向動力、漸進腳煞車與坡度重力
      const curSample = roadSamples[carState.nearestSampleIdx];
      const slopeRad = Math.atan(curSample.slopePct / 100);
      const upDownAlign = forwardDir.dot(curSample.flatTangent);
      const gradeForce = -Math.sin(slopeRad) * 9.8 * upDownAlign;

      let accel = 0;
      if (keys.forward) {
        // 高扭力爬坡與五檔衝刺推力曲線（極速可達 145+ km/h）
        const powerFactor = THREE.MathUtils.clamp(1.28 - absSpeed / 56.0, 0.42, 1.28);
        accel += 24.5 * powerFactor;
      }
      if (keys.backward) {
        if (forwardSpeed > 0.8) {
          // 漸進線性腳煞車
          accel -= 21.0;
        } else {
          // 倒車檔
          accel -= 12.5;
        }
      }

      // 滾動阻力與空氣平方阻力
      const drag = -forwardSpeed * 0.065 - forwardSpeed * absSpeed * 0.0046;
      // 怠速駐車：沒踩油門／煞車且低速時，不隨坡度下滑，平順停住
      const idleHold = !keys.forward && !keys.backward && absSpeed < 3.0;
      let nextForwardSpeed;
      if (idleHold) {
        const holdDec = 4.0 * dt;
        nextForwardSpeed = Math.abs(forwardSpeed) <= holdDec ? 0 : forwardSpeed - Math.sign(forwardSpeed) * holdDec;
      } else {
        nextForwardSpeed = forwardSpeed + (accel + gradeForce + drag) * dt;
      }

      // 手煞車：低縱向衰減＋起甩打滑＋靜止坡道駐煞鎖定
      if (keys.handbrake) {
        if (absSpeed < 0.45 && !keys.forward && !keys.backward) {
          nextForwardSpeed = 0;
        } else {
          nextForwardSpeed *= Math.pow(0.996, dt * 60);
        }
      }

      // 側向抓地力與手煞車起甩打滑（Drift）
      // 先保存「換向前」的世界速度，車頭轉動後才會產生真實側滑
      const worldVel = forwardDir.clone().multiplyScalar(nextForwardSpeed).addScaledVector(rightDir, lateralSpeed);
      // 煞車飄移：高速踩煞車時後輪抓地下降、轉向更容易甩尾
      const brakeSlide = (keys.backward && forwardSpeed > 7.0) ? THREE.MathUtils.clamp((forwardSpeed - 7.0) / 14.0, 0, 1) : 0;

      // 車頭指向角速度
      if (absSpeed > 0.25 || (keys.handbrake && absSpeed > 0.15)) {
        const revSign = nextForwardSpeed >= -0.05 ? 1 : -1;
        const turnRate = (keys.handbrake ? 3.25 : 2.15) * (1 + 0.55 * brakeSlide);
        const lowSpeedBoost = THREE.MathUtils.clamp(absSpeed / 4.5, 0.25, 1.0);
        carState.heading += carState.steerAngle * turnRate * lowSpeedBoost * revSign * dt;
      }

      // 合成世界平面速度向量
      const newForwardDir = new THREE.Vector3(Math.sin(carState.heading), 0, Math.cos(carState.heading));
      const newRightDir = new THREE.Vector3(Math.cos(carState.heading), 0, -Math.sin(carState.heading));
      const slipFwd = worldVel.dot(newForwardDir);
      let nextLateralSpeed = worldVel.dot(newRightDir);
      const lateralGrip = keys.handbrake ? 2.2 : THREE.MathUtils.lerp(16.0, 3.6, brakeSlide);
      nextLateralSpeed *= Math.exp(-lateralGrip * dt);
      carState.vel.copy(newForwardDir).multiplyScalar(slipFwd).addScaledVector(newRightDir, nextLateralSpeed);
      carState.speed = carState.vel.length();

      // 更新車身位置
      carState.pos.x += carState.vel.x * dt;
      carState.pos.z += carState.vel.z * dt;

      // 貼齊路面並處理護欄順向滑行碰撞
      const { projPos, smoothTangent, smoothRight, sample } = projectCarOntoRoad();
      carState.pos.y = projPos.y;

      const maxLateral = ROAD_HALF_WIDTH - 0.92;
      if (Math.abs(carState.lateralOffset) > maxLateral) {
        const wallSide = Math.sign(carState.lateralOffset);
        const penetration = Math.abs(carState.lateralOffset) - maxLateral;
        carState.pos.addScaledVector(smoothRight, -wallSide * penetration);

        // 僅消除垂直撞入牆面的速度分量，保留沿護欄切線的絲滑滑行動能
        const vDotOut = carState.vel.dot(smoothRight) * wallSide;
        if (vDotOut > 0) {
          if (vDotOut > 3.2) {
            onImpact(Math.min(0.28, vDotOut * 0.025));
          }
          carState.vel.addScaledVector(smoothRight, -wallSide * vDotOut);
          carState.vel.multiplyScalar(0.992);
        }

        // 護欄角度修正：方向盤優先順應修正（幅度極低），方向盤回正時順著目前車頭行進方向微幅轉正
        const moveSign = smoothTangent.dot(newForwardDir) >= 0 ? 1 : -1;
        const wallTargetDir = smoothTangent.clone().multiplyScalar(moveSign);
        const wallHeading = Math.atan2(wallTargetDir.x, wallTargetDir.z);

        let angleDiff = wallHeading - carState.heading;
        while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
        while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;

        if (Math.abs(steerInput) > 0.05) {
          carState.heading += steerInput * 0.22 * dt;
        } else {
          carState.heading += angleDiff * 0.35 * dt;
        }
      }

      // 起點與終點紐澤西護欄實體阻擋（防止倒車或衝過終點掉出地圖）
      if (carState.nearestSampleIdx <= 2) {
        const startGate = roadSamples[2];
        const relStart = new THREE.Vector3().subVectors(carState.pos, startGate.pos);
        const pastStart = relStart.dot(startGate.flatTangent);
        if (pastStart < 0.85) {
          carState.pos.addScaledVector(startGate.flatTangent, 0.85 - pastStart);
          const vBack = carState.vel.dot(startGate.flatTangent);
          if (vBack < 0) {
            onImpact(Math.min(0.25, Math.abs(vBack) * 0.025));
            carState.vel.addScaledVector(startGate.flatTangent, -vBack);
          }
        }
      } else if (carState.nearestSampleIdx >= NUM_SAMPLES - 2) {
        const endGate = roadSamples[NUM_SAMPLES - 1];
        const relEnd = new THREE.Vector3().subVectors(carState.pos, endGate.pos);
        const pastEnd = relEnd.dot(endGate.flatTangent);
        if (pastEnd > -0.85) {
          carState.pos.addScaledVector(endGate.flatTangent, -0.85 - pastEnd);
          const vFwd = carState.vel.dot(endGate.flatTangent);
          if (vFwd > 0) {
            onImpact(Math.min(0.25, vFwd * 0.025));
            carState.vel.addScaledVector(endGate.flatTangent, -vFwd);
          }
        }
      }

      // 甩尾判定與後輪白煙特效
      const slipSpeed = Math.abs(nextLateralSpeed);
      const isDrifting = slipSpeed > 2.4 && carState.speed > 4.0;
      if (isDrifting && Math.random() < 0.75) {
        const rearL = carState.pos.clone().addScaledVector(newForwardDir, -1.35).addScaledVector(newRightDir, -0.85);
        const rearR = carState.pos.clone().addScaledVector(newForwardDir, -1.35).addScaledVector(newRightDir, 0.85);
        spawnDriftSmoke(rearL);
        spawnDriftSmoke(rearR);
      }

      // 更新 3D 車身姿態與四輪動畫
      carGroup.position.copy(carState.pos);
      carGroup.rotation.order = 'YXZ';
      carGroup.rotation.y = carState.heading;
      const targetPitch = -Math.atan(sample.slopePct / 100) * upDownAlign
        + ((keys.backward && forwardSpeed > 1) ? 0.028 : 0) - (keys.forward ? 0.012 : 0);
      const targetRoll = THREE.MathUtils.clamp(-nextLateralSpeed * 0.016 - carState.steerAngle * 0.04, -0.11, 0.11);
      carState.pitch = THREE.MathUtils.lerp(carState.pitch, targetPitch, Math.min(1, dt * 10));
      carState.roll = THREE.MathUtils.lerp(carState.roll, targetRoll, Math.min(1, dt * 10));
      carGroup.rotation.x = carState.pitch;
      carGroup.rotation.z = carState.roll;

      carState.wheelSpin += (nextForwardSpeed / 0.35) * dt;
      wheelMeshes.forEach(w => {
        w.pivot.rotation.y = w.front ? carState.steerAngle : 0;
        w.mesh.rotation.x = carState.wheelSpin;
      });

      if (brakeLightMat) {
        if (keys.backward || keys.handbrake) brakeLightMat.color.setRGB(4.0, 0.35, 0.3); else brakeLightMat.color.setHex(0x7f1d1d);
      }

      return { sample, forwardSpeed: nextForwardSpeed, lateralSpeed: nextLateralSpeed, isDrifting, slipSpeed };
    }

    return { carState, keys, placeAtSample, recoverOnRoad, bindKeyboard, bindTouchHold, update };
  }

  window.createDriving = createDriving;
})();
