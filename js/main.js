// Hotel Pandia's v2: landing page behaviour. Small on purpose. The two heavy things, the hero
// video and the 3D mascot, are both fetched only after the page itself has finished loading.

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const n = navigator;
const saveData = !!n.connection?.saveData;
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const afterLoad = (fn) => (document.readyState === "complete" ? fn() : addEventListener("load", fn, { once: true }));

// ---------- click tracking, ready for ads later
// Every important link carries data-track. Events queue in window.dataLayer, which Google Tag
// Manager / the Google tag read as-is; a Meta Pixel call can be added in this one place.
window.dataLayer = window.dataLayer || [];
document.addEventListener("click", (e) => {
  const a = e.target.closest?.("[data-track]");
  if (a) window.dataLayer.push({ event: "cta_click", cta: a.dataset.track, branch: a.dataset.branch || null });
});

// ---------- nav turns solid after the hero; phone action bar appears with it
const nav = $("[data-nav]");
const thumb = $("[data-thumb]");
let ticking = false;
const onScroll = () => {
  ticking = false;
  const past = scrollY > innerHeight - 90;
  nav.classList.toggle("is-solid", past);
  thumb.classList.toggle("is-up", past);
};
addEventListener("scroll", () => !ticking && ((ticking = true), requestAnimationFrame(onScroll)), { passive: true });
onScroll();

// ---------- sections lift in once
const reveal = new IntersectionObserver(
  (entries) => entries.forEach((e) => e.isIntersecting && (e.target.classList.add("is-in"), reveal.unobserve(e.target))),
  { rootMargin: "0px 0px -8% 0px" }
);
$$("[data-reveal]").forEach((el) => reveal.observe(el));

// ---------- "Open now · till 11 PM", always in Chennai time
const fmt = (min) => {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${h % 12 || 12}${m ? ":" + String(m).padStart(2, "0") : ""} ${h < 12 ? "AM" : "PM"}`;
};
const d = new Date();
const now = (d.getUTCHours() * 60 + d.getUTCMinutes() + 330) % 1440; // IST = UTC+5:30
$$(".status").forEach((el) => {
  const open = Number(el.dataset.open);
  const close = Number(el.dataset.close);
  const isOpen = now >= open && now < close;
  const soon = isOpen && close - now <= 45;
  el.textContent = isOpen ? (soon ? `Closing soon · ${fmt(close)}` : `Open now · till ${fmt(close)}`) : `Closed · opens ${fmt(open)}`;
  el.dataset.state = isOpen ? (soon ? "soon" : "open") : "closed";
  el.hidden = false;
});
$("[data-year]").textContent = String(d.getFullYear());

// ---------- hero video
// The still frame is what paints first. The video (wide = three clips side by side, tall = one
// upright clip for phones) is fetched after load and fades in once it can play. It pauses when
// the hero is off screen. With Data Saver or reduced motion, the still frame simply stays.
const video = $("[data-hero-video]");
if (video && !saveData && !reduce) {
  afterLoad(() => {
    video.src = matchMedia("(max-width: 760px)").matches ? video.dataset.tall : video.dataset.wide;
    video.addEventListener("playing", () => video.classList.add("is-playing"), { once: true });
    video.play().catch(() => {});
    new IntersectionObserver(([e]) => (e.isIntersecting ? video.play().catch(() => {}) : video.pause())).observe(video);
  });
}

// ---------- 3D mascot (section two only)
// His still picture is in the page. When the section comes near, a Web Worker loads the 3D engine
// and the model and draws on an OffscreenCanvas, so none of that work can make the page stutter.
// This file only tells the worker the box size and where the pointer is.
// The picture stays when: Data Saver is on, the phone is very weak, a weak phone is inside the
// Instagram / Facebook in-app browser, or the browser can't draw from a worker.
function startMascot(box) {
  const canvas = $("[data-canvas]", box);
  const poster = $("[data-poster]", box);
  const worker = new Worker(new URL("./mascot-worker.js", import.meta.url));
  const off = canvas.transferControlToOffscreen();
  const abs = (u) => new URL(u, document.baseURI).href;
  const view = () => ({ w: canvas.clientWidth, h: canvas.clientHeight, dpr: devicePixelRatio || 1, mobile: false, solo: true, progress: 0 });

  worker.postMessage(
    { type: "init", canvas: off, model: abs("models/pandia-mascot.glb"), env: abs("env/room-128.webp"), reduce, lowEnd: cores <= 4 || mem <= 4, intro: false, view: view() },
    [off]
  );
  worker.onmessage = ({ data }) => {
    if (data.type === "ready") {
      canvas.classList.add("is-ready");
      poster.classList.add("is-hidden");
      performance.mark("mascot:ready");
    } else if (data.type === "error") {
      console.warn("[mascot] staying on the picture:", data.message);
      worker.terminate();
    }
  };
  worker.onerror = () => worker.terminate();

  // pointer position relative to his box (-1..1, y up); at most one message per frame
  let rect = canvas.getBoundingClientRect();
  const remeasure = () => (rect = canvas.getBoundingClientRect());
  addEventListener("scroll", remeasure, { passive: true });
  addEventListener("resize", () => (remeasure(), worker.postMessage({ type: "size", view: view() })), { passive: true });
  const ndc = (e) => ({ x: ((e.clientX - rect.left) / rect.width) * 2 - 1, y: -(((e.clientY - rect.top) / rect.height) * 2 - 1) });
  let last = null;
  addEventListener(
    "pointermove",
    (e) => {
      if (!last) requestAnimationFrame(() => (worker.postMessage({ type: "pointer", ...ndc(last) }), (last = null)));
      last = e;
    },
    { passive: true }
  );
  document.addEventListener("pointerleave", () => worker.postMessage({ type: "pointer", x: null, y: null }));
  // tap his head and he nods back
  canvas.addEventListener("pointerdown", (e) => (remeasure(), worker.postMessage({ type: "tap", ...ndc(e) })));
  // stop drawing while he is off screen or the tab is hidden
  let inView = true;
  const tell = () => worker.postMessage({ type: "visible", visible: inView && !document.hidden });
  new IntersectionObserver(([e]) => ((inView = e.isIntersecting), tell())).observe(box);
  document.addEventListener("visibilitychange", tell);
}

const cores = n.hardwareConcurrency || 8;
const mem = n.deviceMemory || 8;
const inApp = /FBAN|FBAV|Instagram/i.test(n.userAgent);
const oldSafari = /^((?!chrome|android).)*safari/i.test(n.userAgent) && Number((n.userAgent.match(/Version\/(\d+)/) || [])[1] || 99) < 17;
const canWorker = "transferControlToOffscreen" in HTMLCanvasElement.prototype && "OffscreenCanvas" in window && !oldSafari;
const skip3d = !canWorker || saveData || cores <= 2 || mem <= 2 || (inApp && (cores <= 4 || mem <= 4));

const box = $("[data-mascot]");
if (box && !skip3d) {
  afterLoad(() => {
    const near = new IntersectionObserver(
      ([e]) => e.isIntersecting && (near.disconnect(), startMascot(box)),
      { rootMargin: "600px 0px" }
    );
    near.observe(box);
  });
}
