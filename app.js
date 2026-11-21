'use strict';
const metrics = [
  {key:'temperature_c', label:'Temperature', unit:'°C', scale:1},
  {key:'wind_kmh', label:'Wind speed', unit:'km/h', scale:5},
];
const colors = ['#006763','#aa392a','#3857a0','#8a5700','#843e85','#28712a','#595f06','#ad3466','#426a89','#6a4a38'];
const $ = id => document.getElementById(id);
const fmt = number => number == null ? '—' : new Intl.NumberFormat('en', {maximumFractionDigits:2}).format(number);
const delta = number => (number > 0 ? '+' : '') + fmt(number);

function el(tag, text, parent, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  if (parent) parent.append(node);
  return node;
}

function csv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted && ch === '"' && text[i+1] === '"') { field += '"'; i++; }
    else if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === ',' || ch === '\n')) {
      row.push(field);
      field = '';
      if (ch === '\n') { rows.push(row); row = []; }
    } else if (quoted || ch !== '\r') field += ch;
  }
  if (row.length || field) rows.push([...row, field]);
  const columns = rows.shift() || [];
  return rows.map(values => Object.fromEntries(columns.map((key, i) => [
    key, metrics.some(m => m.key === key) ? (values[i] === '' ? null : Number(values[i])) : values[i],
  ])));
}

function table(target, rows, options = {}) {
  target.replaceChildren();
  if (!rows.length) { el('p', 'No locations to show.', target); return; }
  const grid = el('table', null, el('div', null, target, 'table-wrap'));
  const head = el('tr', null, el('thead', null, grid));
  for (const label of ['Location', 'Source', ...metrics.map(m => m.label + ' (' + m.unit + ')'),
    ...(options.star ? ['Shortlist'] : [])]) el('th', label, head).scope = 'col';
  const body = el('tbody', null, grid);
  for (const row of rows) {
    const tr = el('tr', null, body);
    el('th', row.item, tr).scope = 'row';
    el('td', row.source, tr);
    for (const m of metrics) {
      const cell = el('td', fmt(row[m.key]), tr);
      if (options.old) {
        const before = options.old.get(row.item_id)?.[m.key];
        el('small', before == null || row[m.key] == null ? '—' : delta(row[m.key] - before) + ' ' + m.unit, cell);
      }
    }
    if (options.star) options.star(row, el('td', null, tr));
  }
}

function today(status, latest, previous) {
  const stats = el('div', null, $('summary'), 'stats');
  for (const [label, value] of [['First archived day', status.first_run_date], ['Days with data', status.days_with_success],
    ['Locations today', status.items], ['Appeared', status.new_today], ['Disappeared', status.gone_today]]) {
    const card = el('div', null, stats, 'stat');
    el('span', label, card);
    el('strong', value ?? '—', card);
  }
  for (const source of status.sources) {
    const card = el('div', null, $('sources'), 'source');
    el('strong', source.name, card);
    el('span', (source.ok ? 'Available' : 'Failed') + ' · ' + source.count + ' locations', card, source.ok ? 'ok' : 'failed');
  }
  const old = new Map(previous.map(r => [r.item_id, r]));
  const moves = latest.flatMap(row => {
    const candidates = metrics.flatMap(m => {
      const before = old.get(row.item_id)?.[m.key], after = row[m.key];
      return before == null || after == null || before === after ? [] :
        [{row, score:Math.abs(after-before)/m.scale, m, before, after}];
    });
    return candidates.sort((a,b) => b.score-a.score).slice(0,1);
  }).sort((a,b) => b.score-a.score || (a.row.item_id < b.row.item_id ? -1 : 1)).slice(0,5);
  el('p', status.previous_run_date ? 'Compared with the ' + status.previous_run_date + ' UTC run.' :
    'The first run has no earlier readings for comparison.', $('moves'));
  if (moves.length) {
    const list = el('ol', null, $('moves'));
    for (const {row,m,before,after} of moves) el('li', row.item + ' · ' + m.label + ' · ' +
      fmt(before) + ' → ' + fmt(after) + ' ' + m.unit + ' (' + delta(after-before) + ')', list);
  } else el('p', 'No comparable values changed.', $('moves'));
  table($('table'), latest, {old});
}

