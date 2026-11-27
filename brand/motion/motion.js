// Conveno motion helpers. Dependency-free ESM. Pairs with motion.css (.cv-play / .cv-listening).
const R = "(prefers-reduced-motion: reduce)";

/** True when the user (or <html data-cv-motion="reduce">) asks for reduced motion. */
export const reduced = () =>
  document.documentElement.dataset.cvMotion === "reduce" ||
  (matchMedia(R).matches && document.documentElement.dataset.cvMotion !== "full");

/** Resolves when every animation under el has finished (immediately if reduced or none). */
export const done = (el) =>
  Promise.allSettled((el.getAnimations?.({ subtree: true }) || []).map((a) => a.finished)).then(() => el);

/** Restart an animation: drop the class, force a reflow, add it back. Resolves at the end state. */
export function replay(el, cls = "cv-play") {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  return reduced() ? Promise.resolve(el) : done(el);
}

/** Run steps in order. A step is [el, cls?, gapMs?] (replay el, then wait gapMs after it ends) or a function.
 *  Returns a promise with .cancel(). */
export function sequence(steps) {
  let stop = false;
  const p = (async () => {
    for (const s of steps) {
      if (stop) return;
      if (typeof s === "function") { await s(); continue; }
      const [el, cls, gap = 0] = s;
      await replay(el, cls);
      if (gap && !stop) await new Promise((r) => setTimeout(r, reduced() ? 0 : gap));
    }
  })();
  p.cancel = () => { stop = true; };
  return p;
}

/** Listening idle: start/stop/pause. Does nothing visible under reduced motion. */
export const listen = (el, on = true) => el.classList.toggle("cv-listening", on);
export const pause = (el, on = true) => el.classList.toggle("is-paused", on);

/** Re-run a callback when the reduced-motion preference changes. */
export const onMotionChange = (fn) => matchMedia(R).addEventListener("change", () => fn(reduced()));
