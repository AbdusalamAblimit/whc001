const d3 = window.d3;
const topojson = window.topojson;

const criteriaDefinitions = {
  i: 'Represents a masterpiece of human creative genius.',
  ii: 'Exhibits an important interchange of human values over time.',
  iii: 'Bears a unique or exceptional testimony to a cultural tradition or civilization.',
  iv: 'Is an outstanding example of a type of building, architectural or technological ensemble or landscape.',
  v: 'Is an outstanding example of traditional human settlement, land-use, or sea-use.',
  vi: 'Is directly or tangibly associated with events, living traditions, ideas, beliefs, or artistic works.',
  vii: 'Contains superlative natural phenomena or areas of exceptional natural beauty and aesthetic importance.',
  viii: 'Is an outstanding example representing major stages of Earth’s history.',
  ix: 'Is an outstanding example representing significant ongoing ecological and biological processes.',
  x: 'Contains the most important and significant natural habitats for in-situ conservation of biological diversity.'
};

const criteriaOrder = Object.keys(criteriaDefinitions);

const categoryColor = d3
  .scaleOrdinal()
  .domain(['Cultural', 'Natural', 'Mixed', 'Other'])
  .range(['#f59e0b', '#10b981', '#a855f7', '#38bdf8']);

const dangerColors = { Y: '#fb923c', R: '#38bdf8' };
const categoryLabels = {
  Cultural: 'Cultural',
  Natural: 'Natural',
  Mixed: 'Mixed',
  Other: 'Other / Unspecified'
};

const state = {
  year: null,
  viewMode: 'category',
  selectedStandards: new Set(),
  standardMode: 'OR',
  searchTerm: '',
  dangerOnly: false,
  showDangerEvents: true,
  brushRange: null,
  playing: false,
  sunburstSelection: null
};

let sites = [];
let worldGeo;
let playTimer;
let yearExtent = [1978, 2024];
let regionColor;
let mapProjection;
let mapPath;
let mapSiteLayer;
let mapSiteSelection;
let timelineScales = {};
let timelineBars;
let timelineAxisX;
let timelineAxisY;
let timelineBrush;
let timelineBrushGroup;
let timelineBarSelection;
let dangerPaths = {};
let sunburstArcSelection;
let currentFiltered = [];

const tooltip = d3.select('#tooltip');
const summaryCounts = d3.select('#summary-counts');
const breadcrumb = d3.select('#sunburst-breadcrumb');

Promise.all([
  d3.json('whc001.json'),
  d3.json('https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json')
])
  .then(init)
  .catch((error) => {
    console.error('Failed to load data', error);
    summaryCounts.text('Unable to load data. Please check your network connection.');
  });

function init([rawSites, worldData]) {
  worldGeo = topojson.feature(worldData, worldData.objects.countries);
  sites = rawSites
    .map((d) => formatSite(d))
    .filter((d) => d && Number.isFinite(d.lat) && Number.isFinite(d.lon) && Number.isFinite(d.year))
    .sort((a, b) => d3.ascending(a.year, b.year));

  const uniqueRegions = Array.from(new Set(sites.map((d) => d.region))).sort();
  regionColor = d3
    .scaleOrdinal()
    .domain(uniqueRegions)
    .range([...d3.schemeTableau10, ...d3.schemeSet2, ...d3.schemeSet3]);

  yearExtent = d3.extent(sites, (d) => d.year);
  state.year = yearExtent[1];
  updateYearSlider();
  setupCriteriaControls();
  setupSearchOptions();
  setupControlListeners();

  initMap();
  initTimeline();
  initSunburst();
  updateLegends();

  render();
}

function formatSite(d) {
  const year = parseYear(d.date_inscribed ?? d.secondary_dates);
  if (!year) return null;
  const criteria = parseCriteria(d.criteria_txt);
  const countries = Array.isArray(d.states_names) && d.states_names.length ? d.states_names : ['Unspecified country'];
  const dangerEvents = parseDangerList(d.danger_list);
  const category = ['Cultural', 'Natural', 'Mixed'].includes(d.category) ? d.category : 'Other';
  return {
    id: d.uuid ?? d.id_no ?? d.name_en,
    name: d.name_en,
    region: d.region ?? 'Unspecified region',
    year,
    category,
    criteria,
    lat: d.coordinates?.lat,
    lon: d.coordinates?.lon,
    countries,
    statesText: countries.join(', '),
    danger: String(d.danger).toLowerCase() === 'true',
    dangerEvents,
    dangerTimeline: dangerEvents.length
      ? dangerEvents.map((evt) => `${evt.type} ${evt.year}`).join(' → ')
      : 'No recorded danger events',
    description: d.short_description_en || d.short_description_zh || '',
    iso: d.iso_codes,
    url: d.main_image_url?.url,
    criteriaText: d.criteria_txt
  };
}