function browse(latest) {
  const controls = $('filters');
  const search = el('input', null, el('label', 'Search locations', controls));
  search.type = 'search';
  function select(label, options) {
    const node = el('select', null, el('label', label, controls));
    for (const [value, caption] of options) el('option', caption, node).value = value;
    return node;
  }
  const choices = key => [['','All'], ...[...new Set(latest.map(row => row[key]))].sort().map(v => [v,v])];
  const source = select('Source', choices('source'));
  const category = select('Category', choices('category'));
  const sort = select('Sort', [['','Location name'], ...metrics.flatMap(m => [
    [m.key + ':1', m.label + ' · Low to high'], [m.key + ':-1', m.label + ' · High to low'],
  ])]);
  const only = el('input', null, el('label', 'Shortlist only', controls, 'check'));
  only.type = 'checkbox';
  const storageKey = 'weather-tracker-shortlist';
  let saved;
  try { saved = new Set(JSON.parse(localStorage.getItem(storageKey)) || []); }
  catch { saved = new Set(); }
  function render() {
    const query = search.value.trim().toLowerCase();
    const rows = latest.filter(row => row.item.toLowerCase().includes(query) &&
      (!source.value || row.source === source.value) && (!category.value || row.category === category.value) &&
      (!only.checked || saved.has(row.item_id)));
    const [key, direction] = sort.value.split(':');
    rows.sort((a,b) => {
      if (key) {
        if (a[key] == null && b[key] != null) return 1;
        if (a[key] != null && b[key] == null) return -1;
        if (a[key] != null && b[key] != null && a[key] !== b[key]) return (a[key]-b[key])*Number(direction);
      }
      return a.item.localeCompare(b.item);
    });
    $('result-count').textContent = rows.length + ' of ' + latest.length + ' locations';
    table($('table'), rows, {star(row, cell) {
      const button = el('button', '', cell);
      function update() {
        const starred = saved.has(row.item_id);
        button.textContent = starred ? '★' : '☆';
        button.setAttribute('aria-label', 'Shortlist ' + row.item);
        button.setAttribute('aria-pressed', starred);
      }
      update();
      button.addEventListener('click', () => {
        if (saved.has(row.item_id)) saved.delete(row.item_id);
        else saved.add(row.item_id);
        try { localStorage.setItem(storageKey, JSON.stringify([...saved])); }
        catch { $('status').textContent = 'Browser storage is unavailable. The shortlist lasts for this visit.'; }
        if (only.checked) render();
        else update();
      });
    }});
  }
  for (const control of [search, source, category, sort, only]) control.addEventListener('input', render);
  render();
}

const chartObserver = new ResizeObserver(entries => {
  for (const {target} of entries) target.drawChart();
});

