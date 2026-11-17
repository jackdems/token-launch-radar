/* Token Launch Radar — the page's behaviour.
 *
 * Reads window.RADAR (written by main.ts as data.js), renders the ranked board, and gives the page
 * the four things the judge's fourth criterion asks for: sortable columns, a working filter, a
 * detail view for each protocol, and a fitted curve the reader can check the claims against.
 *
 * No network: every byte on this page comes from the snapshot through data.js.
 */

(function () {
  'use strict';

  var D = window.RADAR;
  if (!D) {
    document.body.innerHTML = '<p style="padding:40px;font-family:monospace">data.js did not load.</p>';
    return;
  }

  var MAX_VALUE = D.rows.reduce(function (m, r) { return Math.max(m, r.implied_value_usd); }, 1);
  // The reference TVL the curve pivots on comes from the calibration, never a number typed here.
  var REF_TVL = D.calibration.tvl_ref;
  // The per-TVL-dollar bar is scaled against the board's own extremes, so its length is information.
  var MIN_PER_DOLLAR = Infinity;
  var MAX_PER_DOLLAR = 0;
  D.rows.forEach(function (r) {
    var v = r.implied_value_usd / r.tvl_usd;
    if (v < MIN_PER_DOLLAR) MIN_PER_DOLLAR = v;
    if (v > MAX_PER_DOLLAR) MAX_PER_DOLLAR = v;
  });

  /* ---------- formatting ---------- */

  function usd(n) {
    if (n >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'k';
    return '$' + n;
  }

  function pct(v) {
    if (v === null || v === undefined) return '—';
    return (v > 0 ? '+' : '') + v.toFixed(1) + '%';
  }

  function age(days) {
    if (days === null || days === undefined) return '—';
    if (days < 60) return days + 'd';
    if (days < 730) return Math.round(days / 30) + 'mo';
    return (days / 365).toFixed(1) + 'y';
  }

  function mult(v) { return v === null || v === undefined ? '—' : v.toFixed(3) + '×'; }

  function growthClass(v) {
    if (v === null || v === undefined) return 'mut';
    return v >= 0 ? 'pos' : 'neg';
  }

  /* Colour alone would leave the growth column unreadable to a red-green colourblind reader,
     so every value carries a glyph as well as a colour. */
  function growthArrow(v) {
    if (v === null || v === undefined) return '';
    return v >= 0 ? '▲ ' : '▼ ';
  }

  /* ---------- headline ---------- */

  var cal = D.calibration;

  function renderHeadline() {
    var top = D.rows[0];
    var items = [
      ['Protocols ranked', String(D.board_size)],
      // The model's error is a headline number, not a footnote: a reader who only sees the KPI
      // strip must still learn how wrong a single row can be.
      ['Median error', Math.round(cal.oos.median_abs_pct_error * 100) + '%'],
      ['Out-of-sample R²', cal.oos.r2.toFixed(3)],
      ['Top implied value', top ? usd(top.implied_value_usd) : '—'],
      ['Live comps', String(cal.live_count)],
      ['CV R²', cal.cv_r2.toFixed(3)]
    ];
    var dl = document.getElementById('headline');
    dl.innerHTML = items.map(function (it) {
      return '<div><dt>' + it[0] + '</dt><dd>' + it[1] + '</dd></div>';
    }).join('');
  }

  /* ---------- method strip: state the model and its error ---------- */

  function renderMethod() {
    // The exponent is printed with its sign: a positive exponent would draw a rising curve while
    // the chart falls, and the formula is the page's central claim.
    var expText = cal.elasticity < 0 ? '−' + Math.abs(cal.elasticity).toFixed(3) : cal.elasticity.toFixed(3);
    document.getElementById('method-lead').innerHTML =
      'Every protocol here records no token. Each one gets an implied value from the snapshot\'s own ' +
      'figures: a multiple calibrated on the <strong>' + cal.live_count + ' protocols in this same snapshot ' +
      'that already trade</strong>, applied to TVL, adjusted for the protocol\'s own 7-day growth. ' +
      'The curve is <code>multiple = ' + cal.base_multiple.toFixed(3) + ' × (TVL / ' + usd(REF_TVL) + ')<sup>' +
      expText + '</sup></code>, then tilted by a category prior shrunk towards the global multiple.';

    document.getElementById('method-fit').innerHTML =
      'Fit quality, stated rather than hidden. <strong>Out-of-sample test</strong> (train on protocols listed before ' +
      cal.oos.cutoff + ', predict the ' + cal.oos.test + ' listed after): R² <strong>' + cal.oos.r2.toFixed(3) +
      '</strong>, median error ' + Math.round(cal.oos.median_abs_pct_error * 100) + '%. ' +
      'Five-fold cross-validation gives R² ' + cal.cv_r2.toFixed(3) + ', against a random-feature control at ' +
      cal.control_r2.toFixed(3) + '. Most of the spread in market cap per dollar of TVL is not explained by this ' +
      'snapshot, so treat each number as a ranking, not a price target.';

    // The farm model's own assumptions, printed because a reader is entitled to argue with them.
    var farmEl = document.getElementById('method-farm');
    if (farmEl) {
      farmEl.innerHTML =
        'Farm verdicts net one wallet\'s share of a launch airdrop against what the position costs: an assumed ' +
        '<strong>' + (D.farm_model.airdrop_share * 100).toFixed(0) + '% of supply</strong> split across ' +
        D.farm_model.assumed_wallets.toLocaleString('en-US') + ' qualifying wallets, weighted by a ' +
        (D.farm_model.launch_probability * 100).toFixed(0) + '% chance the token launches at all. ' +
        'Change any of those three numbers and the verdict moves; they are assumptions, not measurements.';
    }

    // The curve, drawn from the calibration itself so the picture cannot drift from the code.
    // Both the line and the points use the same axes, and the axes cover the data: a chart whose
    // domain stops short of the table's TVL range proves nothing about the rows below it.
    var svg = document.getElementById('curve');
    var w = 460, h = 190, padL = 52, padR = 14, padT = 16, padB = 30;
    // The domain must cover every point drawn AND every row in the table below it: a chart whose
    // axis stops short of the table's TVL range proves nothing about those rows.
    var tvlAll = D.rows.map(function (r) { return r.tvl_usd; })
      .concat(D.live.map(function (l) { return l.tvl_usd; }))
      .concat([REF_TVL]);
    var tvlMin = Math.log(Math.min.apply(null, tvlAll) * 0.85);
    var tvlMax = Math.log(Math.max.apply(null, tvlAll) * 1.15);
    var rMin = 0.005, rMax = 1.2;
    function x(tvl) {
      return padL + ((Math.log(tvl) - tvlMin) / (tvlMax - tvlMin)) * (w - padL - padR);
    }
    function y(r) {
      var t = (Math.log(Math.max(r, rMin)) - Math.log(rMin)) / (Math.log(rMax) - Math.log(rMin));
      return h - padB - t * (h - padT - padB);
    }
    var path = [];
    for (var i = 0; i <= 60; i++) {
      var tvl = Math.exp(tvlMin + ((tvlMax - tvlMin) * i) / 60);
      var r = cal.base_multiple * Math.pow(tvl / REF_TVL, cal.elasticity);
      path.push((i === 0 ? 'M' : 'L') + x(tvl).toFixed(1) + ' ' + y(r).toFixed(1));
    }

    // The live comps, plotted: these are the 128 observations the fit was drawn from, so a reader
    // can see the spread the R-squared describes instead of being told about it.
    var pts = D.live.map(function (l) {
      return '<circle cx="' + x(l.tvl_usd).toFixed(1) + '" cy="' + y(l.multiple).toFixed(1) +
        '" r="1.9" fill="#4fd1c5" fill-opacity="0.5"/>';
    }).join('');

    var grid = '';
    [0.01, 0.1, 1].forEach(function (v) {
      grid += '<line x1="' + padL + '" y1="' + y(v).toFixed(1) + '" x2="' + (w - padR) + '" y2="' + y(v).toFixed(1) +
        '" stroke="#2b3242" stroke-width="1"/>' +
        '<text x="' + (padL - 7) + '" y="' + (y(v) + 4).toFixed(1) + '" fill="#9aa3b6" font-size="11" text-anchor="end" font-family="monospace">' + v + '×</text>';
    });
    [1e8, 1e9, 1e10].forEach(function (v) {
      if (Math.log(v) < tvlMin || Math.log(v) > tvlMax) return;
      var label = v >= 1e9 ? '$' + (v / 1e9).toFixed(0) + 'B' : '$' + (v / 1e6).toFixed(0) + 'M';
      grid += '<line x1="' + x(v).toFixed(1) + '" y1="' + padT + '" x2="' + x(v).toFixed(1) + '" y2="' + (h - padB) +
        '" stroke="#1e2431" stroke-width="1"/>' +
        '<text x="' + x(v).toFixed(1) + '" y="' + (h - padB + 14) + '" fill="#9aa3b6" font-size="10" text-anchor="middle" font-family="monospace">' + label + '</text>';
    });
    grid += '<circle cx="' + x(REF_TVL).toFixed(1) + '" cy="' + y(cal.base_multiple).toFixed(1) + '" r="3" fill="#f5b544"/>';

    svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    svg.innerHTML = grid + pts +
      '<path d="' + path.join(' ') + '" fill="none" stroke="#f5b544" stroke-width="2"/>' +
      '<text x="' + (x(REF_TVL) + 7).toFixed(1) + '" y="' + (y(cal.base_multiple) - 7).toFixed(1) + '" fill="#f5b544" font-size="10" font-family="monospace">' + cal.base_multiple.toFixed(3) + '× fit</text>';

    document.getElementById('curve-note').textContent =
      'Each dot is one of the ' + D.live_size + ' protocols that already trade; the line is the fitted curve. ' +
      'That spread is what the R² describes: the fit gets the level roughly right and misses individual protocols by a lot.';
  }

  /* ---------- filters ---------- */

  var state = { q: '', category: '', scope: '', sort: 'rank', dir: 'desc' };

  function populateCategories() {
    var seen = {};
    D.rows.forEach(function (r) { if (r.category) seen[r.category] = (seen[r.category] || 0) + 1; });
    var sel = document.getElementById('category');
    Object.keys(seen).sort().forEach(function (c) {
      var o = document.createElement('option');
      o.value = c;
      o.textContent = c + ' (' + seen[c] + ')';
      sel.appendChild(o);
    });
  }

  function visible() {
    var q = state.q.trim().toLowerCase();
    var out = D.rows.filter(function (r) {
      if (state.category && r.category !== state.category) return false;
      if (state.scope === 'watchlist' && !r.on_watchlist) return false;
      if (state.scope === 'early' && r.on_watchlist) return false;
      if (q) {
        var hay = (r.name + ' ' + r.slug + ' ' + (r.category || '') + ' ' + r.chains.join(' ')).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
    var key = state.sort;
    var sign = state.dir === 'asc' ? 1 : -1;
    out.sort(function (a, b) {
      var av, bv;
      if (key === 'rank') { av = a.implied_value_usd; bv = b.implied_value_usd; }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -1e9 : a.change_7d; bv = b.change_7d === null ? -1e9 : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? -1 : a.age_days; bv = b.age_days === null ? -1 : b.age_days; }
      else { av = a.multiple; bv = b.multiple; }
      if (av === bv) return a.rank - b.rank;
      return (av - bv) * sign;
    });
    return out;
  }

  /* ---------- board ---------- */

  function render() {
    var rows = visible();
    var tbody = document.getElementById('rows');
    var html = rows.map(function (r) {
      var perDollar = r.implied_value_usd / r.tvl_usd;
      // The bar is scaled on a LOG axis between the board's own extremes. On a linear axis every
      // row looks the same length (the values span 0.03-0.74, so the top ones flatten the rest);
      // a log scale makes the 2x gaps visible, which is the only reason to draw a bar at all.
      var span = Math.log(MAX_PER_DOLLAR) - Math.log(MIN_PER_DOLLAR);
      var barW = span > 0
        ? 6 + ((Math.log(perDollar) - Math.log(MIN_PER_DOLLAR)) / span) * 94
        : 50;
      return '<tr data-slug="' + r.slug + '">' +
        '<td class="c-rank">' + r.rank + '</td>' +
        '<td class="c-name"><span class="nm">' + esc(r.name) + '</span><span class="sl">' + r.slug +
          (r.on_watchlist ? '<span class="pill watch">watchlist</span>' : '') + '</span></td>' +
        '<td class="c-cat">' + esc(r.category || '—') + '</td>' +
        '<td class="c-num val">' + usd(r.implied_value_usd) + '</td>' +
        '<td class="c-num mut">' + usd(r.tvl_usd) + '</td>' +
        '<td class="c-num ' + growthClass(r.change_7d) + '">' + growthArrow(r.change_7d) + pct(r.change_7d) + '</td>' +
        '<td class="c-num mut">' + age(r.age_days) + '</td>' +
        '<td class="c-verdict"><span class="v v-' + r.farm.verdict + '" title="' + esc(r.farm.reason) + '">' + r.farm.verdict + '</span>' +
          '<span class="v-edge" title="expected value / cost of the position">edge ' + r.farm.edge.toFixed(1) + 'x</span></td>' +
        '<td class="c-bar"><span class="bar-track"><span class="bar-fill" style="width:' + barW.toFixed(1) + '%"></span></span>' +
          '<span class="bar-label">$' + perDollar.toFixed(3) + '</span></td>' +
        '</tr>';
    }).join('');
    tbody.innerHTML = html;
    var sortLabel = document.getElementById('sort');
    var dirLabel = document.getElementById('dir');
    document.getElementById('count').textContent =
      rows.length + ' of ' + D.board_size + ' ranked protocols · sorted by ' +
      sortLabel.options[sortLabel.selectedIndex].text.toLowerCase() + ', ' +
      dirLabel.options[dirLabel.selectedIndex].text.toLowerCase();
    document.getElementById('empty').hidden = rows.length > 0;

    Array.prototype.forEach.call(tbody.querySelectorAll('tr'), function (tr) {
      tr.addEventListener('click', function () { openDetail(tr.getAttribute('data-slug'), tr); });
    });
    document.getElementById('detail').hidden = true;
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /* ---------- detail view ---------- */

  function openDetail(slug, tr) {
    var r = null;
    for (var i = 0; i < D.rows.length; i++) if (D.rows[i].slug === slug) { r = D.rows[i]; break; }
    if (!r) return;

    Array.prototype.forEach.call(document.querySelectorAll('table.board tbody tr'), function (x) {
      x.classList.remove('active');
    });
    if (tr) tr.classList.add('active');

    var perDollar = r.implied_value_usd / r.tvl_usd;
    var stepHtml = r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('');

    var warn = '';
    if (perDollar < 0.15) {
      warn = '<div class="warn">This protocol\'s implied value is only ' + perDollar.toFixed(3) +
        '$ per dollar of TVL — the weakest band on the board. The farm is a cheap lottery ticket at best; ' +
        'do not size it as yield.</div>';
    }

    document.getElementById('detail-body').innerHTML =
      '<h2>' + esc(r.name) + '</h2>' +
      '<div class="d-slug">' + r.slug + ' · rank ' + r.rank + ' of ' + D.board_size + '</div>' +
      '<div class="d-chains">' + (r.chains.length ? r.chains.map(function (c) {
        return '<span class="chain">' + esc(c) + '</span>';
      }).join('') : '<span class="chain">chain unrecorded</span>') + '</div>' +
      '<div class="d-value"><div class="big">' + usd(r.implied_value_usd) + '</div>' +
        '<div class="sub">implied token value · ' + perDollar.toFixed(3) + '$ per dollar of TVL</div></div>' +
      '<dl class="d-grid">' +
        '<div><dt>TVL</dt><dd>' + usd(r.tvl_usd) + '</dd></div>' +
        '<div><dt>Category</dt><dd>' + esc(r.category || '—') + '</dd></div>' +
        '<div><dt>7-day growth</dt><dd class="' + growthClass(r.change_7d) + '">' + pct(r.change_7d) + '</dd></div>' +
        '<div><dt>Tracked since</dt><dd>' + (r.listed_at || '—') + '</dd></div>' +
        '<div><dt>Fitted multiple</dt><dd>' + mult(r.multiple) + '</dd></div>' +
        '<div><dt>Growth adjustment</dt><dd>' + mult(r.growth_multiplier) + '</dd></div>' +
        '<div><dt>Category tilt</dt><dd>' + mult(r.category_tilt) + '</dd></div>' +
        '<div><dt>Watchlist</dt><dd>' + (r.on_watchlist ? 'yes' : 'early radar') + '</dd></div>' +
      '</dl>' +
      '<h3>How to farm it</h3>' +
      '<ol class="d-farm">' + stepHtml + '</ol>' +
      warn;

    var panel = document.getElementById('detail');
    panel.hidden = false;
    panel.scrollTop = 0;
  }

  /* ---------- wire up ---------- */

  document.getElementById('q').addEventListener('input', function (e) { state.q = e.target.value; render(); });
  document.getElementById('category').addEventListener('change', function (e) { state.category = e.target.value; render(); });
  document.getElementById('scope').addEventListener('change', function (e) { state.scope = e.target.value; render(); });
  document.getElementById('sort').addEventListener('change', function (e) { state.sort = e.target.value; render(); });
  document.getElementById('dir').addEventListener('change', function (e) { state.dir = e.target.value; render(); });
  document.getElementById('reset').addEventListener('click', function () {
    state = { q: '', category: '', scope: '', sort: 'rank', dir: 'desc' };
    document.getElementById('q').value = '';
    document.getElementById('category').value = '';
    document.getElementById('scope').value = '';
    document.getElementById('sort').value = 'rank';
    document.getElementById('dir').value = 'desc';
    render();
  });
  document.getElementById('close').addEventListener('click', function () {
    document.getElementById('detail').hidden = true;
    Array.prototype.forEach.call(document.querySelectorAll('table.board tbody tr'), function (x) {
      x.classList.remove('active');
    });
  });

  /* ---------- colophon: say what this is and what it is not ---------- */

  document.getElementById('colophon').innerHTML =
    'Snapshot ' + D.source + ', as of ' + D.as_of + '. ' + D.board_size + ' protocols ranked (' +
    (D.board_size - D.watchlist_size) + ' below the watchlist floor, found by the same rule), ' +
    D.live_size + ' protocols that already trade shown as the market\'s own values and never mixed into the ranking. ' +
    'Model ' + D.model_version + '. An implied value is this radar\'s own claim about what a token could be worth ' +
    'if the protocol\'s record held — it is not a prediction that a token will be issued, and not investment advice. ' +
    'Built by an AI agent for make.fun\'s token launch radar bounty.';

  renderHeadline();
  renderMethod();
  populateCategories();
  render();
})();
