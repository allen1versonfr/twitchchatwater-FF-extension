/* Auto-claim: clicks Twitch's own claim buttons for you — the channel-points bonus chest, Moments,
 * and Drops (in chat, and on the Drops inventory page). Nothing is claimed that you couldn't click yourself. */
(() => {
  "use strict";
  const C = globalThis.TCWChat;
  if (!C || C.autoclaim || !C.isTop) return;
  const S = () => C.settings;

  const BONUS_SEL = "button[aria-label='Claim Bonus' i], .community-points-summary .claimable-bonus__icon, [data-test-selector='community-points-summary'] .claimable-bonus__icon";
  const CHAT_AREA_SEL = ".stream-chat, .chat-shell, .chat-room, [data-test-selector='chat-room-component-layout'], .channel-root__right-column";
  const clicked = new WeakSet();
  let lastClaim = 0;

  const label = (b) => ((b.getAttribute("aria-label") || "") + " " + (b.textContent || "")).replace(/\s+/g, " ").trim();
  const usable = (b) => b && !b.disabled && b.getAttribute("aria-disabled") !== "true" && b.offsetParent !== null && !clicked.has(b);

  function press(b, kind) {
    clicked.add(b);
    b.click();
    lastClaim = Date.now();
    C.debug("auto-claimed", kind);
    browser.runtime.sendMessage({ type: "claim", kind, channel: C.currentChannel() }).catch(() => {});
  }

  function claimBonus() {
    for (const node of document.querySelectorAll(BONUS_SEL)) {
      const b = node.closest("button") || node;
      if (usable(b)) { press(b, "points"); return; }
    }
  }

  // Moments and Drops show up as claim callouts above or inside chat.
  function claimCallouts() {
    for (const area of document.querySelectorAll(CHAT_AREA_SEL)) {
      for (const b of area.querySelectorAll("button")) {
        if (!usable(b) || b.closest("[id^='tcw-'], .community-points-summary") || b.closest(C.LINE_SEL)) continue;
        const t = label(b).toLowerCase();
        if (S().autoMoments && /claim (this )?moment|^claim moment/.test(t)) press(b, "moments");
        else if (S().autoDrops && /^claim( now| drop| reward)?$|claim (your )?drop/.test(t)) press(b, "drops");
      }
    }
  }

  // twitch.tv/drops/inventory: every enabled "Claim" button, one at a time.
  let invDone = false;
  let invStart = 0;
  function claimInventory() {
    if (!/^\/drops\/inventory/i.test(location.pathname)) return;
    if (!invStart) invStart = Date.now();
    const bg = /[?&]tcw-autoclaim=1/.test(location.search);
    let found = false;
    if (S().autoDrops) {
      for (const b of document.querySelectorAll("main button, [role='main'] button, button")) {
        if (!usable(b)) continue;
        if (/^claim( now)?$/i.test(label(b))) {
          found = true;
          if (Date.now() - lastClaim > 1500) press(b, "drops");
          break;
        }
      }
    }
    // the background check tab closes itself once nothing is left to claim (or after 40 s)
    if (bg && !invDone && !found && Date.now() - lastClaim > 4000 && (Date.now() - invStart > 12000 || document.readyState === "complete" && Date.now() - invStart > 8000)) {
      invDone = true;
      browser.runtime.sendMessage({ type: "drops:done" }).catch(() => {});
    }
    if (bg && !invDone && Date.now() - invStart > 40000) {
      invDone = true;
      browser.runtime.sendMessage({ type: "drops:done" }).catch(() => {});
    }
  }

  function tick() {
    if (!S().enabled) return;
    try {
      if (S().autoBonus) claimBonus();
      if (S().autoMoments || S().autoDrops) claimCallouts();
      claimInventory();
    } catch (e) {
      C.debug("auto-claim failed", e);
    }
  }

  setInterval(tick, 2500);
  C.autoclaim = { tick };
})();