function chart(parent, title, labels, series, unit) {
  const figure = el('figure', null, parent);
  el('h3', title, figure);
  const values = series.flatMap(line => line.values.filter(value => value != null));
  if (!values.length) {
    el('p', 'No measurements available for this chart.', figure);
    return;
  }
  const canvas = el('canvas', null, figure);
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', title + '. Values in ' + unit + '. A data table follows.');
  const caption = el('figcaption', null, figure);
  for (const [index,line] of series.entries()) {
    const key = el('span', null, caption, 'key');
    el('span', null, key, 'swatch').style.background = colors[index % colors.length];
    key.append(line.name);
  }
  const details = el('details', null, figure);
  el('summary', 'Chart data', details);
  details.addEventListener('toggle', () => {
    if (!details.open || details.querySelector('table')) return;
    const grid = el('table', null, el('div', null, details, 'table-wrap'));
    const head = el('tr', null, el('thead', null, grid));
    for (const label of ['Date or location', ...series.map(line => line.name + ' (' + unit + ')')]) el('th', label, head).scope = 'col';
    const body = el('tbody', null, grid);
    labels.forEach((label,i) => {
      const row = el('tr', null, body);
      el('th', label, row).scope = 'row';
      for (const line of series) el('td', fmt(line.values[i]), row);
    });
  });
  canvas.drawChart = () => {
    const width = canvas.clientWidth, height = canvas.clientHeight;
    if (!width) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(width*ratio);
    canvas.height = Math.round(height*ratio);
    const ctx = canvas.getContext('2d');
    ctx.scale(ratio,ratio);
    const left = 54, right = width-18, top = 15, bottom = height-34;
    const extent = values.reduce(([lo,hi], v) => [Math.min(lo,v),Math.max(hi,v)], [Infinity,-Infinity]);
    const pad = (extent[1]-extent[0])/12 || 1;
    const lo = extent[0]-pad, hi = extent[1]+pad;
    const x = i => labels.length === 1 ? (left+right)/2 : left+i*(right-left)/(labels.length-1);
    const y = v => bottom-(v-lo)*(bottom-top)/(hi-lo);
    ctx.font = '12px system-ui';
    ctx.fillStyle = '#455d6f';
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const value = lo+i*(hi-lo)/4;
      const pos = y(value);
      ctx.strokeStyle = '#d4e1e6';
      ctx.beginPath(); ctx.moveTo(left,pos); ctx.lineTo(right,pos); ctx.stroke();
      ctx.fillText(fmt(value),left-7,pos+4);
    }
    const ticks = Math.min(labels.length,Math.max(2, Math.floor((right-left)/92)));
    for (let t = 0; t < ticks; t++) {
      const i = ticks === 1 ? 0 : Math.round(t*(labels.length-1)/(ticks-1));
      const label = labels[i];
      ctx.textAlign = ticks === 1 ? 'center' : t === 0 ? 'left' : t === ticks-1 ? 'right' : 'center';
      ctx.fillText(label, x(i), bottom+19, 85);
    }
    series.forEach((line,index) => {
      ctx.strokeStyle = ctx.fillStyle = colors[index % colors.length];
      ctx.lineWidth = 2;
      ctx.beginPath();
      let connected = false;
      line.values.forEach((value,i) => {
        if (value == null) { connected = false; return; }
        if (connected) ctx.lineTo(x(i),y(value));
        else ctx.moveTo(x(i),y(value));
        connected = true;
      });
      ctx.stroke();
      line.values.forEach((value,i) => {
        if (value == null) return;
        ctx.beginPath();
        ctx.arc(x(i),y(value),2.6,0,Math.PI*2);
        ctx.fill();
      });
    });
  };
  chartObserver.observe(canvas);
}

