// Theme system: light ("Skyline") and dark ("Graphite").
// Switching: a sheet in the new theme's colour with soft wavy edges sweeps across the screen from right to left.
// While it covers the page the theme is swapped underneath, then it keeps going and uncovers the new theme.
// Only the sheet's transform animates (it runs on the GPU), so it stays smooth on phones and the page never has to
// repaint while you watch. Reduced motion: instant swap.
import { reduced } from './util';

const root = document.documentElement;
type Theme = 'light' | 'dark';
const THEME_COLOR: Record<Theme, string> = { light: '#fbfbfd', dark: '#000000' };

export const currentTheme = (): Theme => (root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');

export function syncThemeUi() {
  const t = currentTheme();
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[t]);
  document.querySelectorAll<HTMLElement>('[data-theme-toggle]').forEach((b) =>
    b.setAttribute('aria-label', t === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'));
  window.dispatchEvent(new CustomEvent('themechange', { detail: t }));
}


/** A wavy edge as one image as tall as the screen: the fill lies to the right of a curve made of two sine waves. */
function waveEdge(w: number, h: number, color: string): string {
  const a = w * 0.34, mid = w * 0.5, pts: string[] = [];
  for (let y = 0; y <= h + 66; y += 11) {
    const t = (y / 440) * Math.PI * 2;   // one full wave every 440px
    pts.push(`${(mid + a * (0.62 * Math.sin(t * 2) + 0.38 * Math.sin(t * 3 + 1.1))).toFixed(1)},${y}`);
  }
  const hh = Math.ceil((h + 66) / 11) * 11;   // a little taller than the screen, so the curve never ends inside it
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${hh}" viewBox="0 0 ${w} ${hh}" preserveAspectRatio="none"><path fill="${color}" d="M${w + 1},0 L${pts.join(' L')} L${w + 1},${hh} Z"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

let busy = false;
export function setTheme(next: Theme) {
  if (next === currentTheme() || busy) return;
  const apply = () => {
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('theme', next); } catch { /* storage unavailable: the theme still applies for this visit */ }
    syncThemeUi();
  };
  if (reduced() || typeof Element.prototype.animate !== 'function') { apply(); return; }

  busy = true;
  const W = innerWidth;
  const w = Math.round(Math.min(190, Math.max(72, W * 0.14)));   // width of each wavy edge
  const S = Math.round(W * 1.7 + w * 2);                          // the whole sheet
  const color = THEME_COLOR[next];
  const tile = waveEdge(w, innerHeight, color);
  const sheet = document.createElement('div');
  sheet.setAttribute('aria-hidden', 'true');
  sheet.className = 'theme-wipe';
  sheet.style.width = `${S}px`;
  // Built with the DOM (not innerHTML): the wave image is a data URL that contains quotes.
  const edge = (flip: boolean) => { const e = document.createElement('i'); e.style.width = `${w}px`; e.style.backgroundImage = tile; e.style.backgroundSize = `${w}px ${Math.ceil((innerHeight + 66) / 11) * 11}px`; if (flip) e.style.transform = 'scaleX(-1)'; return e; };
  const body = document.createElement('b'); body.style.background = color;
  sheet.append(edge(false), body, edge(true));
  document.body.appendChild(sheet);
  root.classList.add('theme-swap');   // no colour transitions while the swap happens behind the sheet

  const anim = sheet.animate(
    [{ transform: `translate3d(${W}px,0,0)` }, { transform: `translate3d(${-S}px,0,0)` }],
    { duration: W < 700 ? 800 : 950, easing: 'cubic-bezier(0.62, 0, 0.38, 1)', fill: 'both' },
  );
  let swapped = false;
  const watch = () => {
    if (swapped) return;
    const p = anim.effect?.getComputedTiming().progress ?? 0;
    if (p >= 0.5) { swapped = true; apply(); return; }   // at the half-way point the sheet covers the whole screen
    requestAnimationFrame(watch);
  };
  requestAnimationFrame(watch);
  const done = () => {
    if (!swapped) apply();
    sheet.remove(); root.classList.remove('theme-swap'); busy = false;
  };
  anim.finished.then(done, done);
}

export const toggleTheme = () => setTheme(currentTheme() === 'dark' ? 'light' : 'dark');

syncThemeUi();
document.querySelectorAll<HTMLElement>('[data-theme-toggle]').forEach((b) => b.addEventListener('click', toggleTheme));
// Other scripts (the command palette) can ask for a toggle without importing this module.
window.addEventListener('toggle-theme', toggleTheme);
