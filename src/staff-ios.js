// iPhone-style chrome for the staff app.
//  - phones / iPad portrait: a tab bar with at most 4 screens for this person's role, plus "More"
//    (the other screens, branch, sound, check-in and sign out, in a bottom sheet)
//  - a slim top bar whose title fades in once the big title scrolls away
//  - every dialog becomes a bottom sheet on phones; drag its header down to close it
//  - installable: service worker (sw.js) + "Add to Home Screen" help for Safari
// Wide screens keep the sidebar, so the same DOM works on a counter PC and on a waiter's phone.

const PRIMARY = {
  admin: ["today", "orders", "tables", "reports"],
  manager: ["today", "orders", "tables", "guests"],
  cashier: ["tables", "orders", "today", "bills"],
  kitchen: ["orders", "menu", "stock"],
  waiter: ["tables", "orders"],
};
const DOTS = '<circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/>';
const CHEVRON = '<svg class="irow__go" viewBox="0 0 8 14" aria-hidden="true"><path d="M1 1l6 6-6 6"/></svg>';

export function initIOS({ $, $$ }) {
  const phone = matchMedia("(max-width: 900px)");
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const installed = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const app = $("[data-app]");
  const side = $(".side");
  const nav = $(".tabs");
  const meBox = $(".side__me");
  const themeMeta = $('meta[name="theme-color"]');

  // ---- top bar
  app.insertAdjacentHTML(
    "afterbegin",
    `<header class="topbar" data-topbar><div class="topbar__t"><b data-topbar-title></b><small data-topbar-sub></small></div>
      <button type="button" class="topbar__bell" data-bell aria-label="Sound for new orders"><svg viewBox="0 0 24 24"><path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/></svg></button></header>`
  );
  const bar = $("[data-topbar]");
  const soundChip = $("[data-sound]");
  const bell = $("[data-bell]");
  bell.addEventListener("click", () => soundChip.click());
  const syncBell = () => bell.classList.toggle("is-on", soundChip.classList.contains("is-on"));
  new MutationObserver(syncBell).observe(soundChip, { attributes: true, attributeFilter: ["class"] });

  // ---- "More" tab and its sheet
  nav.insertAdjacentHTML("beforeend", `<a href="#more" class="tab--more" data-more><svg viewBox="0 0 24 24">${DOTS}</svg><span>More</span><b class="badge badge--dot" data-more-dot hidden></b></a>`);
  const moreTab = $("[data-more]");
  document.body.insertAdjacentHTML(
    "beforeend",
    `<dialog class="panel sheet-more" data-more-sheet aria-labelledby="more-title">
      <header class="panel__head"><div><h2 id="more-title">More</h2></div><button type="button" class="x" data-x aria-label="Close">×</button></header>
      <div class="panel__body">
        <nav class="ilist" data-more-list aria-label="More screens"></nav>
        <div class="ilist ilist--me" data-more-me></div>
        <div class="ilist" data-install-box hidden><button type="button" class="irow" data-install><span class="irow__ico irow__ico--tint"><svg viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 21h14"/></svg></span><span class="irow__label">Install on this phone</span>${CHEVRON}</button></div>
      </div>
    </dialog>`
  );
  const sheet = $("[data-more-sheet]");
  const list = $("[data-more-list]");
  moreTab.addEventListener("click", (e) => {
    e.preventDefault();
    sheet.showModal();
  });
  sheet.addEventListener("click", (e) => {
    if (e.target === sheet || e.target.closest("[data-x]") || e.target.closest("a[href^='#']")) sheet.close();
  });

  // the branch / sound / sign-out box lives in the sidebar on wide screens, in the More sheet on phones
  const place = () => {
    if (phone.matches) $("[data-more-me]").append(meBox);
    else side.append(meBox);
  };
  phone.addEventListener("change", place);
  place();

  // badges on overflow screens show as a dot on "More"
  const syncDot = () => {
    const any = $$("a.is-overflow .badge:not([hidden])", nav).length > 0;
    $("[data-more-dot]").hidden = !any;
    for (const b of $$("a.is-overflow .badge", nav)) {
      const row = $(`[data-row="${b.closest("a").dataset.tab}"] .irow__badge`, list);
      if (row) {
        row.hidden = b.hidden;
        row.textContent = b.textContent;
      }
    }
  };
  new MutationObserver(syncDot).observe(nav, { subtree: true, attributes: true, childList: true, characterData: true, attributeFilter: ["hidden"] });

  let primary = [];
  function setup(role) {
    const shown = $$("a[data-tab]", nav).filter((a) => !a.hidden);
    const keys = shown.map((a) => a.dataset.tab);
    primary = (PRIMARY[role] || []).filter((k) => keys.includes(k));
    for (const k of keys) if (primary.length < 4 && !primary.includes(k)) primary.push(k);
    for (const a of shown) {
      const i = primary.indexOf(a.dataset.tab);
      a.classList.toggle("is-overflow", i < 0);
      a.style.order = i < 0 ? 50 : i;
    }
    const rest = shown.filter((a) => a.classList.contains("is-overflow"));
    list.hidden = !rest.length;
    list.innerHTML = rest
      .map(
        (a) =>
          `<a class="irow" href="#${a.dataset.tab}" data-row="${a.dataset.tab}"><span class="irow__ico">${a.querySelector("svg").outerHTML}</span><span class="irow__label">${a.querySelector("span").textContent}</span><b class="irow__badge" hidden></b>${CHEVRON}</a>`
      )
      .join("");
    syncDot();
    syncBell();
    install.setup();
  }

  // ---- title that appears in the top bar once the big one scrolls away
  let watch;
  const io = new IntersectionObserver(([e]) => bar.classList.toggle("is-solid", !e.isIntersecting), { rootMargin: "-56px 0px 0px 0px" });
  function route(screen) {
    const tab = $(`a[data-tab="${screen}"]`, nav);
    $("[data-topbar-title]").textContent = tab?.querySelector("span")?.textContent || "";
    const sel = $("[data-branch]");
    $("[data-topbar-sub]").textContent = !sel.hidden ? sel.selectedOptions[0]?.textContent || "" : $("[data-branch-fixed]").textContent;
    moreTab.toggleAttribute("aria-current", !!tab?.classList.contains("is-overflow"));
    for (const r of $$(".irow[data-row]", list)) r.toggleAttribute("aria-current", r.dataset.row === screen);
    document.body.dataset.screen = screen;
    themeMeta?.setAttribute("content", screen === "orders" ? "#1d0a0c" : "#f6f2ec");
    if (watch) io.unobserve(watch);
    watch = $(`[data-screen="${screen}"] .bar h1`);
    if (watch) io.observe(watch);
    if (document.body.dataset.was !== screen) scrollTo(0, 0);
    document.body.dataset.was = screen;
  }
  $("[data-branch]").addEventListener("change", (e) => ($("[data-topbar-sub]").textContent = e.target.selectedOptions[0]?.textContent || ""));

  // ---- drag a sheet's header down to close it (phones)
  let drag = null;
  document.addEventListener("pointerdown", (e) => {
    if (!phone.matches || e.button) return;
    const head = e.target.closest("dialog[open].panel .panel__head");
    if (!head || e.target.closest("button, a, input, select, textarea")) return;
    drag = { d: head.closest("dialog"), y: e.clientY, dy: 0, id: e.pointerId };
    head.setPointerCapture?.(e.pointerId);
    drag.d.style.transition = "none";
  });
  document.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag.dy = Math.max(0, e.clientY - drag.y);
    drag.d.style.transform = `translateY(${drag.dy}px)`;
  });
  const endDrag = () => {
    if (!drag) return;
    const { d, dy } = drag;
    drag = null;
    d.style.transition = "transform .28s cubic-bezier(.32,.72,0,1)";
    if (dy > 110) {
      d.style.transform = "translateY(100%)";
      setTimeout(() => {
        d.close();
        d.style.transform = d.style.transition = "";
      }, 230);
    } else {
      d.style.transform = "";
      setTimeout(() => (d.style.transition = ""), 300);
    }
  };
  document.addEventListener("pointerup", endDrag);
  document.addEventListener("pointercancel", endDrag);

  // ---- install
  const install = (() => {
    let prompt = null;
    addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      prompt = e;
      $("[data-install-box]").hidden = false;
    });
    $("[data-install]").addEventListener("click", async () => {
      if (prompt) {
        prompt.prompt();
        await prompt.userChoice.catch(() => {});
        prompt = null;
        $("[data-install-box]").hidden = true;
        return;
      }
      sheet.close();
      showIosHelp();
    });
    function showIosHelp() {
      const d = document.createElement("dialog");
      d.className = "panel";
      d.innerHTML = `<header class="panel__head"><div><h2>Install the app</h2><p class="soft">Opens full screen, straight from the home screen.</p></div><button type="button" class="x" data-x aria-label="Close">×</button></header>
        <div class="panel__body"><ol class="steps">
          <li><span class="steps__n">1</span>Open this page in <b>Safari</b>.</li>
          <li><span class="steps__n">2</span>Tap the <b>Share</b> button <svg class="steps__share" viewBox="0 0 24 24" aria-label="Share"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M6 11H5v10h14V11h-1"/></svg> at the bottom of the screen.</li>
          <li><span class="steps__n">3</span>Choose <b>Add to Home Screen</b>, then <b>Add</b>.</li>
        </ol><button type="button" class="btn btn--dark" data-x>Got it</button></div>`;
      document.body.append(d);
      d.addEventListener("close", () => d.remove());
      d.addEventListener("click", (e) => (e.target === d || e.target.closest("[data-x]")) && d.close());
      d.showModal();
    }
    return {
      setup() {
        if (installed) return;
        if (ios) $("[data-install-box]").hidden = false;
        let seen = null;
        try {
          seen = localStorage.getItem("pd-install-hint");
        } catch {}
        if (!ios || seen || !phone.matches) return;
        app.insertAdjacentHTML(
          "beforeend",
          `<div class="installhint" data-hint role="status"><img src="icons/apple-touch-icon.png" alt="" width="40" height="40"><p><b>Put Pandia's on your home screen</b><span>Opens like an app, full screen.</span></p><button type="button" class="btn btn--sm btn--dark" data-hint-how>How</button><button type="button" class="installhint__x" data-hint-x aria-label="Not now">×</button></div>`
        );
        const done = () => {
          $("[data-hint]")?.remove();
          try {
            localStorage.setItem("pd-install-hint", "1");
          } catch {}
        };
        $("[data-hint-how]").addEventListener("click", () => {
          done();
          showIosHelp();
        });
        $("[data-hint-x]").addEventListener("click", done);
      },
    };
  })();

  // ---- offline shell (network first, so a new version always shows on the next open)
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }
  if (installed) document.documentElement.classList.add("is-installed");

  return { setup, route };
}
