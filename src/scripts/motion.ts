// Site-wide motion layer: masked word reveals, labelled cursor, header progress, kinetic footer wordmark,
// aurora (scroll + pointer light), card tilt, parallax, and shared-element page transitions. Everything is progressive enhancement and respects reduced motion.
import { frame, reduced, finePointer, clamp } from './util';

const root = document.documentElement;
const still = reduced();

/* ---------- Masked word reveal for [data-words] headings ---------- */
function splitWords(el: HTMLElement) {
  if (el.dataset.splitDone) return;
  let idx = 0;
  const walk = (node: Node) => {
    for (const ch of [...node.childNodes]) {
      if (ch.nodeType === Node.TEXT_NODE) {
        const frag = document.createDocumentFragment();
        const parts = (ch.textContent ?? '').split(/(\s+)/);
        // Punctuation glued to a preceding element (e.g. "<em>word</em>,") stays attached to that word.
        const prev = ch.previousSibling;
        if (parts[0] && !/^\s/.test(parts[0]) && prev?.nodeType === Node.ELEMENT_NODE) {
          const lw = [...(prev as HTMLElement).querySelectorAll<HTMLElement>('.w > span')].pop();
          if (lw) lw.append(parts.shift()!);
        }
        for (const part of parts) {
          if (!part) continue;
          if (/^\s+$/.test(part)) { frag.append(' '); continue; }
          const w = document.createElement('span');
          w.className = 'w';
          w.style.setProperty('--wi', String(idx++));
          const inner = document.createElement('span');
          inner.textContent = part;
          w.append(inner);
          frag.append(w);
        }
        ch.replaceWith(frag);
      } else if (ch.nodeType === Node.ELEMENT_NODE) walk(ch);
    }
  };
  walk(el);
  el.dataset.splitDone = '1';
}
const splits = [...document.querySelectorAll<HTMLElement>('[data-words]')];
splits.forEach(splitWords);
if (splits.length) {
  if (still || !('IntersectionObserver' in window)) splits.forEach((el) => el.classList.add('in'));
  else {
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) if (en.isIntersecting) { (en.target as HTMLElement).classList.add('in'); io.unobserve(en.target); }
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.01 });
    splits.forEach((el) => io.observe(el));
    window.setTimeout(() => {
      for (const el of splits) {
        if (el.classList.contains('in')) continue;
        const r = el.getBoundingClientRect();
        if (r.top < innerHeight && r.bottom > 0) el.classList.add('in');
      }
    }, 1500);
  }
}

/* ---------- Header: scroll progress hairline ---------- */
const hprog = document.querySelector<HTMLElement>('[data-hprog]');
if (hprog) {
  const upd = frame(() => {
    const max = document.documentElement.scrollHeight - innerHeight;
    hprog.style.setProperty('--p', String(max > 0 ? clamp(scrollY / max, 0, 1) : 0));
  });
  addEventListener('scroll', upd, { passive: true });
  addEventListener('resize', upd);
  upd();
}

/* ---------- Labelled cursor (mouse only) ---------- */
const cur = document.querySelector<HTMLElement>('[data-cursor-root]');
if (cur && finePointer() && !still) {
  const disc = cur.querySelector<HTMLElement>('.cursor__disc')!;
  let x = -100, y = -100, cx = -100, cy = -100, raf = 0, label = '';
  const loop = () => {
    cx += (x - cx) * 0.22;
    cy += (y - cy) * 0.22;
    cur.style.transform = `translate3d(${cx.toFixed(1)}px, ${cy.toFixed(1)}px, 0)`;
    raf = Math.abs(x - cx) + Math.abs(y - cy) > 0.3 ? requestAnimationFrame(loop) : 0;
  };
  document.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    cur.setAttribute('data-live', '');
    x = e.clientX; y = e.clientY;
    const t = (e.target as HTMLElement | null)?.closest?.<HTMLElement>('[data-cursor]');
    const next = t?.dataset.cursor ?? '';
    if (next !== label) { label = next; if (next) disc.textContent = next; cur.toggleAttribute('data-on', !!next); }
    if (!raf) raf = requestAnimationFrame(loop);
  }, { passive: true });
  root.addEventListener('pointerleave', () => { cur.removeAttribute('data-on'); label = ''; });
  document.addEventListener('pointerdown', () => cur.removeAttribute('data-on'));
}

/* ---------- Kinetic footer wordmark: weight follows the pointer ---------- */
const mark = document.querySelector<HTMLElement>('[data-wordmark]');
if (mark && finePointer() && !still) {
  const letters = [...mark.querySelectorAll<HTMLElement>('span')];
  const paint = frame((px: number, py: number) => {
    for (const l of letters) {
      const r = l.getBoundingClientRect();
      const d = Math.hypot(px - (r.left + r.width / 2), (py - (r.top + r.height / 2)) * 0.6);
      const k = clamp(1 - d / 360, 0, 1);
      l.style.setProperty('--w', String(Math.round(660 + k * 190)));
      l.style.setProperty('--s', String(Math.round(k * 100)));
    }
  });
  mark.closest('.site-footer')?.addEventListener('pointermove', (e) => { const p = e as PointerEvent; if (p.pointerType === 'mouse') paint(p.clientX, p.clientY); }, { passive: true });
}

