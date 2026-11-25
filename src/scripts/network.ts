// Living network backdrop: drifting nodes, links that brighten near the pointer, and small signals travelling along the links.
// Decorative only. Draws one still frame for visitors who prefer reduced motion, pauses when the tab is hidden, and keeps the
// node count low on small screens.
const canvas = document.querySelector<HTMLCanvasElement>('.aurora canvas.net');
const ctx = canvas?.getContext('2d', { alpha: true });

if (canvas && ctx) {
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const coarse = matchMedia('(pointer: coarse)').matches;

  interface Node { x: number; y: number; vx: number; vy: number; r: number; ph: number }
  interface Pulse { a: Node; b: Node; t: number; speed: number }

  let w = 0, h = 0, dpr = 1, link = 150;
  let nodes: Node[] = [];
  let pulses: Pulse[] = [];
  let rgbA = '28,96,214', rgbB = '124,92,255';
  const mouse = { x: -9999, y: -9999, on: false };
  let raf = 0, last = 0, spawn = 0;

  const rand = (a: number, b: number) => a + Math.random() * (b - a);

  /** Reads the theme colours (CSS custom properties "r g b") so the network follows light and dark mode. */
  function readColors() {
    const cs = getComputedStyle(canvas!);
    const rgb = (name: string, fb: string) => (cs.getPropertyValue(name).trim().split(/\s+/).filter((n) => /^\d+$/.test(n)).join(',') || fb);
    rgbA = rgb('--net-a', rgbA);
    rgbB = rgb('--net-b', rgbB);
  }

  function resize() {
    dpr = Math.min(devicePixelRatio || 1, coarse ? 1.5 : 2);
    w = innerWidth; h = innerHeight;
    canvas!.width = Math.round(w * dpr); canvas!.height = Math.round(h * dpr);
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    link = Math.max(110, Math.min(170, w / 7));
    const want = Math.max(14, Math.min(coarse ? 34 : 78, Math.round((w * h) / 17000)));
    while (nodes.length < want) nodes.push({ x: rand(0, w), y: rand(0, h), vx: rand(-0.16, 0.16), vy: rand(-0.12, 0.12), r: rand(1, 2.3), ph: rand(0, 6.28) });
    if (nodes.length > want) nodes.length = want;
    for (const n of nodes) { if (n.x > w) n.x = rand(0, w); if (n.y > h) n.y = rand(0, h); }
  }

  function step(dt: number) {
    for (const n of nodes) {
      n.x += n.vx * dt; n.y += n.vy * dt; n.ph += dt * 0.002;
      if (n.x < -20) n.x = w + 20; else if (n.x > w + 20) n.x = -20;
      if (n.y < -20) n.y = h + 20; else if (n.y > h + 20) n.y = -20;
      if (mouse.on) {   // a gentle pull toward the pointer
        const dx = mouse.x - n.x, dy = mouse.y - n.y, d = Math.hypot(dx, dy);
        if (d < 220 && d > 1) { const f = ((220 - d) / 220) * 0.012 * dt * 0.06; n.x += dx * f; n.y += dy * f; }
      }
    }
    for (let i = pulses.length - 1; i >= 0; i--) { pulses[i].t += (dt / 1000) * pulses[i].speed; if (pulses[i].t >= 1) pulses.splice(i, 1); }
    spawn -= dt;
    if (spawn <= 0 && pulses.length < (coarse ? 3 : 7)) {
      spawn = rand(350, 900);
      const a = nodes[(Math.random() * nodes.length) | 0];
      const near = nodes.filter((b) => b !== a && Math.hypot(a.x - b.x, a.y - b.y) < link);
      if (near.length) pulses.push({ a, b: near[(Math.random() * near.length) | 0], t: 0, speed: rand(0.7, 1.3) });
    }
  }

  function draw() {
    ctx!.clearRect(0, 0, w, h);
    ctx!.lineWidth = 1;
    // links
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d > link) continue;
        let al = (1 - d / link) * 0.42;
        if (mouse.on) { const md = Math.hypot((a.x + b.x) / 2 - mouse.x, (a.y + b.y) / 2 - mouse.y); if (md < 200) al += (1 - md / 200) * 0.4; }
        ctx!.strokeStyle = `rgba(${rgbA},${Math.min(al, 0.8).toFixed(3)})`;
        ctx!.beginPath(); ctx!.moveTo(a.x, a.y); ctx!.lineTo(b.x, b.y); ctx!.stroke();
      }
      if (mouse.on) {   // pointer acts as a bright node
        const d = Math.hypot(a.x - mouse.x, a.y - mouse.y);
        if (d < 190) { ctx!.strokeStyle = `rgba(${rgbB},${((1 - d / 190) * 0.65).toFixed(3)})`; ctx!.beginPath(); ctx!.moveTo(a.x, a.y); ctx!.lineTo(mouse.x, mouse.y); ctx!.stroke(); }
      }
    }
    // nodes
    for (const n of nodes) {
      const tw = 0.55 + 0.45 * Math.sin(n.ph);
      ctx!.fillStyle = `rgba(${rgbA},${(0.35 + tw * 0.4).toFixed(3)})`;
      ctx!.beginPath(); ctx!.arc(n.x, n.y, n.r, 0, 6.2832); ctx!.fill();
      if (n.r > 1.9) {   // the bigger nodes get a soft halo
        const g = ctx!.createRadialGradient(n.x, n.y, 0, n.x, n.y, 11);
        g.addColorStop(0, `rgba(${rgbB},${(0.28 * tw).toFixed(3)})`); g.addColorStop(1, `rgba(${rgbB},0)`);
        ctx!.fillStyle = g; ctx!.beginPath(); ctx!.arc(n.x, n.y, 11, 0, 6.2832); ctx!.fill();
      }
    }
    // signals
    for (const p of pulses) {
      const e = p.t < 0.5 ? 2 * p.t * p.t : 1 - Math.pow(-2 * p.t + 2, 2) / 2;
      const x = p.a.x + (p.b.x - p.a.x) * e, y = p.a.y + (p.b.y - p.a.y) * e;
      const fade = Math.sin(Math.PI * p.t);
      const g = ctx!.createRadialGradient(x, y, 0, x, y, 12);
      g.addColorStop(0, `rgba(${rgbB},${(0.95 * fade).toFixed(3)})`); g.addColorStop(1, `rgba(${rgbB},0)`);
      ctx!.fillStyle = g; ctx!.beginPath(); ctx!.arc(x, y, 12, 0, 6.2832); ctx!.fill();
      ctx!.fillStyle = `rgba(255,255,255,${(0.9 * fade).toFixed(3)})`; ctx!.beginPath(); ctx!.arc(x, y, 1.6, 0, 6.2832); ctx!.fill();
    }
  }

  function frame(t: number) {
    const dt = Math.min(48, t - (last || t)); last = t;
    step(dt); draw();
    raf = requestAnimationFrame(frame);
  }
  const play = () => { if (!raf && !still && !document.hidden) { last = 0; raf = requestAnimationFrame(frame); } };
  const stop = () => { cancelAnimationFrame(raf); raf = 0; };

  readColors(); resize(); draw();
  if (!still) play();

  let rt = 0;
  addEventListener('resize', () => { clearTimeout(rt); rt = window.setTimeout(() => { resize(); if (still) draw(); }, 150); }, { passive: true });
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : play()));
  new MutationObserver(() => { readColors(); if (still) draw(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
  if (!still && !coarse) {
    document.addEventListener('pointermove', (e) => { if (e.pointerType !== 'mouse') return; mouse.x = e.clientX; mouse.y = e.clientY; mouse.on = true; }, { passive: true });
    document.addEventListener('pointerleave', () => { mouse.on = false; });
  }
}
