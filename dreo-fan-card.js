class DreoFanCard extends HTMLElement {
  setConfig(config) {
    if (!config.entity) throw new Error('entity is required');
    this.config = {
      name: 'Air Circulator',
      horizontal_entity: 'number.air_circulator_fan_angle_horizontal',
      vertical_entity: 'number.air_circulator_fan_angle_vertical',
      direction_entity: 'select.air_circulator_oscillation_direction',
      range_up_entity: 'number.air_circulator_fan_osc_range_up',
      range_right_entity: 'number.air_circulator_fan_osc_range_right',
      range_down_entity: 'number.air_circulator_fan_osc_range_down',
      range_left_entity: 'number.air_circulator_fan_osc_range_left',
      command_settle_ms: 350,
      ...config,
    };
    if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
  }

  set hass(hass) {
    this._hass = hass;
    if (!this.shadowRoot || !this.config) return;
    // The first `hass` only establishes a baseline; a genuine off->on edge means
    // the head may have moved since the last readable angle.
    const on = this.state(this.config.entity)?.state === 'on';
    if (on && this._wasOn === false) this.refreshAnglesOnPowerOn();
    this._wasOn = on;
    this.rememberAll();
    if (this._optimistic && this.orientationConfirmed()) this.clearOptimistic();
    if (this._dragging || this._committing) return;
    const signature = this.signature();
    if (signature !== this._lastSignature) this.render();
  }

  getCardSize() { return 9; }

  state(id) { return this._hass?.states[id]; }
  value(id, fallback = 0) {
    const n = Number(this.state(id)?.state);
    return Number.isFinite(n) ? n : fallback;
  }

  // ---------------------------------------------------------------------
  // Remembered angles
  //
  // The integration marks the angle and off-axis range entities `unavailable`
  // whenever oscillation is running, because the fan itself refuses those
  // writes mid-sweep. Reading them raw returns NaN, which used to collapse the
  // 3D model to dead centre. Instead, keep the last value each entity actually
  // reported and draw from that while it is offline.
  // ---------------------------------------------------------------------

  storageKey() { return `dreo-fan-card:${this.config.entity}`; }

  loadKnown() {
    if (this._known) return;
    this._known = {};
    try {
      const raw = window.localStorage.getItem(this.storageKey());
      if (raw) this._known = JSON.parse(raw) || {};
    } catch (e) {
      this._known = {};
    }
  }

  saveKnown() {
    try {
      window.localStorage.setItem(this.storageKey(), JSON.stringify(this._known));
    } catch (e) { /* storage unavailable, in-memory cache still works */ }
  }

  remembered(key, entityId, fallback) {
    this.loadKnown();
    const n = Number(this.state(entityId)?.state);
    if (Number.isFinite(n)) {
      if (this._known[key] !== n) {
        this._known[key] = n;
        this.saveKnown();
      }
      return n;
    }
    const cached = Number(this._known[key]);
    return Number.isFinite(cached) ? cached : fallback;
  }

  rememberAll() {
    this.hAngle(); this.vAngle();
    this.sweepLeft(); this.sweepRight(); this.sweepDown(); this.sweepUp();
  }

  hAngle() { return this.remembered('h', this.config.horizontal_entity, 0); }
  vAngle() { return this.remembered('v', this.config.vertical_entity, 0); }
  sweepLeft() { return this.remembered('left', this.config.range_left_entity, -60); }
  sweepRight() { return this.remembered('right', this.config.range_right_entity, 60); }
  sweepDown() { return this.remembered('down', this.config.range_down_entity, -30); }
  sweepUp() { return this.remembered('up', this.config.range_up_entity, 90); }

  // ---------------------------------------------------------------------
  // Angle refresh
  //
  // The angle entities only carry a live value while the fan is on and not
  // sweeping; every other moment is drawn from the remembered copy above. So a
  // value that was already out of date when it was cached stays on screen
  // indefinitely — the model held a downward tilt through a whole horizontal
  // sweep while the real head sat level. Force the integration to re-poll at
  // the two points the cache is about to be leant on for a long time: when the
  // fan comes on, and just before oscillation takes the entities offline.
  // ---------------------------------------------------------------------

  anglesReadable() {
    return Number.isFinite(Number(this.state(this.config.horizontal_entity)?.state))
      && Number.isFinite(Number(this.state(this.config.vertical_entity)?.state));
  }

  async refreshAngles() {
    const entity_id = [this.config.horizontal_entity, this.config.vertical_entity];
    try {
      await this.call('homeassistant', 'update_entity', { entity_id });
    } catch (e) {
      return; // not every integration implements forced updates
    }
    // Nothing to read back here: whatever the poll produced arrives as a normal
    // state update, and `rememberAll` folds it into the cache.
    await this.sleep(Number(this.config.command_settle_ms));
  }

  // The head can be re-aimed by the app or a remote, and levels itself on spin
  // up, all while the card has no readable angle to watch. Re-poll on every
  // off->on edge, retrying for integrations that report the new position a beat
  // after the fan itself reports `on`.
  async refreshAnglesOnPowerOn() {
    const run = this._refreshRun = (this._refreshRun ?? 0) + 1;
    for (const wait of [0, 1200, 3000]) {
      if (wait) await this.sleep(wait);
      // A newer power cycle, a drag, or our own write all outrank this.
      if (run !== this._refreshRun || this._committing || this._dragging) return;
      if (this.state(this.config.entity)?.state !== 'on') return;
      await this.refreshAngles();
      if (this.anglesReadable()) return;
    }
  }

  call(domain, service, data) {
    return this._hass.callService(domain, service, data);
  }

  sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  signature() {
    const fan = this.state(this.config.entity);
    const ids = [
      this.config.horizontal_entity, this.config.vertical_entity,
      this.config.direction_entity, this.config.range_up_entity,
      this.config.range_right_entity, this.config.range_down_entity,
      this.config.range_left_entity,
    ];
    return JSON.stringify([
      fan?.state, fan?.attributes.percentage, fan?.attributes.preset_mode,
      ...ids.map(id => this.state(id)?.state),
      this._optimistic?.h, this._optimistic?.v,
    ]);
  }

  async waitForState(entityId, expected, timeout = 8000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (String(this.state(entityId)?.state) === String(expected)) return true;
      await this.sleep(100);
    }
    return false;
  }

  async waitForNumber(entityId, expected, timeout = 8000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (Math.abs(this.value(entityId, NaN) - expected) < 0.01) return true;
      await this.sleep(100);
    }
    return false;
  }

  orientationConfirmed() {
    if (!this._optimistic) return false;
    const match = axis => Math.abs(this.value(this.axisEntity(axis), NaN) - this._optimistic[axis]) < 0.01;
    if (this._optimistic.axis) return match(this._optimistic.axis);
    return match('h') && match('v');
  }

  clearOptimistic() {
    clearTimeout(this._optimisticTimer);
    this._optimistic = null;
    this._committing = false;
  }

  setNumber(entity_id, value) {
    const s = this.state(entity_id);
    const min = Number(s?.attributes.min ?? -Infinity);
    const max = Number(s?.attributes.max ?? Infinity);
    const step = Number(s?.attributes.step ?? 1);
    value = Math.max(min, Math.min(max, Math.round(value / step) * step));
    return this.call('number', 'set_value', { entity_id, value });
  }

  async nudge(axis, delta) {
    if (this._committing) return;
    if (!await this.ensureOn()) return;
    // Manual nudges are disabled mid-sweep; the pad edits sweep limits instead.
    if (!await this.ensureFixed()) return;
    const h = this.hAngle() + (axis === 'h' ? delta : 0);
    const v = this.vAngle() + (axis === 'v' ? delta : 0);
    await this.commitOrientation(h, v, true);
  }

  direction() {
    return this.state(this.config.direction_entity)?.state ?? 'fixed';
  }

  // The fan rejects manual aiming on either axis while it is sweeping, matching
  // the Dreo app. So oscillation locks the pad entirely rather than leaving the
  // off-axis free.
  lockedAxis(direction = this.direction()) {
    return direction === 'fixed' ? null : 'both';
  }

  axisEntity(axis) {
    return axis === 'h' ? this.config.horizontal_entity : this.config.vertical_entity;
  }

  isOscillating() {
    return this.direction() !== 'fixed';
  }

  async setDirection(option) {
    // Grab a live angle while the entities are still readable. Once the sweep
    // starts they go `unavailable`, and anything stale in the cache is what the
    // model shows for the rest of the run.
    if (option !== 'fixed' && !this.isOscillating() && !this._committing
      && this.state(this.config.entity)?.state === 'on') {
      await this.refreshAngles();
    }
    return this.call('select', 'select_option', {
      entity_id: this.config.direction_entity, option,
    });
  }

  // This fan has 9 discrete speeds (11%, 22%, 33% …) but reports
  // percentage_step as 1, which would imply 100 steps. Only trust that
  // attribute when it is a real step size.
  speedCount() {
    if (this.config.speed_count) return Number(this.config.speed_count);
    const attrs = this.state(this.config.entity)?.attributes ?? {};
    const declared = Number(attrs.speed_count);
    if (Number.isFinite(declared) && declared > 0) return Math.round(declared);
    const pStep = Number(attrs.percentage_step);
    if (Number.isFinite(pStep) && pStep > 1) return Math.round(100 / pStep);
    return 9;
  }

  // Controls never power the fan implicitly. The dedicated power button is the
  // only way to turn it on, which prevents an accidental slider touch from
  // reactivating an idle fan.
  async ensureOn() {
    return this.state(this.config.entity)?.state === 'on';
  }

  async ensureFixed() {
    if (!this.isOscillating()) return true;
    return false;
  }

  async commitOrientation(rawH, rawV, fixedAlready = false) {
    if (this._committing) return;
    if (!await this.ensureOn()) { this.render(); return; }
    if (!fixedAlready && !await this.ensureFixed()) {
      this.render();
      return;
    }
    const hState = this.state(this.config.horizontal_entity);
    const vState = this.state(this.config.vertical_entity);
    const hStep = Number(hState?.attributes.step ?? 5);
    const vStep = Number(vState?.attributes.step ?? 5);
    const h = Math.max(Number(hState?.attributes.min ?? -60), Math.min(Number(hState?.attributes.max ?? 60), Math.round(rawH / hStep) * hStep));
    const v = Math.max(Number(vState?.attributes.min ?? -30), Math.min(Number(vState?.attributes.max ?? 90), Math.round(rawV / vStep) * vStep));

    this._committing = true;
    this._optimistic = { h, v };
    this.render();
    try {
      // These entities write an H/V pair. Waiting for the first update prevents
      // the second command from resending the previous value for the other axis.
      if (Math.abs(this.value(this.config.horizontal_entity, NaN) - h) > 0.01) {
        await this.setNumber(this.config.horizontal_entity, h);
        await this.waitForNumber(this.config.horizontal_entity, h, 10000);
        await this.sleep(Number(this.config.command_settle_ms));
      }
      if (Math.abs(this.value(this.config.vertical_entity, NaN) - v) > 0.01) {
        await this.setNumber(this.config.vertical_entity, v);
        await this.waitForNumber(this.config.vertical_entity, v, 10000);
      }
    } finally {
      this._committing = false;
      if (this.orientationConfirmed()) {
        this.clearOptimistic();
        this.render();
      } else {
        clearTimeout(this._optimisticTimer);
        this._optimisticTimer = setTimeout(() => {
          this.clearOptimistic();
          this.render();
        }, 20000);
      }
    }
  }

  rangeBounds(loId, hiId, fbMin, fbMax) {
    const a = this.state(loId)?.attributes ?? {};
    const b = this.state(hiId)?.attributes ?? {};
    const loKey = loId === this.config.range_left_entity ? 'left' : 'down';
    const hiKey = hiId === this.config.range_right_entity ? 'right' : 'up';
    return {
      min: Math.min(Number(a.min ?? fbMin), Number(b.min ?? fbMin)),
      max: Math.max(Number(a.max ?? fbMax), Number(b.max ?? fbMax)),
      step: Number(a.step ?? b.step ?? 5),
      lo: this.remembered(loKey, loId, fbMin),
      hi: this.remembered(hiKey, hiId, fbMax),
    };
  }

  async commitRange(loId, loVal, hiId, hiVal) {
    if (this._committing) return;
    if (!await this.ensureOn()) { this.render(); return; }
    this._committing = true;
    try {
      // Same pairing behaviour as the angle entities: wait for each write to
      // land before sending the other end of the range.
      if (Math.abs(this.value(loId, NaN) - loVal) > 0.01) {
        await this.setNumber(loId, loVal);
        await this.waitForNumber(loId, loVal, 10000);
        await this.sleep(Number(this.config.command_settle_ms));
      }
      if (Math.abs(this.value(hiId, NaN) - hiVal) > 0.01) {
        await this.setNumber(hiId, hiVal);
        await this.waitForNumber(hiId, hiVal, 10000);
      }
    } finally {
      this._committing = false;
      this.render();
    }
  }

  // Fraction of the pad on each edge that is dead space, so the full angle
  // range is reached well before the pointer hits the card edge.
  padInset() { return Number(this.config.pad_inset ?? 0.16); }

  padNorm(t) {
    const i = this.padInset();
    return Math.max(0, Math.min(1, (t - i) / (1 - 2 * i)));
  }

  padPos(n) {
    const i = this.padInset();
    return (i + n * (1 - 2 * i)) * 100;
  }

  // A strip along the bottom of the pad is kept clear for the horizontal sweep
  // bar, so the vertical mapping is squeezed into what is left. Constant rather
  // than only when oscillating, otherwise the model would jump when the mode
  // changes.
  padReserve() { return Number(this.config.sweep_strip ?? 0.12); }
  padPosY(n) { return this.padPos(n) * (1 - this.padReserve()); }
  padNormY(t) { return this.padNorm(t / (1 - this.padReserve())); }

  padX(h) { return this.padPos((h + 60) / 120); }
  padY(v) { return this.padPosY(1 - (v + 30) / 120); }

  // Horizontal and vertical angles use separate scales. Fixed mode draws one
  // thumb per axis; oscillation modes draw the two editable sweep end stops.
  // The vertical scale aligns with the horizontal rail's right end, but stays
  // elevated so the two distinct angle domains remain visually separate.
  sweepOverlay(direction) {
    const manual = direction === 'fixed';
    let out = '';
    const originX = this.padX(-60);
    const originBottom = Number(this.config.sweep_origin_bottom ?? 5.5);
    const ticks = (min, max, interval) => {
      const values = [];
      for (let value = min; value <= max; value += interval) values.push(value);
      return values;
    };
    if (manual || direction !== 'vertical') {
      // full mechanical range as the dim rail
      const ra = originX, rb = this.padX(60);
      out += `<div class="sweep-h rail" style="left:${ra.toFixed(2)}%;width:${(rb-ra).toFixed(2)}%;`
        + `bottom:${originBottom}%"></div>`;
      out += ticks(-60, 60, 15).map(value => {
        const minor = value % 30 !== 0;
        return `<div class="sweep-tick h${minor ? ' minor' : ''}" style="left:${this.padX(value).toFixed(2)}%;`
          + `bottom:calc(${originBottom}% - ${minor ? 2 : 5}px)"><span>${value}°</span></div>`;
      }).join('');
      if (manual) {
        const angle = this._optimistic?.h ?? this.hAngle();
        const zero = this.padX(0), value = this.padX(angle);
        out += `<div class="sweep-h single${angle < 0 ? ' negative' : ''}" style="left:${Math.min(zero,value).toFixed(2)}%;`
          + `width:${Math.abs(value-zero).toFixed(2)}%;bottom:${originBottom}%"><i></i></div>`;
      } else {
        const a = this.padX(this.sweepLeft()), b = this.padX(this.sweepRight());
        out += `<div class="sweep-h" style="left:${Math.min(a,b).toFixed(2)}%;`
          + `width:${Math.abs(b-a).toFixed(2)}%;bottom:${originBottom}%"><i></i><i></i></div>`;
      }
    }
    if (manual || direction !== 'horizontal') {
      // Keep the vertical scale separate from the horizontal one: their degree
      // domains differ even though both happen to span 120 degrees.
      const verticalX = this.padX(60);
      const railTop = this.padY(90);
      const verticalBottom = 100 - this.padY(-30);
      const railHeight = 100 - verticalBottom - railTop;
      const fromBottom = value => ((value + 30) / 120) * railHeight;
      out += `<div class="sweep-v rail" style="left:${verticalX.toFixed(2)}%;bottom:${verticalBottom.toFixed(2)}%;`
        + `height:${railHeight.toFixed(2)}%"></div>`;
      out += ticks(-30, 90, 15).map(value => {
        const minor = value % 30 !== 0;
        return `<div class="sweep-tick v${minor ? ' minor' : ''}" style="left:calc(${verticalX.toFixed(2)}% - ${minor ? 2 : 5}px);`
          + `bottom:${(verticalBottom + fromBottom(value)).toFixed(2)}%"><span>${value}°</span></div>`;
      }).join('');
      if (manual) {
        const angle = this._optimistic?.v ?? this.vAngle();
        const zero = fromBottom(0), value = fromBottom(angle);
        out += `<div class="sweep-v single${angle < 0 ? ' negative' : ''}" style="left:${verticalX.toFixed(2)}%;`
          + `bottom:${(verticalBottom + Math.min(zero,value)).toFixed(2)}%;`
          + `height:${Math.abs(value-zero).toFixed(2)}%"><i></i></div>`;
      } else {
        const down = fromBottom(this.sweepDown()), up = fromBottom(this.sweepUp());
        out += `<div class="sweep-v" style="left:${verticalX.toFixed(2)}%;`
          + `bottom:${(verticalBottom + Math.min(down,up)).toFixed(2)}%;`
          + `height:${Math.abs(up-down).toFixed(2)}%"><i></i><i></i></div>`;
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------
  // Fan model
  //
  // Drawn as SVG with the projection worked out in JS rather than stacked CSS
  // 3D planes. A plane has no side wall, so the old version went flat when
  // yawed and split into separate discs past about 40 degrees of tilt. Here the
  // drum is a real cylinder: two end caps plus the silhouette wall between
  // them, so it keeps its depth at every angle.
  // ---------------------------------------------------------------------

  // Current speed as a 1..speedCount step, or 0 when the fan is off.
  speedStep() {
    const fan = this.state(this.config.entity);
    if (fan?.state !== 'on') return 0;
    const count = this.speedCount();
    const pct = Number(fan.attributes.percentage ?? 0);
    return Math.max(0, Math.min(count, Math.round((pct / 100) * count)));
  }

  camera() { return (Number(this.config.camera_tilt ?? 20) * Math.PI) / 180; }

  // World is x right, y up, z toward the viewer. The camera sits camera_tilt
  // above the horizon looking down, so screen up is (0, cos c, -sin c).
  toScreen(p, c) {
    return { x: p[0], y: -(p[1] * Math.cos(c) - p[2] * Math.sin(c)) };
  }

  // Basis vectors of the drum face, projected to screen. Feeding these into an
  // SVG matrix() lets everything inside the drum be drawn in plain circle
  // coordinates and land correctly foreshortened.
  fanFrame(h, v) {
    const c = this.camera();
    const hr = (h * Number(this.config.yaw_gain ?? 1) * Math.PI) / 180;
    const vr = (v * Number(this.config.pitch_gain ?? 1) * Math.PI) / 180;
    const sh = Math.sin(hr), ch = Math.cos(hr);
    const sv = Math.sin(vr), cv = Math.cos(vr);
    const axis = [sh * cv, sv, ch * cv];
    // e1 runs along the tilt pivot, e2 is the face's own up direction.
    const e1 = [ch, 0, -sh];
    const e2 = [-sh * sv, cv, -ch * sv];
    return {
      c,
      sh,
      depth: axis[1] * Math.sin(c) + axis[2] * Math.cos(c),
      u: this.toScreen(axis, c),
      e1: this.toScreen(e1, c),
      e2: this.toScreen(e2, c),
      pivot: this.toScreen(e1, c),
      // How far the +e1 pivot leans toward the camera. Negative means it has
      // swung behind the drum and must not be drawn over it.
      pivotDepth: -sh * Math.cos(c),
    };
  }

  fanGraphic(h, v) {
    return `<div class="fan-stage"><svg class="fan-svg" viewBox="36 18 128 164"
      xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${this.fanSvgBody(h, v)}</svg></div>`;
  }

  fanSvgBody(h, v, spin = null) {
    const R = 43;    // drum radius at the grille
    const RB = R * Number(this.config.rear_taper ?? 0.9);  // 1 = straight barrel
    const D = 38;    // drum depth
    const RY = 52;   // yoke radius
    const CX = 100, CY = 88;
    const f = this.fanFrame(h, v);
    const c = f.c;
    const pt = (x, y) => `${x.toFixed(2)},${y.toFixed(2)}`;

    // End cap centres, split along the projected axis.
    const fx = CX + f.u.x * D / 2, fy = CY + f.u.y * D / 2;
    const bx = CX - f.u.x * D / 2, by = CY - f.u.y * D / 2;

    // Cylinder silhouette: perpendicular to the axis in screen space.
    const len = Math.hypot(f.u.x, f.u.y);
    const nx = len > 0.001 ? -f.u.y / len : 0;
    const ny = len > 0.001 ? f.u.x / len : 1;
    // One closed outline for the whole housing: front rim, both tangent sides,
    // and a curved rear end. Drawing the back as its own circle behind the
    // barrel left a crescent showing past the edge, which looked like the body
    // was transparent. Folded into the silhouette there is nothing behind to
    // show through.
    const ax = len > 0.001 ? f.u.x / len : 0;
    const ay = len > 0.001 ? f.u.y / len : 1;
    const bulge = (4 / 3) * RB * Math.abs(f.depth);
    const kx = -ax * bulge, ky = -ay * bulge;
    const bpx = bx + nx * RB, bpy = by + ny * RB;
    const bmx = bx - nx * RB, bmy = by - ny * RB;
    const wall = `M${pt(fx + nx * R, fy + ny * R)}`
      + `L${pt(bpx, bpy)}`
      + `C${pt(bpx + kx, bpy + ky)} ${pt(bmx + kx, bmy + ky)} ${pt(bmx, bmy)}`
      + `L${pt(fx - nx * R, fy - ny * R)}Z`;

    // Barrel shading runs across the tube, perpendicular to the axis, in user
    // space between the two silhouette edges. Endpoint order is fixed; picking
    // the "more lit looking" end instead would swap the whole gradient the
    // moment the perpendicular crosses vertical, which is a visible jump at
    // tan(v) = cos(h) * tan(camera_tilt). The highlight is placed by where the
    // light actually falls, so it slides smoothly instead.
    const lit = { x: CX + nx * R, y: CY + ny * R };
    const dim = { x: CX - nx * R, y: CY - ny * R };

    // Light sits above, left, and slightly in front. Across the visible half of
    // the cylinder the surface normal sweeps from +n through the view direction
    // to -n, so brightness at position s is A*cos(PI*s - phi).
    const LX = -0.46, LY = -0.55, LZ = 0.70;
    const along = LX * nx + LY * ny;
    const amp = Math.hypot(along, LZ);
    const phi = Math.atan2(LZ, along);
    const shade = b => {
      const t = Math.max(0, Math.min(1, b));
      const lo = [0x2a, 0x2f, 0x34], hi = [0xf5, 0xf8, 0xfb];
      const ch = i => Math.round(lo[i] + (hi[i] - lo[i]) * Math.pow(t, 0.85));
      return `rgb(${ch(0)},${ch(1)},${ch(2)})`;
    };
    const wallStops = [0, 0.12, 0.26, 0.42, 0.58, 0.74, 0.88, 1].map(s => {
      const lambert = Math.max(0, amp * Math.cos(Math.PI * s - phi));
      const edge = 1 - 0.32 * Math.pow(Math.abs(2 * s - 1), 3);
      return `<stop offset="${s}" stop-color="${shade((0.15 + 0.9 * lambert) * edge)}"/>`;
    }).join('');

    const cap = (cx, cy) => `matrix(${f.e1.x.toFixed(4)},${f.e1.y.toFixed(4)},`
      + `${f.e2.x.toFixed(4)},${f.e2.y.toFixed(4)},${cx.toFixed(2)},${cy.toFixed(2)})`;

    // Yoke ring lives in the plane through both pivots and straight down. Only
    // the lower half is real metal: local angle 0 is one pivot, -180 the other,
    // -90 the bottom of the cradle.
    const yu = f.pivot;
    const yw = { x: 0, y: -Math.cos(c) };
    const yoke = `matrix(${yu.x.toFixed(4)},${yu.y.toFixed(4)},`
      + `${yw.x.toFixed(4)},${yw.y.toFixed(4)},${CX},${CY})`;

    // As the head yaws, one arm swings toward the camera and must cross in
    // front of the barrel. Find where the ring passes through the pivot plane
    // and draw each side of that point separately.
    const armDepth = t => Math.cos(t) * -f.sh * Math.cos(c) + Math.sin(t) * Math.sin(c);
    let split = Math.atan2(f.sh * Math.cos(c), Math.sin(c));
    if (split > 0) split -= Math.PI;
    const arcPath = (t1, t2) => `M${pt(RY * Math.cos(t1), RY * Math.sin(t1))}`
      + `A${RY},${RY} 0 0 0 ${pt(RY * Math.cos(t2), RY * Math.sin(t2))}`;
    // Drawn as a dark stroke with the metal laid over it, so the arms keep a
    // thin outline wherever they cross the barrel. Butt caps matter here: the
    // two segments meet where the ring crosses the pivot plane, and a round cap
    // would overhang the neighbouring segment by half the stroke width, leaving
    // a dark mark that slides along the arm as the head turns. The outer ends
    // sit under the pivot balls, so nothing is lost by squaring them off.
    const arm = (t1, t2) => {
      const d = arcPath(t1, t2);
      return `<g transform="${yoke}">`
        + `<path d="${d}" fill="none" stroke="#0b0d0f" stroke-width="8.5"`
        + ` vector-effect="non-scaling-stroke"/>`
        + `<path d="${d}" fill="none" stroke="#c3cad1" stroke-width="6"`
        + ` vector-effect="non-scaling-stroke"/></g>`;
    };
    const segments = [[0, split], [split, -Math.PI]]
      .filter(([t1, t2]) => Math.abs(t1 - t2) > 0.01);
    const nearArms = segments.filter(([t1, t2]) => armDepth((t1 + t2) / 2) > 0)
      .map(([t1, t2]) => arm(t1, t2)).join('');
    const farArms = segments.filter(([t1, t2]) => armDepth((t1 + t2) / 2) <= 0)
      .map(([t1, t2]) => arm(t1, t2)).join('');

    // Blades sit in the cap's own circle space, so they spin true.
    const blade = `M0,-6 C14,-13 29,-8 34,4 C23,11 10,10 0,6 Z`;
    const blades = Array.from({ length: 7 }, (_, i) =>
      `<path d="${blade}" transform="rotate(${(i * 360 / 7).toFixed(2)})"/>`).join('');
    // Fine concentric wire guard: closely spaced rings, fading toward the rim.
    const ringCount = 10;
    const rings = Array.from({ length: ringCount }, (_, i) => {
      const t = i / (ringCount - 1);
      const r = 10 + t * (R - 9 - 10);
      return `<circle r="${r.toFixed(1)}" class="ring" opacity="${(0.85 - 0.35 * t).toFixed(2)}"/>`;
    }).join('');
    // Three swept supports, matching the blade curve rather than straight spokes.
    const ribs = Array.from({ length: 3 }, (_, i) =>
      `<path d="M8,0 Q${(R * 0.46).toFixed(1)},-8 ${(R - 8).toFixed(1)},-3"`
      + ` transform="rotate(${i * 120})" class="rib"/>`).join('');
    const spinAttr = spin === null
      ? ' class="blades"'
      : ` transform="rotate(${spin.toFixed(1)})"`;

    const nearCap = `<g transform="${cap(fx, fy)}">
      <circle r="${R}" fill="url(#dreoRim)" stroke="#0b0d0f" stroke-width="1.25"/>
      <circle r="${R - 3.5}" fill="#191c20"/>
      <circle r="${R - 6}" fill="url(#dreoThroat)"/>
      <g${spinAttr} fill="url(#dreoBlade)">${blades}</g>
      <circle r="${R - 6}" fill="url(#dreoVignette)"/>
      <g fill="none">${rings}${ribs}</g>
      <circle r="9.5" fill="url(#dreoHub)"/>
      <circle r="9.5" fill="none" stroke="rgba(203,213,223,.4)" stroke-width="1"/>
    </g>`;


    // Same dark outline as the arms so the balls stay readable against the body.
    const pivotAt = s => {
      const x = (CX + s * f.pivot.x * RY).toFixed(2);
      const y = (CY + s * f.pivot.y * RY).toFixed(2);
      return `<circle cx="${x}" cy="${y}" r="6" fill="url(#dreoRim)"`
        + ` stroke="#0b0d0f" stroke-width="1.25"/>`;
    };
    const plusInFront = f.pivotDepth >= 0;
    const nearPivot = pivotAt(plusInFront ? 1 : -1);
    const farPivot = pivotAt(plusInFront ? -1 : 1);

    return `<defs>
      <linearGradient id="dreoRim" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#fdfdfe"/><stop offset=".38" stop-color="#ccd3d9"/>
        <stop offset=".72" stop-color="#8b939b" /><stop offset="1" stop-color="#4b5157"/>
      </linearGradient>
      <linearGradient id="dreoWall" gradientUnits="userSpaceOnUse"
        x1="${lit.x.toFixed(2)}" y1="${lit.y.toFixed(2)}"
        x2="${dim.x.toFixed(2)}" y2="${dim.y.toFixed(2)}">${wallStops}</linearGradient>
      <linearGradient id="dreoStem" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#4d545a"/><stop offset=".34" stop-color="#e4e9ed"/>
        <stop offset=".66" stop-color="#a4acb3"/><stop offset="1" stop-color="#41474c"/>
      </linearGradient>
      <radialGradient id="dreoVignette">
        <stop offset=".5" stop-color="#000" stop-opacity="0"/>
        <stop offset="1" stop-color="#000" stop-opacity=".6"/>
      </radialGradient>
      <radialGradient id="dreoHub" cx=".36" cy=".3">
        <stop offset="0" stop-color="#3c4249"/><stop offset="1" stop-color="#0c0e10"/>
      </radialGradient>
      <radialGradient id="dreoThroat" cx=".4" cy=".34">
        <stop offset="0" stop-color="#23272b"/><stop offset="1" stop-color="#07080a"/>
      </radialGradient>
      <linearGradient id="dreoBlade" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#3c424a"/><stop offset="1" stop-color="#171a1e"/>
      </linearGradient>
      <linearGradient id="dreoBase" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#eef1f4"/><stop offset=".42" stop-color="#b3bac1"/>
        <stop offset="1" stop-color="#42474c"/>
      </linearGradient>
      <radialGradient id="dreoPool">
        <stop offset="0" stop-color="#000" stop-opacity=".5"/>
        <stop offset=".5" stop-color="#000" stop-opacity=".26"/>
        <stop offset="1" stop-color="#000" stop-opacity="0"/>
      </radialGradient>
      <radialGradient id="dreoContact">
        <stop offset="0" stop-color="#000" stop-opacity=".72"/>
        <stop offset=".62" stop-color="#000" stop-opacity=".34"/>
        <stop offset="1" stop-color="#000" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <ellipse cx="${CX}" cy="163" rx="54" ry="17" fill="url(#dreoPool)"/>
    <ellipse cx="${CX}" cy="160" rx="34" ry="9" fill="url(#dreoContact)"/>
    <ellipse cx="${CX}" cy="157" rx="38" ry="${(38 * Math.sin(c)).toFixed(1)}"
      fill="url(#dreoBase)" stroke="#0b0d0f" stroke-width="1.25"/>
    <rect x="${CX - 10}" y="130" width="20" height="30" rx="6"
      fill="url(#dreoStem)" stroke="#0b0d0f" stroke-width="1.25"/>
    ${farArms}
    ${farPivot}
    <path d="${wall}" fill="url(#dreoWall)" stroke="#0b0d0f" stroke-width="1.25"/>
    ${nearCap}
    ${nearArms}
    ${nearPivot}`;
  }

  // Where the head is pointing at fraction t through one sweep cycle.
  sweepAt(t) {
    const ease = x => (1 - Math.cos(2 * Math.PI * x)) / 2;
    const direction = this.direction();
    const left = this.sweepLeft(), right = this.sweepRight();
    const down = this.sweepDown(), up = this.sweepUp();
    if (direction === 'horizontal') {
      return { h: left + (right - left) * ease(t), v: this.vAngle() };
    }
    if (direction === 'vertical') {
      return { h: this.hAngle(), v: down + (up - down) * ease(t) };
    }
    return {
      h: left + (right - left) * ease(t),
      v: down + (up - down) * ease((t * 2) % 1),
    };
  }

  // Geometry changes shape as the head swings, not just its rotation, so the
  // sweep is redrawn rather than expressed as CSS keyframes.
  sweepLoop() {
    cancelAnimationFrame(this._raf);
    this._raf = null;
    if (!this.isOscillating()) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const period = Number(this.config.sweep_period_ms ?? 16000);
    const spinPeriod = 1100;
    let last = 0;
    const tick = now => {
      const svg = this.shadowRoot?.querySelector('.fan-svg');
      if (!svg) { this._raf = null; return; }
      if (now - last > 40) {
        last = now;
        const { h, v } = this.sweepAt((now % period) / period);
        const spin = this.state(this.config.entity)?.state === 'on'
          ? ((now % spinPeriod) / spinPeriod) * 360
          : 0;
        svg.innerHTML = this.fanSvgBody(h, v, spin);
      }
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }

  disconnectedCallback() {
    cancelAnimationFrame(this._raf);
    clearTimeout(this._optimisticTimer);
  }

  render() {
    const fan = this.state(this.config.entity);
    const on = fan?.state === 'on';
    const pct = Number(fan?.attributes.percentage ?? 0);
    const mode = fan?.attributes.preset_mode ?? 'Normal';
    const h = this._optimistic?.h ?? this.hAngle();
    const v = this._optimistic?.v ?? this.vAngle();
    const direction = this.direction();
    const modes = fan?.attributes.preset_modes ?? ['Normal','Natural','Sleep','Auto','Turbo','Custom'];
    const modeButtons = modes.map(m => `<button class="mode ${m === mode ? 'active' : ''}" data-mode="${m}">${m}</button>`).join('');
    const count = this.speedCount();
    const step = this.speedStep();
    const ticks = Array.from({ length: count }, (_, i) =>
      `<i class="${i < step ? 'on' : ''}" style="left:${count > 1 ? (i / (count - 1)) * 100 : 50}%"></i>`).join('');
    const hint = direction === 'fixed'
      ? 'Drag either slider to aim the fan'
      : 'Drag the blue end stops to set sweep limits';
    this.shadowRoot.innerHTML = `<style>${this.styles()}</style>
      <ha-card class="card ${on ? 'on' : 'off'} ${direction !== 'fixed' ? 'oscillating' : ''}">
        <header><div><h2>${this.config.name}</h2><p>${on ? `On · ${pct}% · ${mode}` : 'Off'}</p></div>
          <button class="power" aria-label="Power"><ha-icon icon="mdi:power"></ha-icon></button></header>

        <section class="mode-section"><details${this._modeOpen ? ' open' : ''}>
          <summary><span class="label">Mode</span><span class="mode-summary"><span>${mode}</span><ha-icon icon="mdi:chevron-down"></ha-icon></span></summary>
          <div class="modes">${modeButtons}</div>
        </details></section>

        <section class="speed-row"><div class="label">Speed</div><strong>${on ? step : 0}<small>/${count}</small></strong>
          <div class="slider-wrap">
            <input class="speed" type="range" min="1" max="${count}" step="1" value="${Math.max(1, step)}">
            <div class="ticks">${ticks}</div>
          </div></section>

        <section><div class="section-head"><div class="label">3D Angle Control${this._optimistic ? '<small class="sending">Sending…</small>' : ''}</div><div class="angles" aria-live="polite"></div></div>
          <div class="angle-pad" role="slider" aria-label="Fan angle">
            <div class="grid-lines"></div>${this.sweepOverlay(direction)}${this.fanGraphic(h, v)}
            ${direction === 'fixed' ? `<div class="aim-control" role="group" aria-label="Manual adjustment">
              <button class="aim-up" data-axis="v" data-delta="5" aria-label="Aim up"><ha-icon icon="mdi:chevron-up"></ha-icon></button>
              <button class="aim-left" data-axis="h" data-delta="-5" aria-label="Aim left"><ha-icon icon="mdi:chevron-left"></ha-icon></button>
              <button class="aim-right" data-axis="h" data-delta="5" aria-label="Aim right"><ha-icon icon="mdi:chevron-right"></ha-icon></button>
              <button class="aim-down" data-axis="v" data-delta="-5" aria-label="Aim down"><ha-icon icon="mdi:chevron-down"></ha-icon></button>
            </div>` : ''}
          </div>
          <div class="hint">${hint}</div>
        </section>

        <section><div class="label">Oscillation</div><div class="segments">
          ${[['fixed','Off'],['horizontal','Horizontal'],['vertical','Vertical'],['both','3D']].map(([x,l]) => `<button data-direction="${x}" class="${direction===x?'active':''}">${l}</button>`).join('')}
        </div></section>
      </ha-card>`;
    if (!on) {
      this.shadowRoot.querySelectorAll('section').forEach(section => { section.inert = true; });
      this.shadowRoot.querySelectorAll('section button, section input').forEach(control => {
        control.disabled = true;
      });
    }
    this._lastSignature = this.signature();
    this.bind();
    this.sweepLoop();
  }

  bind() {
    const $ = s => this.shadowRoot.querySelector(s);
    $('.power').onclick = () => this.call('fan', 'toggle', { entity_id: this.config.entity });
    if (this.state(this.config.entity)?.state !== 'on') return;
    const modeDetails = $('.mode-section details');
    modeDetails.ontoggle = () => { this._modeOpen = modeDetails.open; };
    this.shadowRoot.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => this.call('fan','set_preset_mode',{entity_id:this.config.entity,preset_mode:b.dataset.mode}));
    const speed = $('.speed');
    const ticks = this.shadowRoot.querySelectorAll('.ticks i');
    speed.oninput = e => {
      const step = Number(e.target.value);
      $('.speed-row strong').innerHTML = `${step}<small>/${this.speedCount()}</small>`;
      ticks.forEach((t, i) => t.classList.toggle('on', i < step));
    };
    speed.onchange = e => this.call('fan','set_percentage',{
      entity_id: this.config.entity,
      percentage: Math.round((Number(e.target.value) / this.speedCount()) * 100),
    });
    this.shadowRoot.querySelectorAll('[data-axis]').forEach(b => b.onclick = async () => this.nudge(b.dataset.axis, Number(b.dataset.delta)));
    this.shadowRoot.querySelectorAll('[data-direction]').forEach(b => b.onclick = () => this.setDirection(b.dataset.direction));

    const pad = $('.angle-pad');
    const direction = this.direction();
    const locked = this.lockedAxis();
    pad.onpointerdown = e => {
      if (e.target.closest('.aim-control')) return;
      if (this._committing) return;
      if (locked === 'both') {
        const rect = pad.getBoundingClientRect();
        const railTop = this.padY(90);
        const verticalBottom = 100 - this.padY(-30);
        const railHeight = 100 - verticalBottom - railTop;
        const endpoints = [];
        if (direction !== 'vertical') {
          const bar = pad.querySelector('.sweep-h:not(.rail)').getBoundingClientRect();
          endpoints.push(
            { axis: 'h', end: 'lo', x: ((bar.left - rect.left) / rect.width) * 100,
              y: ((bar.top + bar.height / 2 - rect.top) / rect.height) * 100 },
            { axis: 'h', end: 'hi', x: ((bar.right - rect.left) / rect.width) * 100,
              y: ((bar.top + bar.height / 2 - rect.top) / rect.height) * 100 },
          );
        }
        if (direction !== 'horizontal') {
          const bar = pad.querySelector('.sweep-v:not(.rail)').getBoundingClientRect();
          endpoints.push(
            { axis: 'v', end: 'lo', x: ((bar.left + bar.width / 2 - rect.left) / rect.width) * 100,
              y: ((bar.bottom - rect.top) / rect.height) * 100 },
            { axis: 'v', end: 'hi', x: ((bar.left + bar.width / 2 - rect.left) / rect.width) * 100,
              y: ((bar.top - rect.top) / rect.height) * 100 },
          );
        }
        const px = ((e.clientX - rect.left) / rect.width) * 100;
        const py = ((e.clientY - rect.top) / rect.height) * 100;
        const grabbed = endpoints.reduce((best, item) => {
          const distance = Math.hypot((item.x - px) * rect.width / 100,
            (item.y - py) * rect.height / 100);
          return !best || distance < best.distance ? { ...item, distance } : best;
        }, null);
        if (!grabbed) return;

        const axis = grabbed.axis;
        const loId = axis === 'h' ? this.config.range_left_entity : this.config.range_down_entity;
        const hiId = axis === 'h' ? this.config.range_right_entity : this.config.range_up_entity;
        const bounds = this.rangeBounds(loId, hiId, axis === 'h' ? -60 : -30,
          axis === 'h' ? 60 : 90);
        const cur = { lo: bounds.lo, hi: bounds.hi };
        const step = bounds.step || 5;
        const span = Math.max(step, Number(this.config.min_sweep ?? 30));
        const active = pad.querySelector(axis === 'h' ? '.sweep-h:not(.rail)' : '.sweep-v:not(.rail)');
        const valueAt = event => {
          if (axis === 'h') {
            const t = this.padNorm((event.clientX - rect.left) / rect.width);
            return Math.round((-60 + t * 120) / step) * step;
          }
          const bottom = ((rect.bottom - event.clientY) / rect.height) * 100;
          const t = Math.max(0, Math.min(1, (bottom - verticalBottom) / railHeight));
          return Math.round((-30 + t * 120) / step) * step;
        };
        const paintRange = () => {
          if (axis === 'h') {
            const a = this.padX(cur.lo), b = this.padX(cur.hi);
            active.style.left = `${Math.min(a, b)}%`;
            active.style.width = `${Math.abs(b - a)}%`;
          } else {
            const down = ((cur.lo + 30) / 120) * railHeight;
            const up = ((cur.hi + 30) / 120) * railHeight;
            active.style.bottom = `${verticalBottom + Math.min(down, up)}%`;
            active.style.height = `${Math.abs(up - down)}%`;
          }
        };
        const updateRange = event => {
          const value = Math.max(bounds.min, Math.min(bounds.max, valueAt(event)));
          cur[grabbed.end] = grabbed.end === 'lo'
            ? Math.min(value, cur.hi - span)
            : Math.max(value, cur.lo + span);
          paintRange();
          $('.angles').innerHTML = axis === 'h'
            ? `<span>↔ ${cur[grabbed.end]}°</span>`
            : `<span>↕ ${cur[grabbed.end]}°</span>`;
        };

        this._dragging = true;
        pad.setPointerCapture(e.pointerId);
        updateRange(e);
        pad.onpointermove = event => { if (this._dragging) updateRange(event); };
        pad.onpointerup = async () => {
          if (!this._dragging) return;
          this._dragging = false;
          $('.angles').innerHTML = '';
          await this.commitRange(loId, cur.lo, hiId, cur.hi);
        };
        pad.onpointercancel = () => { this._dragging = false; this.render(); };
        return;
      }

      const rect = pad.getBoundingClientRect();
      const horizontal = pad.querySelector('.sweep-h.single i').getBoundingClientRect();
      const vertical = pad.querySelector('.sweep-v.single i').getBoundingClientRect();
      const handles = [
        { axis: 'h', x: horizontal.left + horizontal.width / 2,
          y: horizontal.top + horizontal.height / 2 },
        { axis: 'v', x: vertical.left + vertical.width / 2,
          y: vertical.top + vertical.height / 2 },
      ];
      const grabbed = handles.reduce((best, item) => {
        const distance = Math.hypot(item.x - e.clientX, item.y - e.clientY);
        return !best || distance < best.distance ? { ...item, distance } : best;
      }, null);
      if (!grabbed) return;

      const axis = grabbed.axis;
      const hState = this.state(this.config.horizontal_entity);
      const vState = this.state(this.config.vertical_entity);
      const limits = {
        h: {
          min: Number(hState?.attributes.min ?? -60),
          max: Number(hState?.attributes.max ?? 60),
          step: Number(hState?.attributes.step ?? 5),
        },
        v: {
          min: Number(vState?.attributes.min ?? -30),
          max: Number(vState?.attributes.max ?? 90),
          step: Number(vState?.attributes.step ?? 5),
        },
      };
      const cur = { h: this.hAngle(), v: this.vAngle() };
      const railTop = this.padY(90);
      const verticalBottom = 100 - this.padY(-30);
      const railHeight = 100 - verticalBottom - railTop;
      const valueAt = event => {
        let raw;
        if (axis === 'h') {
          const t = this.padNorm((event.clientX - rect.left) / rect.width);
          raw = -60 + t * 120;
        } else {
          const bottom = ((rect.bottom - event.clientY) / rect.height) * 100;
          const t = Math.max(0, Math.min(1, (bottom - verticalBottom) / railHeight));
          raw = -30 + t * 120;
        }
        const { min, max, step } = limits[axis];
        return Math.max(min, Math.min(max, Math.round(raw / step) * step));
      };
      const paintManual = event => {
        cur[axis] = valueAt(event);
        if (axis === 'h') {
          const zero = this.padX(0), value = this.padX(cur.h);
          const bar = pad.querySelector('.sweep-h.single');
          bar.style.left = `${Math.min(zero, value)}%`;
          bar.style.width = `${Math.abs(value - zero)}%`;
          bar.classList.toggle('negative', cur.h < 0);
        } else {
          const zero = ((0 + 30) / 120) * railHeight;
          const value = ((cur.v + 30) / 120) * railHeight;
          const bar = pad.querySelector('.sweep-v.single');
          bar.style.bottom = `${verticalBottom + Math.min(zero, value)}%`;
          bar.style.height = `${Math.abs(value - zero)}%`;
          bar.classList.toggle('negative', cur.v < 0);
        }
        $('.angles').innerHTML = axis === 'h'
          ? `<span>↔ ${cur.h}°</span>`
          : `<span>↕ ${cur.v}°</span>`;
        const svg = $('.fan-svg');
        if (svg) svg.innerHTML = this.fanSvgBody(cur.h, cur.v);
      };

      this._dragging = true;
      pad.setPointerCapture(e.pointerId);
      paintManual(e);
      pad.onpointermove = event => { if (this._dragging) paintManual(event); };
      pad.onpointerup = async () => {
        if (!this._dragging) return;
        this._dragging = false;
        $('.angles').innerHTML = '';
        await this.commitOrientation(cur.h, cur.v, true);
      };
      pad.onpointercancel = () => { this._dragging = false; this.render(); };
    };
  }

  styles() { return `
    :host{--blue:#2f79ff;--sweep:#5aa9ff;display:block;font-family:var(--ha-card-header-font-family,system-ui)}
    *{box-sizing:border-box} .card{padding:14px 16px 16px;color:var(--primary-text-color);background:linear-gradient(145deg,rgba(50,54,60,.98),rgba(25,27,30,.98));border-radius:22px;overflow:hidden}
    header{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px} h2{margin:0 0 2px;font-size:19px;font-weight:600} p{margin:0;font-size:12px;color:var(--secondary-text-color)}.off header>div{opacity:.5;filter:grayscale(1)}
    button{font:inherit;color:inherit;border:0;cursor:pointer;-webkit-tap-highlight-color:transparent}.power{width:42px;height:42px;border-radius:50%;background:#45494f;display:grid;place-items:center}.on .power{background:var(--blue);color:white}.power ha-icon{--mdc-icon-size:22px}
    button:focus-visible{outline:2px solid var(--blue);outline-offset:2px}
    section{margin-top:12px}.off section{opacity:.4;filter:grayscale(1);pointer-events:none;user-select:none}.off section button,.off section input{cursor:not-allowed}.label{font-size:12px;color:#c5c8cc;margin-bottom:6px}.modes,.segments{display:flex;gap:4px;padding:3px;background:#202226;border-radius:13px;overflow-x:auto}.mode,.segments button{flex:1;min-width:max-content;padding:7px 10px;border-radius:10px;font-size:12px;background:transparent;color:#aeb1b5}.mode.active,.segments button.active{background:#f5f5f6;color:#202124;font-weight:600}
    .mode-section summary{display:flex;align-items:center;justify-content:space-between;list-style:none;cursor:pointer;-webkit-tap-highlight-color:transparent}.mode-section summary::-webkit-details-marker{display:none}.mode-section summary .label{margin-bottom:0}.mode-summary{display:flex;align-items:center;gap:3px;color:var(--blue);font-size:12px}.mode-summary ha-icon{--mdc-icon-size:18px;transition:transform .18s ease}.mode-section details[open] .mode-summary ha-icon{transform:rotate(180deg)}.mode-section .modes{margin-top:6px}
    .speed-row{display:grid;grid-template-columns:auto auto 1fr;align-items:center;gap:10px}.speed-row .label{margin-bottom:0}.speed-row strong{font-size:17px;line-height:1;color:var(--blue)}.speed-row strong small{font-size:11px;color:#8a8f96}
    .slider-wrap{position:relative;padding-bottom:8px}input[type=range]{display:block;width:100%;margin:0;accent-color:var(--blue)}.ticks{position:absolute;left:8px;right:8px;bottom:0;height:6px}.ticks i{position:absolute;width:2px;height:6px;margin-left:-1px;border-radius:1px;background:#4a4f56}.ticks i.on{background:var(--blue)}
    .section-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}.section-head .label{display:flex;align-items:center;gap:6px;margin-bottom:0;white-space:nowrap}.section-head .sending{color:var(--blue);font-size:10px;line-height:1}.angles{display:none;align-items:center;gap:8px;color:#fff;font-size:16px;font-weight:700;line-height:1;text-shadow:0 1px 3px rgba(0,0,0,.7)}.angles:not(:empty){display:flex}.angles i{height:14px;width:1px;background:#62666d}
    .angle-pad{height:320px;position:relative;overflow:hidden;border-radius:16px;background:radial-gradient(ellipse at 50% 82%,#34404f 0,#24282e 30%,#17191d 72%);touch-action:none;border:1px solid #373b41;cursor:grab}.angle-pad:active{cursor:grabbing}.grid-lines{position:absolute;inset:12px;background:linear-gradient(90deg,transparent 49.8%,#30343a 50%,transparent 50.2%),linear-gradient(0deg,transparent 49.8%,#30343a 50%,transparent 50.2%)}

    /* --- fan model: SVG cylinder, geometry computed in fanSvgBody --- */
    .fan-stage{position:absolute;z-index:1;left:50%;top:44%;width:100%;height:90%;max-width:250px;transform:translate(-50%,-50%)}
    .fan-svg{width:100%;height:100%;display:block;overflow:visible}
    .fan-svg .ring{stroke:rgba(190,201,212,.4);stroke-width:.85}
    .fan-svg .rib{stroke:rgba(206,216,226,.5);stroke-width:2.2;stroke-linecap:round}
    .fan-svg .blades{transform-box:fill-box;transform-origin:center}
    .on .fan-svg .blades{animation:blade-motion 1.1s linear infinite}
    @keyframes blade-motion{to{transform:rotate(360deg)}}
    .hint{text-align:center;margin-top:5px;color:#858a91;font-size:11px}
    .aim-control{position:absolute;z-index:5;top:9px;left:9px;width:100px;height:100px;border:1px solid rgba(255,255,255,.14);border-radius:15px;background:linear-gradient(145deg,rgba(61,68,78,.88),rgba(31,35,41,.9));box-shadow:inset 0 1px 0 rgba(255,255,255,.1),0 8px 20px rgba(0,0,0,.3);backdrop-filter:blur(7px);overflow:hidden;touch-action:manipulation}.aim-control button{position:absolute;inset:4px;display:block;background:rgba(255,255,255,.025);color:#d6dbe2;transition:background .12s ease,color .12s ease;touch-action:manipulation}.aim-control button:hover{background:rgba(255,255,255,.1);color:#fff}.aim-control button:active{background:rgba(47,121,255,.42);color:#fff}.aim-control button ha-icon{position:absolute;--mdc-icon-size:25px;filter:drop-shadow(0 1px 2px rgba(0,0,0,.5))}.aim-up{clip-path:polygon(0 0,100% 0,50% 50%)}.aim-up ha-icon{top:6px;left:50%;transform:translateX(-50%)}.aim-right{clip-path:polygon(100% 0,100% 100%,50% 50%)}.aim-right ha-icon{top:50%;right:6px;transform:translateY(-50%)}.aim-down{clip-path:polygon(0 100%,100% 100%,50% 50%)}.aim-down ha-icon{bottom:6px;left:50%;transform:translateX(-50%)}.aim-left{clip-path:polygon(0 0,50% 50%,0 100%)}.aim-left ha-icon{top:50%;left:6px;transform:translateY(-50%)}
    .sweep-h,.sweep-v{position:absolute;z-index:3;background:var(--sweep);border-radius:2px;pointer-events:none;filter:drop-shadow(0 0 5px rgba(90,169,255,.5))}
    .sweep-h.rail,.sweep-v.rail{background:rgba(255,255,255,.14);filter:none;z-index:2}
    .sweep-h i,.sweep-v i{position:absolute;width:18px;height:18px;border:1px solid #d9dde2;border-radius:50%;background:#f5f5f6;box-shadow:0 1px 4px rgba(0,0,0,.55)}
    .sweep-h{height:4px;bottom:5.5%}
    .sweep-h i{top:50%}.sweep-h i:first-child{left:0;transform:translate(-50%,-50%)}.sweep-h i:last-child{right:0;transform:translate(50%,-50%)}
    .sweep-h.single i{left:auto;right:0;transform:translate(50%,-50%)}.sweep-h.single.negative i{left:0;right:auto;transform:translate(-50%,-50%)}
    .sweep-v{width:4px}
    .sweep-v i{left:50%}.sweep-v i:first-child{top:0;transform:translate(-50%,-50%)}.sweep-v i:last-child{bottom:0;transform:translate(-50%,50%)}
    .sweep-v.single i{top:0;bottom:auto;transform:translate(-50%,-50%)}.sweep-v.single.negative i{top:auto;bottom:0;transform:translate(-50%,50%)}
    .sweep-tick{position:absolute;z-index:2;pointer-events:none;background:rgba(235,239,244,.68);filter:drop-shadow(0 0 2px rgba(0,0,0,.75))}
    .sweep-tick span{position:absolute;color:#f0f3f7;font-size:13px;font-weight:600;line-height:1;letter-spacing:.1px;white-space:nowrap;text-shadow:0 1px 3px #090b0e,0 0 4px #090b0e}
    .sweep-tick.h{width:2px;height:14px}.sweep-tick.h span{left:50%;top:-20px;transform:translateX(-50%)}
    .sweep-tick.v{width:14px;height:2px}.sweep-tick.v span{left:18px;top:50%;transform:translateY(-50%)}
    .sweep-tick.minor{background:rgba(210,216,224,.48);filter:none}.sweep-tick.minor span{color:#b9c0c9;font-size:10px;font-weight:500;text-shadow:0 1px 3px #090b0e}.sweep-tick.h.minor{width:1px;height:8px}.sweep-tick.h.minor span{top:-14px}.sweep-tick.v.minor{width:8px;height:1px}.sweep-tick.v.minor span{left:12px}
    @media(max-width:420px){.card{padding:12px}.angle-pad{height:292px}.fan-stage{max-width:240px}.aim-control{top:8px;left:8px;width:96px;height:96px}.segments button{font-size:11px;padding:7px 6px}}
    @media(prefers-reduced-motion:reduce){.on .grille{animation:none}}
  `; }
}

// Guarded so re-importing the module (as the loader shim does on every page
// load) cannot throw "the name has already been used with this registry".
if (!customElements.get('dreo-fan-card')) {
  customElements.define('dreo-fan-card', DreoFanCard);
  window.customCards = window.customCards || [];
  window.customCards.push({ type:'dreo-fan-card', name:'Dreo Fan Card', description:'Dreo-inspired fan controller with 2D angle dragging' });
}
