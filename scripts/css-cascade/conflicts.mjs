/**
 * Cascade conflicts — every declaration whose winner is decided by SOURCE ORDER
 * between two stylesheets (specs/features/css-cascade-layers.md
 * REQ-no-cross-module-tie-is-left-to-load-order).
 *
 *   node scripts/css-cascade/conflicts.mjs                       # audit; exit 1 on any tie
 *   node scripts/css-cascade/conflicts.mjs --dump d.json         # …and keep what it saw
 *   node scripts/css-cascade/conflicts.mjs --from d.json --tiers t.json   # offline dry run
 *
 * Boots `vite dev` — each module is its own <style data-vite-dev-id>, so every
 * rule traces back to its file — and asks Chromium over CDP for the rules that
 * match every element (and its ::before/::after) in each state × viewport of
 * lib.mjs. Only CONTESTS are kept: a property that two or more stylesheets
 * declare on one element with different values. The audit is slow (minutes per
 * state), so `--dump` saves the contests and `--from` re-judges them offline.
 *
 * A TIE is a contest whose winner and a loser come from different stylesheets
 * and are equal in importance, cascade layer and specificity — so whichever
 * stylesheet loaded last wins. That is exactly what moving an import changes,
 * and exactly what must be zero before import order can be free.
 *
 * `--tiers <json>` maps stylesheets (repo-relative path, or bare file name) to
 * layers named in src/styles/layers.css, and reports every contest whose
 * winning VALUE would change under that map: the dry run for assigning layers.
 *
 * Options: --filter <substr>, --port <n> (default 5179), --jobs <n> (default 3).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  launch, openState, parseArgs, plan, pool, startServer, stopServer,
} from './lib.mjs';
import { readLayerOrder } from '../lib/css-layer-order.mjs';

const args = parseArgs(process.argv.slice(2));

/** The declared layer order; empty on a tree that has no layers yet (the dry run's starting point). */
function declaredOrder() {
  try {
    return readLayerOrder().names;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- collection

/** The contests on every element of one state, keyed by their signature. */
async function auditState(browser, url, item) {
  const { page, close } = await openState(browser, url, item.state, item.vp);
  const cdp = await page.context().newCDPSession(page);
  const headers = new Map();
  cdp.on('CSS.styleSheetAdded', ({ header }) => { headers.set(header.styleSheetId, header); });
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
  const { root } = await cdp.send('DOM.getDocument', { depth: -1 });

  const names = new Map();
  const sheetName = async (id) => {
    if (names.has(id)) return names.get(id);
    const h = headers.get(id);
    let name = h?.sourceURL ? new URL(h.sourceURL).pathname.replace(/^\//, '') : `sheet:${id}`;
    if (h?.ownerNode) {
      try {
        const { node } = await cdp.send('DOM.describeNode', { backendNodeId: h.ownerNode });
        const attrs = node.attributes ?? [];
        const i = attrs.indexOf('data-vite-dev-id');
        if (i >= 0) name = attrs[i + 1].replace(/\\/g, '/').replace(/^.*?\/(src\/)/, '$1');
      } catch { /* keep the URL */ }
    }
    names.set(id, name);
    return name;
  };

  const contests = new Map();
  const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: 'body, body *' });
  // CDP pipelines, so a batch at once is far faster than one by one; each batch
  // is reduced and dropped before the next, since a whole page of matched-rule
  // payloads does not fit in the heap.
  for (let i = 0; i < nodeIds.length; i += 64) {
    const ids = nodeIds.slice(i, i + 64);
    const batch = await Promise.all(ids.map((nodeId) => cdp.send('CSS.getMatchedStylesForNode', { nodeId }).catch(() => null)));
    for (const [j, res] of batch.entries()) {
      if (res) await collect(ids[j], res);
    }
  }
  await close();
  return contests;

  async function collect(nodeId, res) {
    const groups = [{ pseudo: '', matches: res.matchedCSSRules ?? [] }];
    for (const p of res.pseudoElements ?? []) {
      if (p.pseudoType === 'before' || p.pseudoType === 'after') groups.push({ pseudo: `::${p.pseudoType}`, matches: p.matches });
    }
    for (const { pseudo, matches } of groups) {
      const byProp = new Map();
      // CDP returns matched rules in cascade order, so for equal specificity
      // the position in this list IS the source order.
      for (const [pos, m] of matches.entries()) {
        const rule = m.rule;
        if (rule.origin !== 'regular' || !rule.styleSheetId) continue;
        const sels = rule.selectorList.selectors;
        let spec = -1;
        let selector = '';
        for (const k of m.matchingSelectors) {
          const s = sels[k].specificity;
          if (!s) throw new Error('this Chromium reports no selector specificity over CDP');
          const v = s.a * 1e6 + s.b * 1e3 + s.c;
          if (v > spec) { spec = v; selector = sels[k].text; }
        }
        const sheet = await sheetName(rule.styleSheetId);
        const layer = rule.layers?.[0]?.text ?? null;
        // CDP lists a shorthand AND the longhands it expands to; judge the
        // longhands only, or every padding contest is reported five times.
        const declared = rule.style.cssProperties.map((p) => p.name);
        const isShorthand = (name) => declared.some((other) => other.startsWith(`${name}-`));
        for (const prop of rule.style.cssProperties) {
          if (prop.disabled || prop.parsedOk === false || prop.value === undefined) continue;
          if (!prop.name.startsWith('--') && isShorthand(prop.name)) continue;
          const list = byProp.get(prop.name) ?? [];
          list.push({
            sheet, selector, spec, pos, layer,
            important: Boolean(prop.important), value: prop.value.replace(/\s*!important\s*$/, ''),
          });
          byProp.set(prop.name, list);
        }
      }
      for (const [prop, decls] of byProp) {
        if (new Set(decls.map((d) => d.sheet)).size < 2) continue;
        if (new Set(decls.map((d) => d.value)).size < 2) continue;
        const sig = JSON.stringify([prop + pseudo, decls.map((d) => [d.sheet, d.selector, d.spec, d.pos, d.layer, d.important, d.value])]);
        const c = contests.get(sig);
        if (c) { c.count++; continue; }
        contests.set(sig, { prop: prop + pseudo, decls, count: 1, where: await describe(cdp, nodeId) });
      }
    }
  }
}

/** A short, readable handle on a node: its testid, else tag + first class. */
async function describe(cdp, nodeId) {
  const { node } = await cdp.send('DOM.describeNode', { nodeId });
  const attrs = node.attributes ?? [];
  const get = (n) => { const i = attrs.indexOf(n); return i >= 0 ? attrs[i + 1] : undefined; };
  const testid = get('data-testid');
  return testid ? `[${testid}]` : `${node.localName}${get('class') ? '.' + get('class').split(/\s+/)[0] : ''}`;
}

// ------------------------------------------------------------------ judgement

const UNLAYERED = 1000;

function ranker(layerOrder) {
  return (name) => {
    if (name == null) return UNLAYERED; // unlayered beats every layer (normal declarations)
    const i = layerOrder.indexOf(name);
    if (i < 0) throw new Error(`layer "${name}" is not declared in src/styles/layers.css`);
    return i;
  };
}

/**
 * Cascade key, higher wins (CSS Cascade 5): importance first; important
 * declarations run the layer order BACKWARDS, with unlayered the weakest; then
 * specificity; then source order.
 */
function key(d, rank) {
  return d.important ? [1, -rank, d.spec, d.pos] : [0, rank, d.spec, d.pos];
}
const cmp = (a, b) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
};
const winnerBy = (decls, k) => decls.reduce((w, d) => (cmp(k(d), k(w)) >= 0 ? d : w));