function parseYear(value) {
  if (!value) return null;
  const match = String(value).match(/\d{4}/);
  return match ? +match[0] : null;
}

function parseCriteria(text) {
  if (!text) return [];
  const matches = text.match(/\(([ivx]+)\)/gi) || [];
  return matches.map((m) => m.replace(/[()]/g, '').toLowerCase());
}

function parseDangerList(text) {
  if (!text) return [];
  const events = [];
  const regex = /([A-Z])\s*(\d{4})/g;
  let match = regex.exec(text);
  while (match) {
    events.push({ type: match[1], year: +match[2] });
    match = regex.exec(text);
  }
  return events;
}

function updateYearSlider() {
  const slider = document.getElementById('yearSlider');
  slider.min = yearExtent[0];
  slider.max = yearExtent[1];
  slider.value = state.year;
  document.getElementById('yearValue').textContent = state.year;
}

function setupCriteriaControls() {
  const container = d3.select('#criteriaList');
  const entries = criteriaOrder.map((code) => ({ code, desc: criteriaDefinitions[code] }));
  const labels = container
    .selectAll('label')
    .data(entries)
    .join('label')
    .html(
      (d) => `
        <input type="checkbox" value="${d.code}" />
        <span>${d.code.toUpperCase()}</span>
      `
    );

  labels
    .select('input')
    .on('change', function (event, d) {
      if (event.target.checked) {
        state.selectedStandards.add(d.code);
      } else {
        state.selectedStandards.delete(d.code);
      }
      render();
    });
}

function setupSearchOptions() {
  const list = d3.select('#searchOptions');
  const options = new Set();
  sites.forEach((site) => {
    options.add(site.name);
    site.countries.forEach((country) => options.add(country));
  });
  list
    .selectAll('option')
    .data(Array.from(options).sort())
    .join('option')
    .attr('value', (d) => d);
}

function setupControlListeners() {
  d3.select('#yearSlider').on('input', (event) => {
    state.year = +event.target.value;
    document.getElementById('yearValue').textContent = state.year;
    render();
  });

  d3.select('#viewMode').on('change', (event) => {
    state.viewMode = event.target.value;
    updateLegends();
    render();
  });

  d3.select('#searchInput').on('input', (event) => {
    state.searchTerm = event.target.value.trim().toLowerCase();
    render();
  });

  d3.select('#dangerOnly').on('change', (event) => {
    state.dangerOnly = event.target.checked;
    render();
  });

  d3.select('#andDangerEvents').on('change', (event) => {
    state.showDangerEvents = event.target.checked;
    updateLegends();
    render();
  });

  d3.select('#criteriaMode').on('click', function () {
    state.standardMode = state.standardMode === 'OR' ? 'AND' : 'OR';
    d3.select(this)
      .attr('data-mode', state.standardMode)
      .text(state.standardMode === 'OR' ? 'Mode: match any' : 'Mode: match all');
    render();
  });

  d3.select('#playToggle').on('click', () => togglePlay());

  breadcrumb.on('click', () => {
    state.sunburstSelection = null;
    breadcrumb.text('All Regions');
    render();
  });
}

function togglePlay() {
  state.playing = !state.playing;
  const button = d3.select('#playToggle');
  if (state.playing) {
    button.text('⏸');
    playTimer = setInterval(() => {
      if (state.year >= yearExtent[1]) {
        state.year = yearExtent[0];
      } else {
        state.year += 1;
      }
      updateYearSlider();
      render();
    }, 800);
  } else {
    button.text('▶︎');
    clearInterval(playTimer);
  }
}

