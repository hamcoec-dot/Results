// The phone layout check (mobile-layout.spec.js), shared with other specs. Runs in the page
// (page.evaluate), so it uses nothing from outside itself.
/** Problems with the text on screen: overlaps within a group, text past the right edge, page scroll. */
function layoutProblems() {
  const GROUP = '.candidate-row, tr, .filter-tabs, .stat-card, [class*="stat-box"], .precinct-map-info, .map-legend, .contest-header, header, nav, .slide-card, article, section';
  const vw = document.documentElement.clientWidth;
  const problems = [];
  if (document.documentElement.scrollWidth > window.innerWidth + 1) problems.push(`page scrolls sideways (${document.documentElement.scrollWidth}px > ${window.innerWidth}px)`);
  const memo = new Map();
  const hidden = (el) => {
    if (memo.has(el)) return memo.get(el);
    const v = hiddenUncached(el);
    memo.set(el, v);
    return v;
  };
  const hiddenUncached = (el) => {
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (s.display === 'none' || s.visibility === 'hidden' || e.hasAttribute('hidden') || e.getAttribute('aria-hidden') === 'true') return true;
      if (s.position === 'absolute' && (s.clip === 'rect(0px, 0px, 0px, 0px)' || s.clipPath === 'inset(50%)')) return true; // .sr-only
      if (s.position === 'fixed' || s.position === 'sticky') return true; // floating buttons, sticky columns
    }
    return false;
  };
  const scroller = (el) => {
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      const o = getComputedStyle(e).overflowX;
      if ((o === 'auto' || o === 'scroll') && e.scrollWidth > e.clientWidth) return e;
    }
    return null;
  };
  const items = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.nodeValue.trim() || hidden(n.parentElement)) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 1 && r.height > 1);
    if (!rects.length) continue;
    const el = n.parentElement;
    const label = n.nodeValue.trim().slice(0, 40);
    const inScroller = scroller(el);
    if (!inScroller) for (const r of rects) if (r.right > vw + 1) { problems.push(`"${label}" runs off the right edge (${Math.round(r.right)}px > ${vw}px)`); break; }
    items.push({ el, group: el.closest(GROUP), rects, label });
  }
  const byGroup = new Map();
  for (const it of items) { if (!it.group) continue; if (!byGroup.has(it.group)) byGroup.set(it.group, []); byGroup.get(it.group).push(it); }
  for (const list of byGroup.values()) {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      for (const r of a.rects) for (const s of b.rects) {
        const w = Math.min(r.right, s.right) - Math.max(r.left, s.left);
        const h = Math.min(r.bottom, s.bottom) - Math.max(r.top, s.top);
        if (w > 3 && h > 3) { problems.push(`"${a.label}" overlaps "${b.label}"`); i = j = list.length; break; }
      }
    }
    if (problems.length > 30) break;
  }
  return problems;
}

module.exports = { layoutProblems };