/** Ties (and, given tiers, changed winners) across every collected contest. */
function judge(contests, layerOrder, tiers) {
  const rank = ranker(layerOrder);
  const tierOf = (sheet) => tiers?.[sheet] ?? tiers?.[sheet.split('/').pop()];
  const ties = new Map();
  const changes = new Map();
  const bump = (map, k, v) => {
    const e = map.get(k);
    if (e) { e.count += v.count; for (const id of v.ids) e.ids.add(id); } else map.set(k, { ...v, ids: new Set(v.ids) });
  };
  for (const c of contests) {
    const winner = winnerBy(c.decls, (d) => key(d, rank(d.layer)));
    for (const d of c.decls) {
      if (d === winner || d.sheet === winner.sheet || d.value === winner.value) continue;
      if (d.important === winner.important && d.layer === winner.layer && d.spec === winner.spec) {
        bump(ties, [c.prop, winner.sheet, winner.selector, winner.value, d.sheet, d.selector, d.value].join('|'),
          { prop: c.prop, where: c.where, count: c.count, ids: c.ids, winner, loser: d });
      }
    }
    if (tiers) {
      const sim = winnerBy(c.decls, (d) => {
        const t = tierOf(d.sheet);
        return key(d, rank(t === undefined ? d.layer : t));
      });
      if (sim.value !== winner.value) {
        // Values are part of the key: two rules of one selector (a base and an
        // @media override) are different findings, never one line showing the first.
        bump(changes, [c.prop, winner.sheet, winner.selector, winner.value, sim.sheet, sim.selector, sim.value].join('|'),
          { prop: c.prop, where: c.where, count: c.count, ids: c.ids, before: winner, after: sim });
      }
    }
  }
  const sorted = (m, a) => [...m.values()].sort((x, y) => x[a].sheet.localeCompare(y[a].sheet) || x.prop.localeCompare(y.prop));
  return { ties: sorted(ties, 'winner'), changes: sorted(changes, 'before') };
}