function initMap() {
  const svg = d3.select('#map');
  const { width, height } = getDimensions(svg.node());
  svg.attr('viewBox', `0 0 ${width} ${height}`);

  mapProjection = d3.geoEqualEarth().fitSize([width, height], { type: 'Sphere' });
  mapPath = d3.geoPath(mapProjection);

  const defs = svg.append('defs');
  const gradient = defs.append('radialGradient').attr('id', 'oceanGradient');
  gradient
    .append('stop')
    .attr('offset', '0%')
    .attr('stop-color', '#0f172a');
  gradient
    .append('stop')
    .attr('offset', '100%')
    .attr('stop-color', '#020617');

  svg
    .append('path')
    .attr('class', 'sphere')
    .attr('d', mapPath({ type: 'Sphere' }))
    .attr('fill', 'url(#oceanGradient)');

  svg
    .append('path')
    .attr('class', 'graticule')
    .attr('d', mapPath(d3.geoGraticule10()))
    .attr('fill', 'none')
    .attr('stroke', 'rgba(148, 163, 184, 0.2)')
    .attr('stroke-width', 0.5);

  svg
    .append('g')
    .attr('class', 'countries')
    .selectAll('path')
    .data(worldGeo.features)
    .join('path')
    .attr('d', mapPath)
    .attr('fill', 'rgba(15, 23, 42, 0.8)')
    .attr('stroke', 'rgba(148, 163, 184, 0.2)')
    .attr('stroke-width', 0.5);

  mapSiteLayer = svg.append('g').attr('class', 'sites');
}

function updateMap(data) {
  mapSiteSelection = mapSiteLayer
    .selectAll('circle')
    .data(data, (d) => d.id)
    .join(
      (enter) =>
        enter
          .append('circle')
          .attr('class', 'site-point')
          .attr('r', 0)
          .attr('cx', (d) => mapProjection([d.lon, d.lat])[0])
          .attr('cy', (d) => mapProjection([d.lon, d.lat])[1])
          .attr('fill', (d) => categoryColor(d.category))
          .call((sel) => sel.transition().duration(400).attr('r', 4)),
      (update) => update,
      (exit) => exit.call((sel) => sel.transition().duration(200).attr('r', 0).remove())
    )
    .classed('danger', (d) => d.danger)
    .attr('fill', (d) => categoryColor(d.category))
    .attr('cx', (d) => mapProjection([d.lon, d.lat])[0])
    .attr('cy', (d) => mapProjection([d.lon, d.lat])[1])
    .on('mouseenter', (event, d) => showTooltip(event, d))
    .on('mousemove', (event) => moveTooltip(event))
    .on('mouseleave', hideTooltip);

  updateBrushHighlight();
}

function showTooltip(event, d) {
  const criteriaHtml = d.criteria.length
    ? `<ul>${d.criteria
        .map((code) => `<li><strong>${code.toUpperCase()}</strong> ${criteriaDefinitions[code]}</li>`)
        .join('')}</ul>`
    : '<p>No criteria listed</p>';
  tooltip
    .html(`
      <h3>${d.name}</h3>
      <div>${d.statesText}</div>
      <div>${d.year} ｜ ${d.category}</div>
      <div>${d.danger ? '<span class="danger-pill">In Danger</span>' : ''}</div>
      <div>${d.description}</div>
      <div><strong>Criteria</strong>${criteriaHtml}</div>
      <div><strong>Danger events:</strong> ${d.dangerTimeline}</div>
    `)
    .style('left', `${event.pageX + 16}px`)
    .style('top', `${event.pageY - 16}px`)
    .attr('hidden', null);
}

function moveTooltip(event) {
  tooltip.style('left', `${event.pageX + 16}px`).style('top', `${event.pageY - 16}px`);
}

function hideTooltip() {
  tooltip.attr('hidden', true);
}

function initTimeline() {
  const svg = d3.select('#timeline');
  const { width, height } = getDimensions(svg.node());
  svg.attr('viewBox', `0 0 ${width} ${height}`);
  const margin = { top: 20, right: 30, bottom: 30, left: 50 };

  timelineScales.x = d3.scaleLinear().range([margin.left, width - margin.right]);
  timelineScales.y = d3.scaleLinear().range([height - margin.bottom, margin.top]);

  timelineBars = svg.append('g').attr('class', 'timeline-bars');
  timelineAxisX = svg
    .append('g')
    .attr('class', 'axis axis--x')
    .attr('transform', `translate(0, ${height - margin.bottom})`);
  timelineAxisY = svg
    .append('g')
    .attr('class', 'axis axis--y')
    .attr('transform', `translate(${margin.left}, 0)`);

  const dangerGroup = svg.append('g').attr('class', 'danger-lines');
  dangerPaths.Y = dangerGroup
    .append('path')
    .attr('class', 'danger-line')
    .attr('stroke', dangerColors.Y);
  dangerPaths.R = dangerGroup
    .append('path')
    .attr('class', 'danger-line')
    .attr('stroke', dangerColors.R);

  timelineBrush = d3
    .brushX()
    .extent([
      [margin.left, margin.top],
      [width - margin.right, height - margin.bottom]
    ])
    .on('brush end', ({ selection }) => {
      if (selection) {
        const [x0, x1] = selection.map(timelineScales.x.invert);
        state.brushRange = [Math.round(x0), Math.round(x1)];
      } else {
        state.brushRange = null;
      }
      updateBrushHighlight();
    });

  timelineBrushGroup = svg.append('g').attr('class', 'timeline-brush').call(timelineBrush);
}

