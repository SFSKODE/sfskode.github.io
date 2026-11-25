// Theme system: light ("Skyline") and dark ("Graphite").
// Switching uses the View Transitions API: the new theme is revealed by a straight diagonal front that starts in the
// top-right corner and sweeps to the bottom-left. Falls back to a short cross-fade, or to an instant swap when the
// visitor prefers reduced motion.
import { reduced } from './util';

const root = document.documentElement;
type Theme = 'light' | 'dark';
const THEME_COLOR: Record<Theme, string> = { light: '#e8f3ff', dark: '#000000' };

export const currentTheme = (): Theme => (root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');

export function syncThemeUi() {
  const t = currentTheme();
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[t]);
  document.querySelectorAll<HTMLElement>('[data-theme-toggle]').forEach((b) =>
    b.setAttribute('aria-label', t === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'));
  window.dispatchEvent(new CustomEvent('themechange', { detail: t }));
}


type VT = { ready: Promise<void>; finished: Promise<void> };
let busy = false;
export function setTheme(next: Theme) {
  if (next === currentTheme() || busy) return;
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
  busy = true;
  root.classList.add('theme-vt');
  const end = () => { root.classList.remove('theme-vt'); busy = false; };
  try {
    const vt = start.call(document, apply);
    vt.ready
      .then(() => root.animate(
        // A triangle that grows from the top-right corner. Its far edge is the straight diagonal front; the last frame covers everything.
        { clipPath: ['polygon(100% 0, 100% 0, 100% 0)', 'polygon(100% 0, -125% 0, 100% 250%)'] },
        { duration: innerWidth < 700 ? 850 : 1000, easing: 'cubic-bezier(0.65, 0, 0.35, 1)', pseudoElement: '::view-transition-new(root)' },
      ))
      .catch(() => {});
    void vt.finished.catch(() => {}).finally(end);
  } catch {
    end();
    apply();
  }
}

export const toggleTheme = () => setTheme(currentTheme() === 'dark' ? 'light' : 'dark');

syncThemeUi();
document.querySelectorAll<HTMLElement>('[data-theme-toggle]').forEach((b) => b.addEventListener('click', toggleTheme));
// Other scripts (the command palette) can ask for a toggle without importing this module.
window.addEventListener('toggle-theme', toggleTheme);