// ----------------------------------------------------------------------- main

const layerOrder = declaredOrder();
const tiers = args.tiers ? JSON.parse(readFileSync(args.tiers, 'utf-8')) : null;
let contests;
if (args.from) {
  contests = JSON.parse(readFileSync(args.from, 'utf-8')).contests;
} else {
  const items = plan(args.filter);
  const { url, child } = await startServer('dev', Number(args.port ?? 5179));
  const browser = await launch('chromium');
  const merged = new Map();
  try {
    console.error(`auditing ${items.length} state×viewport pairs (layer order: ${layerOrder.join(', ') || 'none declared'})`);
    await pool(items, Number(args.jobs ?? 3), async (item) => {
      const t0 = Date.now();
      const found = await auditState(browser, url, item);
      for (const [sig, c] of found) {
        const m = merged.get(sig);
        if (m) { m.count += c.count; m.ids.push(item.id); } else merged.set(sig, { ...c, ids: [item.id] });
      }
      console.error(`  ${item.id}: ${found.size} contest(s) (${Date.now() - t0} ms)`);
    });
  } finally {
    await browser.close();
    stopServer(child);
  }
  contests = [...merged.values()];
  if (args.dump) writeFileSync(args.dump, JSON.stringify({ layerOrder, contests }));
}

const { ties, changes } = judge(contests, layerOrder, tiers);
const fmt = (d) => `${d.sheet} ${d.selector}${d.layer ? ` @layer ${d.layer}` : ''}${d.important ? ' !important' : ''} = ${d.value}`;
const seen = (e) => `${e.count}× in ${[...e.ids].slice(0, 3).join(', ')}${e.ids.size > 3 ? ', …' : ''}`;
console.log(`# Load-order ties: ${ties.length}`);
for (const t of ties) {
  console.log(`\n${t.prop} on ${t.where} (${seen(t)})`);
  console.log(`  wins : ${fmt(t.winner)}`);
  console.log(`  loses: ${fmt(t.loser)}`);
}
if (tiers) {
  console.log(`\n# Winners the tier map would change: ${changes.length}`);
  for (const c of changes) {
    console.log(`\n${c.prop} on ${c.where} (${seen(c)})`);
    console.log(`  now  : ${fmt(c.before)}`);
    console.log(`  would: ${fmt(c.after)}`);
  }
}
process.exit(ties.length || changes.length ? 1 : 0);
