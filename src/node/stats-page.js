// The relay's dashboard, served at GET /stats by a Node relay. One
// self-contained page: it reads GET /api/v1/stats every 2 s and draws the
// numbers and the last hour as small charts. Night slate and bone, with one
// green for what is live.

export const STATS_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="theme-color" content="#111518" />
<title>Relay stats</title>
<style>
  :root {
    --night: #111518; --night-2: #171c20; --line: #262e34; --line-strong: #3a454d;
    --bone: #e4e7e9; --bone-2: #9aa5ad; --bone-3: #6b7780; --sheen: #56b09c; --warn: #d6b234; --stop: #e07a6d;
    color-scheme: dark;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--night); color: var(--bone); font: 14px/1.45 system-ui, -apple-system, 'Segoe UI', sans-serif; -webkit-font-smoothing: antialiased; }
  main { max-width: 1180px; margin: 0 auto; padding: 28px clamp(16px, 4vw, 40px) 56px; }
  header { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 8px 24px; padding-bottom: 20px; border-bottom: 1px solid var(--line); }
  h1 { font-size: 1.6rem; font-weight: 800; letter-spacing: -0.02em; }
  h1 small { font-size: 0.85rem; font-weight: 500; color: var(--bone-3); margin-left: 8px; letter-spacing: 0; }
  .where { color: var(--bone-2); font-family: ui-monospace, Menlo, monospace; font-size: 0.85rem; word-break: break-all; }
  .live { display: inline-flex; align-items: center; gap: 7px; color: var(--bone-3); font-size: 0.85rem; }
  .live i { width: 8px; height: 8px; border-radius: 50%; background: var(--sheen); }
  .live.stale i { background: var(--stop); }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin: 24px 0; }
  .tile { background: var(--night-2); border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px; }
  .tile h2 { font-size: 0.78rem; font-weight: 600; color: var(--bone-3); text-transform: uppercase; letter-spacing: 0.06em; }
  @media (max-width: 420px) { .big { font-size: 1.5rem; } dt { padding-right: 12px; } }
  .big { font-size: 1.9rem; font-weight: 800; letter-spacing: -0.02em; margin-top: 4px; font-variant-numeric: tabular-nums; }
  .big small { font-size: 0.9rem; font-weight: 600; color: var(--bone-2); margin-left: 4px; }
  .sub { color: var(--bone-2); font-size: 0.85rem; font-variant-numeric: tabular-nums; }
  .charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 12px; }
  .chart { background: var(--night-2); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px 10px; }
  .chart-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
  .chart-head h3 { font-size: 0.85rem; font-weight: 600; color: var(--bone-2); }
  .chart-head span { font-size: 0.85rem; font-variant-numeric: tabular-nums; }
  .chart svg { display: block; width: 100%; height: 72px; margin-top: 6px; }
  .key { display: flex; gap: 14px; font-size: 0.75rem; color: var(--bone-3); margin-top: 4px; }
  .key i { display: inline-block; width: 10px; height: 2px; vertical-align: middle; margin-right: 5px; }
  section { margin-top: 28px; }
  section > h2 { font-size: 1rem; font-weight: 700; margin-bottom: 10px; }
  .cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 12px; align-items: start; }
  .state { color: var(--bone-2); margin: -2px 0 12px; word-break: break-word; }
  dl { display: grid; grid-template-columns: 1fr auto; background: var(--night-2); border: 1px solid var(--line); border-radius: 8px; padding: 6px 16px; }
  dt, dd { padding: 8px 0; border-bottom: 1px solid var(--line); }
  dt { color: var(--bone-2); }
  dd { text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }
  dl > :nth-last-child(-n+2) { border-bottom: 0; }
  .relays { list-style: none; background: var(--night-2); border: 1px solid var(--line); border-radius: 8px; padding: 6px 16px; }
  .relays li { padding: 8px 0; border-bottom: 1px solid var(--line); font-family: ui-monospace, Menlo, monospace; font-size: 0.82rem; color: var(--bone-2); word-break: break-all; }
  .relays li:last-child { border-bottom: 0; }
  .muted { color: var(--bone-3); }
  footer { margin-top: 32px; color: var(--bone-3); font-size: 0.8rem; }
