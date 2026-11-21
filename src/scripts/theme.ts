// Theme system: light ("Skyline") and dark ("Graphite").
// Switching uses the View Transitions API: the new theme is revealed by a wavy, diagonal front that starts
// in the top-right corner and flows to the bottom-left. Falls back to a short cross-fade, or to an instant
// swap when the visitor prefers reduced motion.
import { reduced } from './util';

const root = document.documentElement;
type Theme = 'light' | 'dark';
const THEME_COLOR: Record<Theme, string> = { light: '#eef4ff', dark: '#0b0d11' };

export const currentTheme = (): Theme => (root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');

export function syncThemeUi() {
  const t = currentTheme();
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[t]);
  document.querySelectorAll<HTMLElement>('[data-theme-toggle]').forEach((b) =>
    b.setAttribute('aria-label', t === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'));
  window.dispatchEvent(new CustomEvent('themechange', { detail: t }));
}

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/**
 * Build clip-path keyframes for a wave front travelling from the top-right corner to the bottom-left.
 * Coordinates: u runs along the diagonal (0 at top-right, L at bottom-left), v runs across it.
 * Every keyframe has the same number of points, so the browser can interpolate between them.
 */
export function waveKeyframes(w: number, h: number, frames = 46): string[] {
  const L = Math.hypot(w, h);
  const dx = -w / L, dy = h / L; // unit vector top-right -> bottom-left
  const nx = h / L, ny = w / L;  // perpendicular
  const amp = Math.min(150, Math.max(56, L * 0.085));
  const span = (w * h) / L + amp * 2 + 60;
  const lam = Math.max(300, L * 0.34);
  const n = Math.ceil((span * 2) / 34) + 1;
  const P = (u: number, v: number) => `${(w + u * dx + v * nx).toFixed(1)}px ${(u * dy + v * ny).toFixed(1)}px`;
  const out: string[] = [];
  for (let f = 0; f <= frames; f++) {
    const t = f / frames;
    const base = -amp + (L + 2 * amp) * easeInOut(t);
    const ph = t * Math.PI * 2.3;
    const pts: string[] = [];
    for (let i = 0; i < n; i++) {
      const v = -span + (2 * span * i) / (n - 1);
      const wv = 0.62 * Math.sin((v / lam) * Math.PI * 2 + ph) + 0.38 * Math.sin((v / (lam * 0.53)) * Math.PI * 2 - ph * 1.4 + 1.2);
      pts.push(P(base + amp * wv, v));
    }
    pts.push(P(-L, span), P(-L, -span));
    out.push(`polygon(${pts.join(', ')})`);
  }
  return out;
}

type VT = { ready: Promise<void>; finished: Promise<void> };
export function setTheme(next: Theme) {
  if (next === currentTheme()) return;
  const apply = () => {
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('theme', next); } catch { /* storage unavailable: the theme still applies for this visit */ }
    syncThemeUi();
  };
  const start = (document as Document & { startViewTransition?: (cb: () => void) => VT }).startViewTransition;
  if (reduced()) { apply(); return; }
  if (!start) {
    root.classList.add('theme-fade');
    apply();
    window.setTimeout(() => root.classList.remove('theme-fade'), 520);
    return;
  }
  root.classList.add('theme-vt');
  try {
    const vt = start.call(document, apply);
    vt.ready
      .then(() => root.animate(
        { clipPath: waveKeyframes(innerWidth, innerHeight) },
        { duration: 1300, easing: 'linear', pseudoElement: '::view-transition-new(root)' },
      ))
      .catch(() => {});
    void vt.finished.catch(() => {}).finally(() => root.classList.remove('theme-vt'));
  } catch {
    root.classList.remove('theme-vt');
    apply();
  }
}

export const toggleTheme = () => setTheme(currentTheme() === 'dark' ? 'light' : 'dark');

syncThemeUi();
document.querySelectorAll<HTMLElement>('[data-theme-toggle]').forEach((b) => b.addEventListener('click', toggleTheme));
// Other scripts (the command palette) can ask for a toggle without importing this module.
window.addEventListener('toggle-theme', toggleTheme);