function prepareStackData(data) {
  const keys = state.viewMode === 'category' ? categoryColor.domain() : regionColor.domain();
  const yearRange = d3.range(yearExtent[0], yearExtent[1] + 1);
  const yearRecords = yearRange.map((year) => {
    const record = { year };
    keys.forEach((key) => {
      record[key] = 0;
    });
    return record;
  });
  const yearMap = new Map(yearRecords.map((record) => [record.year, record]));
  data.forEach((site) => {
    const groupingKey = state.viewMode === 'category' ? site.category : site.region;
    if (!yearMap.has(site.year)) return;
    yearMap.get(site.year)[groupingKey] += 1;
  });
  yearRecords.forEach((record) => {
    record.total = keys.reduce((sum, key) => sum + record[key], 0);
  });
  return { keys, yearRecords };
}

function updateTimeline(data) {
  const { keys, yearRecords } = prepareStackData(data);
  const stack = d3.stack().keys(keys)(yearRecords);
  const maxValue = d3.max(yearRecords, (d) => d.total) || 1;
  timelineScales.x.domain(yearExtent);
  timelineScales.y.domain([0, maxValue]).nice();

  const barWidth = Math.max(2, (timelineScales.x(yearExtent[0] + 1) - timelineScales.x(yearExtent[0])) * 0.6);
  const colorScale = state.viewMode === 'category' ? categoryColor : regionColor;

  const groups = timelineBars
    .selectAll('g.stack-layer')
    .data(stack, (d) => d.key)
    .join((enter) => enter.append('g').attr('class', 'stack-layer'))
    .attr('fill', (d) => colorScale(d.key));

  groups
    .selectAll('rect')
    .data((series) =>
      series.map((d) => ({
        year: d.data.year,
        key: series.key,
        y0: d[0],
        y1: d[1]
      }))
    )
    .join('rect')
    .attr('x', (d) => timelineScales.x(d.year) - barWidth / 2)
    .attr('width', barWidth)
    .attr('y', (d) => timelineScales.y(d.y1))
    .attr('height', (d) => Math.max(0, timelineScales.y(d.y0) - timelineScales.y(d.y1)))
    .attr('opacity', (d) => (d.year <= state.year ? 0.7 : 0.15));

  timelineBarSelection = timelineBars.selectAll('rect');

  timelineAxisX.call(d3.axisBottom(timelineScales.x).tickFormat(d3.format('d')));
  timelineAxisY.call(d3.axisLeft(timelineScales.y));

  if (state.showDangerEvents) {
    const dangerSeries = buildDangerSeries(data);
    const dangerLine = d3
      .line()
      .defined((d) => d.value !== null)
      .x((d) => timelineScales.x(d.year))
      .y((d) => timelineScales.y(d.value))
      .curve(d3.curveCatmullRom.alpha(0.5));
    dangerPaths.Y.attr('d', dangerLine(dangerSeries.Y)).style('display', 'block');
    dangerPaths.R.attr('d', dangerLine(dangerSeries.R)).style('display', 'block');
  } else {
    dangerPaths.Y.style('display', 'none');
    dangerPaths.R.style('display', 'none');
  }

  updateBrushHighlight();
}