</style>
</head>
<body>
<main>
  <header>
    <div>
      <h1 id="name">Relay<small id="kind"></small></h1>
      <p class="where" id="url"></p>
    </div>
    <p class="live" id="live"><i></i><span>Connecting…</span></p>
  </header>

  <div class="tiles">
    <div class="tile"><h2>Up for</h2><p class="big" id="uptime">–</p><p class="sub" id="started"></p></div>
    <div class="tile"><h2>Connections</h2><p class="big" id="conn">–</p><p class="sub" id="conn-sub"></p></div>
    <div class="tile"><h2>Messages</h2><p class="big" id="msgs">–</p><p class="sub" id="msgs-sub"></p></div>
    <div class="tile"><h2>Bandwidth</h2><p class="big" id="bw">–</p><p class="sub" id="bw-sub"></p></div>
    <div class="tile"><h2>Accounts kept</h2><p class="big" id="acc">–</p><p class="sub" id="acc-sub"></p></div>
  </div>

  <div class="charts">
    <div class="chart"><div class="chart-head"><h3>Connections</h3><span id="c-conn"></span></div><svg id="g-conn" preserveAspectRatio="none"></svg></div>
    <div class="chart"><div class="chart-head"><h3>Messages a second</h3><span id="c-msgs"></span></div><svg id="g-msgs" preserveAspectRatio="none"></svg>
      <div class="key"><span><i style="background:var(--sheen)"></i>in</span><span><i style="background:var(--bone-2)"></i>out</span></div></div>
    <div class="chart"><div class="chart-head"><h3>Bandwidth</h3><span id="c-bw"></span></div><svg id="g-bw" preserveAspectRatio="none"></svg>
      <div class="key"><span><i style="background:var(--sheen)"></i>in</span><span><i style="background:var(--bone-2)"></i>out</span></div></div>
    <div class="chart"><div class="chart-head"><h3>CPU (this relay)</h3><span id="c-cpu"></span></div><svg id="g-cpu" preserveAspectRatio="none"></svg></div>
    <div class="chart"><div class="chart-head"><h3>Event-loop delay, p99</h3><span id="c-loop"></span></div><svg id="g-loop" preserveAspectRatio="none"></svg></div>
    <div class="chart"><div class="chart-head"><h3>Memory (this relay)</h3><span id="c-mem"></span></div><svg id="g-mem" preserveAspectRatio="none"></svg></div>
  </div>

  <section>
    <h2>Accounts</h2>
    <div class="cols">
      <dl id="acc-browsers"></dl>
      <dl id="acc-relays"></dl>
    </div>
  </section>

  <section>
    <h2>Account events between relays</h2>
    <ul class="relays" id="events"></ul>
  </section>

  <section>
    <h2>Federation</h2>
    <p class="state" id="fed-state"></p>
    <div class="cols">
      <dl id="fed"></dl>
      <ul class="relays" id="links"></ul>
    </div>
  </section>

  <section>
    <h2>Performance</h2>
    <div class="cols">
      <dl id="proc"></dl>
      <dl id="sys"></dl>
    </div>
  </section>

  <footer>Counts since this relay started. Nothing here names a peer, an address or an account. <span id="history-span"></span></footer>
