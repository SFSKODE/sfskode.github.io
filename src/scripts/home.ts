// Home page: kinetic headline, featured carousel, playground demo, marquee, live search, resume strip.
import { loadIndex, search, toTerms, highlight, escapeHtml, type SearchItem } from './search-core';
import { reduced, finePointer, clamp, frame } from './util';

const still = reduced();

/* ====================== 1. Kinetic headline ====================== */
// Every letter rises and swells near the pointer; when nobody is hovering, a slow wave rolls through the line.
// Only transforms change, so the text never reflows. The gradient word is painted per letter (see --lx/--rw).
const title = document.querySelector<HTMLElement>('[data-kinetic]');
if (title) {
  const letters: HTMLElement[] = [];
  title.setAttribute('aria-label', (title.textContent ?? '').replace(/\s+/g, ' ').trim());
  const walk = (node: Node) => {
    for (const ch of [...node.childNodes]) {
      if (ch.nodeType === Node.TEXT_NODE) {
        const frag = document.createDocumentFragment();
        for (const part of (ch.textContent ?? '').split(/(\s+)/)) {
          if (!part) continue;
          if (/^\s+$/.test(part)) { frag.append(' '); continue; }
          const w = document.createElement('span');
          w.className = 'hw';
          w.setAttribute('aria-hidden', 'true');
          for (const c of part) { const k = document.createElement('span'); k.className = 'k'; k.textContent = c; w.append(k); letters.push(k); }
          frag.append(w);
        }
        ch.replaceWith(frag);
      } else if (ch.nodeType === Node.ELEMENT_NODE) walk(ch);
    }
  };
  walk(title);

  const g = title.querySelector<HTMLElement>('.g');
  const measure = () => {
    if (!g) return;
    const w = g.offsetWidth;
    g.querySelectorAll<HTMLElement>('.k').forEach((k) => { k.style.setProperty('--lx', `${k.offsetLeft}px`); k.style.setProperty('--rw', `${w}px`); });
  };
  measure();
  void document.fonts?.ready.then(measure);
  if ('ResizeObserver' in window) new ResizeObserver(measure).observe(title);

  if (!still) {
    let px = -9999, py = -9999, active = false, raf = 0, inView = true;
    const tick = (t: number) => {
      raf = 0;
      if (!inView) return;
      letters.forEach((l, i) => {
        let k = 0;
        if (active) {
          const r = l.getBoundingClientRect();
          const d = Math.hypot(px - (r.left + r.width / 2), (py - (r.top + r.height / 2)) * 0.8);
          k = clamp(1 - d / 240, 0, 1);
        }
        const wave = Math.sin(t / 950 + i * 0.62);
        l.style.setProperty('--ty', `${(wave * 2.4 - k * k * 16).toFixed(2)}px`);
        l.style.setProperty('--sc', (1 + k * k * 0.12).toFixed(3));
      });
      raf = requestAnimationFrame(tick);
    };
    const start = () => { if (!raf && inView) raf = requestAnimationFrame(tick); };
    new IntersectionObserver((e) => { inView = e[0].isIntersecting; if (inView) start(); }).observe(title);
    const hero = title.closest<HTMLElement>('[data-hero]') ?? document.body;
    hero.addEventListener('pointermove', (e) => { if (e.pointerType !== 'mouse') return; px = e.clientX; py = e.clientY; active = true; }, { passive: true });
    hero.addEventListener('pointerleave', () => { active = false; });
    start();
  }
}