/* ---------- Aurora: shifts a little as you scroll; a faint pool of light follows the pointer ---------- */
const aurora = document.querySelector<HTMLElement>('.aurora');
if (aurora && !still) {
  const sy = frame(() => aurora.style.setProperty('--sy', String(Math.round(scrollY))));
  addEventListener('scroll', sy, { passive: true });
  sy();
  if (finePointer()) {
    let tx = innerWidth * 0.7, ty = innerHeight * 0.2, cx = tx, cy = ty, raf = 0;
    const loop = () => {
      cx += (tx - cx) * 0.08; cy += (ty - cy) * 0.08;
      aurora.style.setProperty('--mx', `${cx.toFixed(0)}px`);
      aurora.style.setProperty('--my', `${cy.toFixed(0)}px`);
      raf = Math.abs(tx - cx) + Math.abs(ty - cy) > 0.8 ? requestAnimationFrame(loop) : 0;
    };
    document.addEventListener('pointermove', (e) => { if (e.pointerType !== 'mouse') return; tx = e.clientX; ty = e.clientY; if (!raf) raf = requestAnimationFrame(loop); }, { passive: true });
  }
}

/* ---------- Tilt: [data-tilt] cards lean toward the pointer and get a lit edge (mouse only) ---------- */
if (finePointer() && !still) {
  let cur: HTMLElement | null = null, raf = 0, lx = 0, ly = 0;
  const release = (el: HTMLElement) => {
    el.removeAttribute('data-tilting');
    for (const p of ['--rx', '--ry']) el.style.removeProperty(p);
  };
  const apply = () => {
    raf = 0;
    if (!cur) return;
    const r = cur.getBoundingClientRect();
    const x = clamp((lx - r.left) / r.width, 0, 1), y = clamp((ly - r.top) / r.height, 0, 1);
    const max = r.width > 640 ? 3.2 : r.width > 420 ? 4.6 : 6.5;
    cur.style.setProperty('--ry', `${((x - 0.5) * 2 * max).toFixed(2)}deg`);
    cur.style.setProperty('--rx', `${((0.5 - y) * 2 * max * 0.85).toFixed(2)}deg`);
    cur.style.setProperty('--gx', `${(x * 100).toFixed(1)}%`);
    cur.style.setProperty('--gy', `${(y * 100).toFixed(1)}%`);
  };
  document.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    const t = (e.target as Element | null)?.closest?.<HTMLElement>('[data-tilt]') ?? null;
    if (t !== cur) { if (cur) release(cur); cur = t; cur?.setAttribute('data-tilting', ''); }
    lx = e.clientX; ly = e.clientY;
    if (cur && !raf) raf = requestAnimationFrame(apply);
  }, { passive: true });
  root.addEventListener('pointerleave', () => { if (cur) { release(cur); cur = null; } });
  addEventListener('blur', () => { if (cur) { release(cur); cur = null; } });
}

/* ---------- Parallax: [data-parallax] drifts sideways as it crosses the screen ---------- */
const drifters = [...document.querySelectorAll<HTMLElement>('[data-parallax]')];
if (drifters.length && !still) {
  const upd = frame(() => {
    for (const el of drifters) {
      const host = el.parentElement ?? el;
      const r = host.getBoundingClientRect();
      if (r.bottom < -200 || r.top > innerHeight + 200) continue;
      const p = clamp((innerHeight - r.top) / (innerHeight + r.height), 0, 1);
      el.style.setProperty('--tx', `${((0.5 - p) * 30).toFixed(2)}vw`);
    }
  });
  addEventListener('scroll', upd, { passive: true });
  addEventListener('resize', upd);
  upd();
}

/* ---------- Page transitions: shared cover between list and article ---------- */
// The clicked card's cover gets the shared name just before the old page is captured (the arriving page names its
// own cover from an inline script in BaseLayout). Names are set per navigation, so duplicates can never occur.
type PageSwap = Event & { viewTransition?: { finished: Promise<void> } | null; activation?: { entry?: { url: string } } };
const ARTICLE = /^\/articles\/([^/]+)\/$/;
let lastCover: HTMLElement | null = null;
document.addEventListener('click', (e) => {
  const a = (e.target as HTMLElement | null)?.closest?.<HTMLAnchorElement>('a[href]');
  lastCover = null;
  if (!a) return;
  const m = ARTICLE.exec(new URL(a.href, location.href).pathname);
  if (!m) return;
  const box = a.closest('.card, .res');
  lastCover = box?.querySelector<HTMLElement>('[data-cover], .res__media') ?? null;
}, true);
const nameIt = (el: Element | null | undefined, vt: { finished: Promise<void> } | null | undefined) => {
  if (!el || !vt) return;
  (el as HTMLElement).style.viewTransitionName = 'hero-cover';
  void vt.finished.finally(() => { (el as HTMLElement).style.viewTransitionName = ''; });
};
addEventListener('pageswap', ((e: PageSwap) => {
  if (!e.viewTransition || still) return;
  const to = e.activation?.entry?.url ? new URL(e.activation.entry.url).pathname : '';
  if (ARTICLE.test(to) && lastCover) nameIt(lastCover, e.viewTransition);
  else if (ARTICLE.test(location.pathname) && !ARTICLE.test(to)) nameIt(document.querySelector('.article__cover'), e.viewTransition);
}) as EventListener);