function buildDangerSeries(data) {
  const yearRange = d3.range(yearExtent[0], yearExtent[1] + 1);
  const base = yearRange.map((year) => ({ year, value: year <= state.year ? 0 : null }));
  const seriesY = base.map((d) => ({ ...d }));
  const seriesR = base.map((d) => ({ ...d }));
  const yearIndex = new Map(base.map((d, i) => [d.year, i]));
  data.forEach((site) => {
    site.dangerEvents.forEach((evt) => {
      if (!yearIndex.has(evt.year) || evt.year > state.year) return;
      const idx = yearIndex.get(evt.year);
      if (evt.type === 'Y') seriesY[idx].value += 1;
      if (evt.type === 'R') seriesR[idx].value += 1;
    });
  });
  return { Y: seriesY, R: seriesR };
}

function initSunburst() {
  const svg = d3.select('#sunburst');
  const { width, height } = getDimensions(svg.node());
  svg.attr('viewBox', `0 0 ${width} ${height}`);
  const radius = Math.min(width, height) / 2 - 10;
  svg.append('g').attr('class', 'sunburst-root').attr('transform', `translate(${width / 2}, ${height / 2})`);
  svg.node().__radius = radius;
  svg.node().__center = [width / 2, height / 2];
}

function updateSunburst(data) {
  const svg = d3.select('#sunburst');
  const rootGroup = svg.select('.sunburst-root');
  const radius = svg.node().__radius;

  const hierarchyData = buildHierarchy(data);
  const root = d3
    .hierarchy(hierarchyData)
    .sum((d) => d.value || 0)
    .sort((a, b) => b.value - a.value);

  const partition = d3.partition().size([2 * Math.PI, radius]);
  partition(root);

  const arcGenerator = d3
    .arc()
    .startAngle((d) => d.x0)
    .endAngle((d) => d.x1)
    .padAngle(1 / radius)
    .padRadius(radius / 3)
    .innerRadius((d) => d.y0)
    .outerRadius((d) => d.y1);

  const nodes = root.descendants().filter((d) => d.depth > 0);
  const arcs = rootGroup
    .selectAll('path')
    .data(nodes, (d) => `${d.ancestors().map((n) => n.data.name).join('-')}`)
    .join('path')
    .attr('d', arcGenerator)
    .attr('fill', (d) => {
      if (d.depth === 3) return categoryColor(d.data.name) ?? '#38bdf8';
      if (d.depth === 1) return regionColor(d.data.name) ?? '#475569';
      if (d.depth === 2) {
        const base = regionColor(d.ancestors()[1].data.name) ?? '#475569';
        const colored = d3.color(base);
        return colored ? colored.brighter(0.4) : '#94a3b8';
      }
      return '#475569';
    })
    .on('click', (event, d) => {
      event.stopPropagation();
      handleSunburstClick(d);
    });

  arcs
    .selectAll('title')
    .data((d) => [d])
    .join('title')
    .text((d) => `${d.data.name}: ${d.value}`);

  sunburstArcSelection = arcs;
  sunburstArcSelection.classed('selected', (d) => matchesSunburstSelection(d));
}

function buildHierarchy(data) {
  const nested = d3.rollup(
    data.flatMap((site) => site.countries.map((country) => ({ ...site, country }))),
    (sitesByCountry) =>
      d3.rollup(
        sitesByCountry,
        (sitesByCategory) => sitesByCategory.length,
        (site) => site.category
      ),
    (site) => site.region,
    (site) => site.country
  );

  return { name: 'World', children: rollupToChildren(nested) };
}

function rollupToChildren(map) {
  if (!(map instanceof Map)) {
    return [];
  }
  return Array.from(map, ([key, value]) => {
    if (value instanceof Map) {
      return { name: key, children: rollupToChildren(value) };
    }
    return { name: key, value };
  });
}

function handleSunburstClick(node) {
  const ancestors = node.ancestors().reverse().slice(1);
  const selection = {
    region: ancestors[0]?.data.name,
    country: ancestors[1]?.data.name,
    category: ancestors[2]?.data.name
  };
  const same =
    state.sunburstSelection &&
    state.sunburstSelection.region === selection.region &&
    state.sunburstSelection.country === selection.country &&
    state.sunburstSelection.category === selection.category;
  state.sunburstSelection = same ? null : selection;
  const labelParts = [];
  if (state.sunburstSelection?.region) labelParts.push(state.sunburstSelection.region);
  if (state.sunburstSelection?.country) labelParts.push(state.sunburstSelection.country);
  if (state.sunburstSelection?.category) labelParts.push(state.sunburstSelection.category);
  breadcrumb.text(labelParts.length ? labelParts.join(' → ') : 'All Regions');
  render();
}