</main>
<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const num = (n) => Math.round(n).toLocaleString();
  const rate = (n) => n >= 100 ? num(n) : n >= 10 ? n.toFixed(1) : n.toFixed(2);
  const bytes = (n) => {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return (i === 0 ? Math.round(n) : n >= 100 ? Math.round(n) : n.toFixed(1)) + ' ' + units[i];
  };
  const duration = (s) => {
    const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
    if (d) return d + 'd ' + h + 'h';
    if (h) return h + 'h ' + m + 'm';
    if (m) return m + 'm ' + Math.floor(s % 60) + 's';
    return Math.floor(s) + 's';
  };
  const rows = (el, list) => {
    el.innerHTML = list.map(([k, v]) => '<dt>' + k + '</dt><dd>' + v + '</dd>').join('');
  };

  // A line (or two) over the last hour, scaled to its own range.
  function chart(svg, series, colors) {
    const w = 300, h = 72, pad = 3;
    svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    const all = series.flat();
    if (!all.length) { svg.innerHTML = ''; return; }
    const max = Math.max(...all, 0.0001);
    const lines = series.map((values, i) => {
      if (values.length < 2) return '';
      const step = w / (values.length - 1);
      const points = values.map((v, j) => (j * step).toFixed(1) + ',' + (h - pad - (v / max) * (h - pad * 2)).toFixed(1)).join(' ');
      const area = i === 0 ? '<polygon points="0,' + h + ' ' + points + ' ' + w + ',' + h + '" fill="' + colors[i] + '" fill-opacity="0.08"/>' : '';
      return area + '<polyline points="' + points + '" fill="none" stroke="' + colors[i] + '" stroke-width="1.5" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>';
    }).join('');
    svg.innerHTML = '<line x1="0" x2="' + w + '" y1="' + (h - 0.5) + '" y2="' + (h - 0.5) + '" stroke="#262e34"/>' + lines;
  }

  const SHEEN = '#56b09c', BONE = '#9aa5ad';
  let lastOk = 0;

  async function refresh() {
    let s;
    try {
      const response = await fetch('/api/v1/stats', { cache: 'no-store' });
      if (!response.ok) throw new Error(response.status);
      s = await response.json();
    } catch {
      $('live').className = 'live stale';
      $('live').lastElementChild.textContent = lastOk ? 'Not answering (last update ' + duration((Date.now() - lastOk) / 1000) + ' ago)' : 'Not answering';
      return;
    }
    lastOk = Date.now();
    $('live').className = 'live';
    $('live').lastElementChild.textContent = 'Live';

    const f = s.federation || {};
    $('name').firstChild.textContent = f.name || 'Relay';
    $('kind').textContent = f.kind ? f.kind + ' relay' : '';
    $('url').textContent = f.url || '';
    document.title = (f.name || 'Relay') + ' stats';

    const t = s.traffic, r = s.rates, a = s.accounts;
    $('uptime').textContent = duration(s.uptimeSeconds);
    $('started').textContent = 'since ' + new Date(s.startedAt).toLocaleString();
    $('conn').textContent = num(t.connectionsOpen);
    $('conn-sub').textContent = 'peak ' + num(t.connectionsPeak) + ' · ' + num(t.connectionsOpened) + ' in all';
    $('msgs').innerHTML = rate(r.messagesInPerSecond + r.messagesOutPerSecond) + '<small>/s</small>';
    $('msgs-sub').textContent = num(t.messagesIn) + ' in · ' + num(t.messagesOut) + ' out';
    $('bw').innerHTML = bytes(r.bytesInPerSecond + r.bytesOutPerSecond) + '<small>/s</small>';
    $('bw-sub').textContent = bytes(t.bytesIn + t.httpBytesIn) + ' in · ' + bytes(t.bytesOut + t.httpBytesOut) + ' out';
    $('acc').textContent = num(a.stored);
    $('acc-sub').textContent = num(a.lookups) + ' looked up · ' + num(a.registrations) + ' saved';

    const h = s.history || [];
    const pick = (k) => h.map((p) => p[k]);
    chart($('g-conn'), [pick('connections')], [SHEEN]);
    chart($('g-msgs'), [pick('messagesInPerSecond'), pick('messagesOutPerSecond')], [SHEEN, BONE]);
    chart($('g-bw'), [pick('bytesInPerSecond'), pick('bytesOutPerSecond')], [SHEEN, BONE]);
    chart($('g-cpu'), [pick('cpuPercent')], [SHEEN]);
    chart($('g-loop'), [pick('loopDelayP99Ms')], [SHEEN]);
    chart($('g-mem'), [pick('rssMb')], [SHEEN]);
    $('c-conn').textContent = num(t.connectionsOpen) + ' now';
    $('c-msgs').textContent = rate(r.messagesInPerSecond) + ' in · ' + rate(r.messagesOutPerSecond) + ' out';
    $('c-bw').textContent = bytes(r.bytesInPerSecond) + '/s in · ' + bytes(r.bytesOutPerSecond) + '/s out';
    $('c-cpu').textContent = s.process.cpuPercent.toFixed(1) + '%';
    $('c-loop').textContent = s.process.loopDelayP99Ms.toFixed(1) + ' ms';
    $('c-mem').textContent = Math.round(s.process.rssMb) + ' MB';
    $('history-span').textContent = h.length ? 'Charts: the last ' + duration(h.length * 5) + '.' : 'Charts fill in over the first minutes.';

    rows($('acc-browsers'), [
      ['Accounts kept', num(a.stored)],
      ['Looked up by browsers here', num(a.lookups)],
      ['… found', num(a.found)],
      ['Saved (new or changed)', num(a.registrations)],
      ['Already up to date', num(a.unchanged)],
      ['Refused (taken, invalid, old kind)', num(a.refused)],
    ]);
    rows($('acc-relays'), [
      ['Sent on to other relays', num(a.sentToRelays)],
      ['Asked other relays for', num(a.askedRelays)],
      ['Received from other relays', num(a.receivedFromRelays)],
      ['Looked up by other relays', num(a.askedByRelays)],
    ]);

    $('fed-state').textContent = f.federation || 'Federation is off.';
    rows($('fed'), [
      ['Linked local relays', num(f.linked || 0)],
      ['Post-quantum links', f.postQuantum ? 'on' : '<span class="muted">off</span>'],
      ['Accounts shared with relays', f.accountsShared ? 'yes' : '<span class="muted">no</span>'],
    ]);
    const events = (s.events || []).slice().reverse();
    $('events').innerHTML = events.length
      ? events.map((x) => '<li>' + x.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</li>').join('')
      : '<li class="muted">Nothing yet.</li>';
    const relays = f.relays || [];
    $('links').innerHTML = relays.length
      ? relays.map((x) => '<li>' + x + '</li>').join('')
      : '<li class="muted">No other local relays linked right now.</li>';

    const p = s.process, y = s.system;
    rows($('proc'), [
      ['CPU', p.cpuPercent.toFixed(1) + '%'],
      ['Memory', Math.round(p.rssMb) + ' MB (heap ' + Math.round(p.heapUsedMb) + ' of ' + Math.round(p.heapTotalMb) + ' MB)'],
      ['Event-loop delay, p99', p.loopDelayP99Ms.toFixed(1) + ' ms'],
      ['Node', p.node],
      ['HTTP requests', num(t.httpRequests)],
    ]);
    rows($('sys'), [
      ['Machine', y.platform],
      ['CPUs', y.cpus + (y.cpuModel ? ' · ' + y.cpuModel : '')],
      ['Load (1, 5, 15 min)', y.loadAverage.map((n) => n.toFixed(2)).join(', ')],
      ['Memory in use', Math.round(y.memoryTotalMb - y.memoryFreeMb).toLocaleString() + ' of ' + Math.round(y.memoryTotalMb).toLocaleString() + ' MB'],
      ['Machine up for', duration(y.uptimeSeconds)],
    ]);
  }

  refresh();
  setInterval(refresh, 2000);
})();
</script>
</body>
</html>
`;