/* ====================== 2. Featured carousel ====================== */
// Every card is a real link. Arrows, keyboard and swipe move between them; the dots follow the scroll position.
const feat = document.querySelector<HTMLElement>('[data-feat]');
const ftrack = feat?.querySelector<HTMLElement>('[data-feat-track]');
if (feat && ftrack) {
  const cards = [...ftrack.querySelectorAll<HTMLElement>('.card')];
  const prev = feat.querySelector<HTMLButtonElement>('[data-feat-prev]');
  const next = feat.querySelector<HTMLButtonElement>('[data-feat-next]');
  const dots = [...feat.querySelectorAll<HTMLElement>('[data-feat-dots] i')];
  const stepPx = () => ((cards[1]?.offsetLeft ?? 0) - (cards[0]?.offsetLeft ?? 0)) || ftrack.clientWidth * 0.8;
  const update = () => {
    const max = ftrack.scrollWidth - ftrack.clientWidth;
    feat.toggleAttribute('data-fits', max <= 4);
    if (prev) prev.disabled = ftrack.scrollLeft <= 4;
    if (next) next.disabled = ftrack.scrollLeft >= max - 4;
    const pad = parseFloat(getComputedStyle(ftrack).paddingLeft) || 0;
    let best = 0, bd = Infinity;
    cards.forEach((c, i) => { const d = Math.abs(c.offsetLeft - pad - ftrack.scrollLeft); if (d < bd) { bd = d; best = i; } });
    if (ftrack.scrollLeft >= max - 4 && max > 4) best = cards.length - 1;
    dots.forEach((d, i) => d.toggleAttribute('data-on', i === best));
  };
  const go = (dir: number) => ftrack.scrollBy({ left: dir * stepPx(), behavior: still ? 'auto' : 'smooth' });
  prev?.addEventListener('click', () => go(-1));
  next?.addEventListener('click', () => go(1));
  ftrack.addEventListener('keydown', (e) => {
    if (e.target !== ftrack) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
  });
  ftrack.addEventListener('scroll', frame(update), { passive: true });
  if ('ResizeObserver' in window) new ResizeObserver(update).observe(ftrack);
  update();
}

/* ====================== 4. Playground demo: types the query, then the rows arrive ====================== */
const ide = document.querySelector<HTMLElement>('[data-ide]');
const code = ide?.querySelector<HTMLElement>('[data-ide-code]');
if (ide && code && !still && 'IntersectionObserver' in window) {
  const html = code.innerHTML;
  const finalText = code.textContent ?? '';
  // Reveal the already-highlighted markup one character at a time, without ever splitting a tag.
  const slice = (n: number) => {
    let out = '', seen = 0, i = 0;
    while (i < html.length && seen < n) {
      if (html[i] === '<') { const j = html.indexOf('>', i); out += html.slice(i, j + 1); i = j + 1; continue; }
      if (html[i] === '&') { const j = html.indexOf(';', i); out += html.slice(i, j + 1); i = j + 1; seen++; continue; }
      out += html[i++]; seen++;
    }
    // close any open spans
    const opens = (out.match(/<span/g) ?? []).length - (out.match(/<\/span>/g) ?? []).length;
    return out + '</span>'.repeat(Math.max(0, opens));
  };
  let ran = false;
  const play = () => {
    if (ran) return; ran = true;
    ide.removeAttribute('data-done');
    let n = 0;
    const total = finalText.length;
    const step = () => {
      n += 2;
      code.innerHTML = slice(n) + '<i class="ide__caret"></i>';
      if (n < total) window.setTimeout(step, 22);
      else { code.innerHTML = html + '<i class="ide__caret"></i>'; window.setTimeout(() => ide.setAttribute('data-done', ''), 350); }
    };
    code.innerHTML = '<i class="ide__caret"></i>';
    window.setTimeout(step, 500);
  };
  new IntersectionObserver((e, o) => { if (e[0].isIntersecting) { play(); o.disconnect(); } }, { threshold: 0.35 }).observe(ide);
  code.innerHTML = '<i class="ide__caret"></i>';
} else if (ide) {
  ide.setAttribute('data-done', '');
}