function matchesSunburstSelection(node) {
  if (!state.sunburstSelection) return false;
  const path = node.ancestors().reverse().slice(1);
  if (state.sunburstSelection.category) {
    return (
      path[0]?.data.name === state.sunburstSelection.region &&
      path[1]?.data.name === state.sunburstSelection.country &&
      path[2]?.data.name === state.sunburstSelection.category
    );
  }
  if (state.sunburstSelection.country) {
    return (
      path[0]?.data.name === state.sunburstSelection.region &&
      path[1]?.data.name === state.sunburstSelection.country
    );
  }
  return path[0]?.data.name === state.sunburstSelection.region;
}

function getFilteredSites() {
  return sites.filter((site) => {
    if (site.year > state.year) return false;
    if (state.dangerOnly && !site.danger) return false;
    if (state.searchTerm) {
      const haystack = `${site.name} ${site.statesText}`.toLowerCase();
      if (!haystack.includes(state.searchTerm)) return false;
    }
    if (state.selectedStandards.size > 0) {
      if (state.standardMode === 'OR') {
        const hasAny = site.criteria.some((c) => state.selectedStandards.has(c));
        if (!hasAny) return false;
      } else {
        const hasAll = Array.from(state.selectedStandards).every((c) => site.criteria.includes(c));
        if (!hasAll) return false;
      }
    }
    if (state.sunburstSelection) {
      if (state.sunburstSelection.region && site.region !== state.sunburstSelection.region) return false;
      if (state.sunburstSelection.country) {
        const matchCountry = site.countries.includes(state.sunburstSelection.country);
        if (!matchCountry) return false;
      }
      if (state.sunburstSelection.category && site.category !== state.sunburstSelection.category) return false;
    }
    return true;
  });
}

function render() {
  currentFiltered = getFilteredSites();
  updateSummary(currentFiltered);
  updateMap(currentFiltered);
  updateTimeline(currentFiltered);
  updateSunburst(currentFiltered);
  updateBrushHighlight();
}

function updateSummary(data) {
  const countries = new Set();
  data.forEach((site) => site.countries.forEach((c) => countries.add(c)));
  const dangerCount = data.filter((site) => site.danger).length;
  summaryCounts.html(
    `<div>${data.length.toLocaleString()} sites | ${countries.size} countries | ${dangerCount} In Danger</div>`
  );
}

function updateLegends() {
  const mapLegend = d3.select('#mapLegend');
  const mapItems = categoryColor
    .domain()
    .map((key) => ({ label: categoryLabels[key] ?? key, color: categoryColor(key) }));
  mapLegend
    .selectAll('span')
    .data([...mapItems, { label: 'In Danger', color: 'transparent', stroke: '#f97316' }])
    .join('span')
    .html((d) => {
      const style = d.stroke
        ? `style="border: 2px solid ${d.stroke}; width:0.9rem; height:0.9rem; border-radius:0.2rem; background:transparent;"`
        : `style="background:${d.color}"`;
      return `<i ${style}></i>${d.label}`;
    });

  const legend = d3.select('#timelineLegend');
  const keys = state.viewMode === 'category' ? categoryColor.domain() : regionColor.domain();
  const colorScale = state.viewMode === 'category' ? categoryColor : regionColor;
  const items = keys.map((key) => ({
    label: state.viewMode === 'category' ? categoryLabels[key] ?? key : key,
    color: colorScale(key)
  }));
  if (state.showDangerEvents) {
    items.push({ label: 'Added to danger list (Y)', color: dangerColors.Y });
    items.push({ label: 'Removed from danger (R)', color: dangerColors.R });
  }
  legend
    .selectAll('span')
    .data(items)
    .join('span')
    .html((d) => `<i style="background:${d.color}"></i>${d.label}`);
}

function updateBrushHighlight() {
  if (mapSiteSelection) {
    mapSiteSelection.classed('brushed', (d) => isInBrushRange(d.year));
  }
  if (timelineBarSelection) {
    timelineBarSelection.classed('brushed', (d) => isInBrushRange(d.year));
  }
}

function isInBrushRange(year) {
  if (!state.brushRange) return false;
  return year >= state.brushRange[0] && year <= state.brushRange[1];
}

function getDimensions(node) {
  const { width, height } = node.getBoundingClientRect();
  return {
    width: width || 900,
    height: height || 400
  };
}