function trends(rows) {
  const items = new Map(), days = new Map();
  for (const row of rows) {
    if (!items.has(row.item_id)) items.set(row.item_id, {name:row.item, history:new Map()});
    if (!days.has(row.date)) days.set(row.date, []);
    items.get(row.item_id).history.set(row.date,row);
    days.get(row.date).push(row);
  }
  const dates = [...days.keys()].sort();
  const locations = [...items.values()].sort((a,b) => a.name.localeCompare(b.name));
  const controls = $('locations');
  const inputs = locations.map((item,i) => {
    const label = el('label', null, controls, 'check');
    const input = el('input', null, label);
    input.type = 'checkbox';
    input.checked = i < 3;
    input.addEventListener('change', renderSeries);
    label.append(item.name);
    return input;
  });
  function renderSeries() {
    const target = $('series');
    for (const canvas of target.querySelectorAll('canvas')) chartObserver.unobserve(canvas);
    target.replaceChildren();
    for (const metric of metrics) chart(target, metric.label + ' over time', dates,
      locations.filter((_,i) => inputs[i].checked).map(item => ({
        name:item.name, values:dates.map(day => item.history.get(day)?.[metric.key] ?? null),
      })), metric.unit);
  }
  renderSeries();

  function finding(heading, explanation, chartTitle, labels, values, unit) {
    const section = el('section', null, $('findings'));
    el('h2', heading, section);
    el('p', explanation, section);
    chart(section, chartTitle, labels, [{name:chartTitle, values}], unit);
  }
  const daily = (key, calculate) => dates.map(day => {
    const readings = days.get(day).map(row => row[key]).filter(v => v != null);
    return readings.length ? calculate(readings) : null;
  });
  const bestIndex = (values, score = value => value) => values.reduce((best, value, i) =>
    value != null && (best < 0 || score(value) > score(values[best])) ? i : best, -1);
  const maxima = daily('temperature_c', values => Math.max(...values));
  const hot = bestIndex(maxima);
  const warmest = hot < 0 ? null : days.get(dates[hot]).find(row => row.temperature_c === maxima[hot]);
  finding(warmest ? warmest.item + ' recorded the highest temperature' : 'Highest temperature is pending',
    (warmest ? fmt(maxima[hot]) + ' °C on ' + dates[hot] + '. ' : '') +
    'The chart takes the highest reported temperature among locations on each date.',
    'Daily high', dates, maxima, '°C');

  const wind = daily('wind_kmh', values => values.reduce((sum,v) => sum+v,0)/values.length);
  const windy = bestIndex(wind);
  finding(windy < 0 ? 'Average wind is pending' : 'Average wind peaked on ' + dates[windy],
    (windy < 0 ? '' : 'Average wind reached ' + fmt(wind[windy]) + ' km/h. ') +
    'For each date the chart divides the sum of wind readings by the number of locations reporting wind.',
    'Daily mean wind', dates, wind, 'km/h');

  const spread = daily('temperature_c', values => values.length > 1 ? Math.max(...values)-Math.min(...values) : null);
  const wide = bestIndex(spread);
  finding(wide < 0 ? 'Temperature spread is pending' : 'Temperatures were farthest apart on ' + dates[wide],
    (wide < 0 ? '' : 'The warmest and coolest readings were ' + fmt(spread[wide]) + ' °C apart. ') +
    'The chart subtracts the lowest reading from the highest on each date with at least two readings.',
    'Daily temperature spread', dates, spread, '°C');

  const endpoints = locations.map(item => {
    const valid = [...item.history].filter(([,row]) => row.temperature_c != null).sort(([a],[b]) => a.localeCompare(b));
    if (valid.length < 2) return null;
    const [start,first] = valid[0], [end,last] = valid.at(-1);
    return {start,end,value:last.temperature_c-first.temperature_c};
  });
  const changes = endpoints.map(entry => entry?.value ?? null);
  const furthest = bestIndex(changes, Math.abs), extreme = endpoints[furthest];
  finding(extreme ? locations[furthest].name + ' had the largest temperature shift' : 'Temperature shifts need two readings',
    (extreme ? delta(extreme.value) + ' °C from ' + extreme.start + ' to ' + extreme.end + '. ' : '') +
    'Each location’s shift is its last reported temperature minus its first. The finding uses the largest absolute shift.',
    'First-to-last temperature change', locations.map(item => item.name), changes, '°C');
}

async function load() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(console.warn);
  async function data(name, format) {
    const response = await fetch('./data/' + name, {cache:'no-cache'});
    if (!response.ok) throw new Error('HTTP ' + response.status + ' loading ' + name);
    return response[format]();
  }
  const [status, text] = await Promise.all([data('status.json','json'), data('history.csv','text')]);
  const rows = csv(text), day = status.run_time?.slice(0,10);
  $('status').textContent = status.run_time ? 'Last run · ' +
    new Intl.DateTimeFormat('en', {dateStyle:'long', timeStyle:'medium', timeZone:'UTC'})
      .format(new Date(status.run_time)) + ' UTC' : 'Waiting for the first collection.';
  const latest = rows.filter(row => row.date === day);
  const page = document.body.dataset.page;
  if (page === 'today') today(status, latest, rows.filter(row => row.date === status.previous_run_date));
  if (page === 'browse') browse(latest);
  if (page === 'trends') trends(rows);
}
load().catch(error => {
  console.error(error);
  $('status').textContent = 'Weather data could not be loaded. Reconnect and reload this page.';
});