/* ====================== 5. Marquee: speeds up with scrolling, reverses with direction ====================== */
const track = document.querySelector<HTMLElement>('[data-marquee] .marquee__track');
if (track && !still && 'getAnimations' in track) {
  const anim = track.getAnimations()[0];
  if (anim) {
    let lastY = scrollY, rate = 1;
    const tick = () => {
      const dy = scrollY - lastY; lastY = scrollY;
      const target = 1 + clamp(Math.abs(dy) * 0.5, 0, 9);
      const dir = dy < -0.5 ? -1 : dy > 0.5 ? 1 : Math.sign(rate) || 1;
      rate += (dir * target - rate) * 0.08;
      anim.updatePlaybackRate(rate);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}

/* ====================== 6. Resume strip ====================== */
try {
  const raw = localStorage.getItem('skode:resume');
  const box = document.querySelector<HTMLElement>('[data-resume]');
  if (raw && box) {
    const r = JSON.parse(raw) as { slug: string; title: string; p: number };
    if (r.slug && r.title && r.p > 0.03 && r.p < 0.97) {
      const link = box.querySelector<HTMLAnchorElement>('[data-resume-link]')!;
      link.textContent = r.title;
      link.href = `/articles/${encodeURIComponent(r.slug)}/`;
      box.querySelector<HTMLAnchorElement>('[data-resume-go]')!.href = link.href;
      box.querySelector<HTMLElement>('[data-resume-bar]')?.style.setProperty('--p', String(r.p));
      box.setAttribute('data-on', '');
    }
  }
} catch { /* storage unavailable: no resume strip */ }

/* ====================== 4. Live search ====================== */
const hs = document.querySelector<HTMLElement>('[data-hs]');
const input = document.getElementById('hs-input') as HTMLInputElement | null;
const list = document.getElementById('hs-list') as HTMLUListElement | null;
if (hs && input && list) {
  let items: SearchItem[] = [];
  let loaded = false;
  let active = -1;

  const open = (on: boolean) => { list.hidden = !on; input.setAttribute('aria-expanded', String(on)); hs.toggleAttribute('data-open', on); if (!on) { active = -1; input.removeAttribute('aria-activedescendant'); } };
  const setActive = (n: number) => {
    const opts = [...list.querySelectorAll<HTMLElement>('[role="option"]')];
    if (!opts.length) return;
    active = (n + opts.length) % opts.length;
    opts.forEach((o, k) => o.setAttribute('aria-selected', String(k === active)));
    input.setAttribute('aria-activedescendant', opts[active].id);
    opts[active].scrollIntoView({ block: 'nearest' });
  };
  const render = () => {
    const q = input.value.trim();
    const terms = toTerms(q);
    if (!loaded) { list.innerHTML = '<li class="hs__msg" role="presentation">Loading the library…</li>'; open(true); return; }
    const res = search(items, q).slice(0, terms.length ? 6 : 4);
    if (!res.length) { list.innerHTML = `<li class="hs__msg" role="presentation">No guides match “${escapeHtml(q)}”. Try a broader word.</li>`; open(true); return; }
    list.innerHTML = res.map((it, k) =>
      `<li role="option" id="hs-opt-${k}" aria-selected="false"><a class="hs__item" href="/articles/${encodeURIComponent(it.id)}/" tabindex="-1">` +
      (it.thumb ? `<img src="${escapeHtml(it.thumb.src)}" width="64" height="36" alt="" loading="lazy" decoding="async">` : '<span class="hs__noimg"></span>') +
      `<span class="hs__txt"><span class="hs__title">${highlight(it.title, terms)}</span><span class="hs__sub">${escapeHtml(it.short)} · ${it.mins} min</span></span></a></li>`).join('') +
      `<li class="hs__more" role="presentation"><a href="/search/${q ? `?q=${encodeURIComponent(q)}` : ''}" tabindex="-1">See all results<span aria-hidden="true"> →</span></a></li>`;
    open(true);
    setActive(terms.length ? 0 : -1);
  };
  const load = () => {
    if (loaded) return;
    loadIndex().then((d) => { items = d; loaded = true; if (document.activeElement === input) render(); }).catch(() => { /* the form still submits to /search/ */ });
  };

  input.addEventListener('focus', () => { load(); render(); });
  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (list.hidden) render(); else setActive(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
    else if (e.key === 'Escape') { if (!list.hidden) { e.preventDefault(); open(false); } }
    else if (e.key === 'Enter' && active >= 0 && !list.hidden) {
      const a = list.querySelectorAll<HTMLAnchorElement>('[role="option"] a')[active];
      if (a) { e.preventDefault(); location.href = a.href; }
    }
  });
  // Pointer-down on a suggestion must not blur the field before the click lands.
  list.addEventListener('pointerdown', (e) => e.preventDefault());
  list.addEventListener('click', (e) => { const a = (e.target as HTMLElement).closest('a'); if (a) location.href = (a as HTMLAnchorElement).href; });
  input.addEventListener('blur', () => window.setTimeout(() => open(false), 120));
  hs.querySelector('form')?.addEventListener('pointerenter', load, { once: true });
}
