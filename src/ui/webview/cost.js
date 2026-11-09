/**
 * Cost & Usage — Webview script.
 *
 * The same two rules as the providers panel: nothing is written with
 * `innerHTML`, and nothing is calculated here. Every figure arrives formatted,
 * including the words "Unavailable" for a total that could not be established —
 * this script has no path by which an unknown cost could become "$0.00", because
 * it never converts a number into a currency string.
 */

(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const root = document.getElementById('root');
  let latest = null;

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || message.type !== 'state') {
      return;
    }
    latest = message.view;
    render();
  });

  vscode.postMessage({ type: 'ready' });

  /* ---------------------------------------------------------------------- */

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined && text !== null) {
      node.textContent = String(text);
    }
    return node;
  }

  function button(label, message, className) {
    const node = el('button', `pp-button ${className || ''}`.trim(), label);
    node.type = 'button';
    node.addEventListener('click', () => vscode.postMessage(message));
    return node;
  }

  function section(title, subtitle) {
    const node = el('section', 'pp-section');
    const head = el('div', 'pp-section-head');
    head.appendChild(el('h2', 'pp-section-title', title));
    node.appendChild(head);
    if (subtitle) {
      node.appendChild(el('p', 'pp-section-subtitle', subtitle));
    }
    return node;
  }

  function render() {
    if (!latest) {
      return;
    }
    root.setAttribute('aria-busy', 'false');
    root.replaceChildren();

    root.appendChild(header(latest));

    if (latest.isEmpty) {
      root.appendChild(emptyState(latest));
      return;
    }

    root.appendChild(totalsSection(latest));
    root.appendChild(budgetSection(latest));
    root.appendChild(breakdownSection(latest));
    root.appendChild(historySection(latest));
    root.appendChild(recentSection(latest));
    root.appendChild(footer(latest));
  }

  /* ---------------------------------------------------------------------- */

  function header(view) {
    const node = el('header', 'pp-header');
    const left = el('div');
    left.appendChild(el('h1', 'pp-title', 'Cost & Usage'));
    left.appendChild(
      el(
        'p',
        'pp-subtitle',
        `${view.meta.retained} of the last ${view.meta.capacity} requests are retained.` +
          (view.meta.truncated
            ? ' Older requests have been dropped, so totals below do not cover all of PairPilot’s history.'
            : '')
      )
    );
    node.appendChild(left);

    const actions = el('div', 'pp-header-actions');

    const rangeWrap = el('label', 'pp-select-wrap');
    rangeWrap.appendChild(el('span', 'pp-field-label', 'History'));
    const select = el('select', 'pp-select');
    for (const days of [7, 30, 90]) {
      const option = el('option', null, `Last ${days} days`);
      option.value = String(days);
      if (days === view.meta.rangeDays) {
        option.selected = true;
      }
      select.appendChild(option);
    }
    select.addEventListener('change', () =>
      vscode.postMessage({ type: 'selectRange', days: Number(select.value) })
    );
    rangeWrap.appendChild(select);
    actions.appendChild(rangeWrap);

    const clear = el('button', 'pp-button pp-button-danger', 'Clear history');
    clear.type = 'button';
    clear.addEventListener('click', () => {
      const confirmed = window.confirm(
        'Erase PairPilot’s recorded usage history?\n\nThis deletes the local record of requests, tokens and costs. It does not affect anything at OpenRouter, and it cannot be undone.'
      );
      if (confirmed) {
        vscode.postMessage({ type: 'clearHistory' });
      }
    });
    actions.appendChild(clear);

    node.appendChild(actions);
    return node;
  }

  function emptyState(view) {
    const node = section('No usage recorded yet', null);
    node.appendChild(
      el(
        'p',
        'pp-note',
        'PairPilot records one row per completed AI request. Nothing has been recorded yet, so there is nothing to total — this is not a cost of zero.'
      )
    );
    node.appendChild(
      el(
        'p',
        'pp-note',
        'If you are using the Claude Code CLI, PairPilot records a row when the CLI reports its own usage figures. A request whose usage the provider did not report is recorded as unpriced rather than as free.'
      )
    );
    node.appendChild(el('p', 'pp-disclaimer', view.meta.disclaimer));
    return node;
  }

  /* ---------------------------------------------------------------------- */

  function totalsSection(view) {
    const node = section(
      'Totals',
      'Every figure below is taken from PairPilot’s own record of requests. Nothing here is derived from a model’s identity or a price list at display time.'
    );

    const tiles = el('div', 'pp-tiles');
    tiles.appendChild(tile('Total cost', view.totals.costLabel, view.totals.costNote));
    tiles.appendChild(tile('Requests', String(view.totals.requests), null));
    tiles.appendChild(tile('Input tokens', view.totals.inputLabel, null));
    tiles.appendChild(tile('Output tokens', view.totals.outputLabel, null));
    tiles.appendChild(tile('Cached input tokens', view.totals.cachedLabel, 'A subset of the input tokens, billed at the cache-read rate.'));
    if (view.totals.reasoningTokens > 0) {
      tiles.appendChild(tile('Reasoning tokens', view.totals.reasoningLabel, null));
    }
    tiles.appendChild(tile('Time in requests', view.totals.durationLabel, null));
    node.appendChild(tiles);

    const counts = el('div', 'pp-fields');
    counts.appendChild(field('Reported by the provider', String(view.totals.reportedRequests)));
    counts.appendChild(field('Estimated from catalogue prices', String(view.totals.estimatedRequests)));
    counts.appendChild(field('Could not be priced', String(view.totals.unpricedRequests)));
    node.appendChild(counts);

    const sessionTiles = el('div', 'pp-tiles');
    sessionTiles.appendChild(tile('This session', view.session.costLabel, view.session.costNote));
    sessionTiles.appendChild(tile('Session requests', String(view.session.requests), null));
    if (view.project) {
      sessionTiles.appendChild(tile('This project', view.project.costLabel, view.project.costNote));
    }
    node.appendChild(sessionTiles);

    return node;
  }

  function tile(label, value, note) {
    const node = el('div', 'pp-tile');
    node.appendChild(el('span', 'pp-tile-label', label));
    node.appendChild(el('span', 'pp-tile-value', value));
    if (note) {
      node.appendChild(el('span', 'pp-tile-note', note));
    }
    return node;
  }

  function field(label, value) {
    const row = el('div', 'pp-field');
    row.appendChild(el('span', 'pp-field-label', label));
    row.appendChild(el('span', 'pp-field-value', value));
    return row;
  }

  /* ---------------------------------------------------------------------- */

  function budgetSection(view) {
    const budget = view.budget;
    const node = section('Budget', null);

    const tiles = el('div', 'pp-tiles');
    tiles.appendChild(tile('Limit', budget.limitLabel, null));
    tiles.appendChild(tile('Spent this session', budget.sessionLabel, null));
    node.appendChild(tiles);

    if (budget.widthPercent !== null) {
      const bar = el('div', 'pp-bar');
      const fill = el('div', `pp-bar-fill${budget.exceeded ? ' pp-bar-over' : ''}`);
      fill.style.width = `${budget.widthPercent}%`;
      bar.appendChild(fill);
      node.appendChild(bar);
    }

    node.appendChild(el('p', budget.exceeded ? 'pp-warning' : 'pp-note', budget.note));
    return node;
  }

  /* ---------------------------------------------------------------------- */

  function breakdownSection(view) {
    const node = section('Cost by model, provider and role', null);
    node.appendChild(groupTable('By model', view.byModel));
    node.appendChild(groupTable('By provider', view.byProvider));
    node.appendChild(groupTable('By role', view.byRole));
    return node;
  }

  function groupTable(title, groups) {
    const wrap = el('div');
    wrap.appendChild(el('h3', 'pp-subhead', title));
    if (groups.length === 0) {
      wrap.appendChild(el('p', 'pp-note', 'Nothing recorded.'));
      return wrap;
    }

    const table = el('table', 'pp-table');
    const head = el('thead');
    const headRow = el('tr');
    for (const label of ['Name', 'Requests', 'Tokens', 'Cost']) {
      headRow.appendChild(el('th', label === 'Cost' || label === 'Requests' ? 'pp-num' : null, label));
    }
    head.appendChild(headRow);
    table.appendChild(head);

    const body = el('tbody');
    for (const group of groups) {
      const row = el('tr');
      row.appendChild(el('td', null, group.label));
      row.appendChild(el('td', 'pp-num', String(group.requests)));
      row.appendChild(el('td', 'pp-num', group.tokensLabel));
      const cost = el('td', 'pp-num', group.costLabel);
      if (group.costUnknown) {
        cost.title = 'No request in this group carried a usable cost.';
      }
      row.appendChild(cost);
      body.appendChild(row);
    }
    table.appendChild(body);
    wrap.appendChild(table);
    return wrap;
  }

  /* ---------------------------------------------------------------------- */

  function historySection(view) {
    const node = section(
      'Daily spend',
      'One bar per day over the selected range. A day with no bar had no requests — that is different from a day whose cost could not be established.'
    );

    const bars = el('div', 'pp-chart');
    let anyUnknown = false;
    for (const bar of view.history) {
      const column = el('div', 'pp-bar-col');
      column.title = `${bar.label}: ${bar.requests} request${bar.requests === 1 ? '' : 's'}, ${bar.costLabel}`;

      const track = el('div', 'pp-bar-track');
      if (bar.heightPercent === null) {
        if (bar.requests > 0) {
          anyUnknown = true;
          // Height is unknown, so the bar is drawn as unknown rather than as
          // zero-height: a zero-height bar would read as "this day was free".
          // The fill is full-height hatching, so it is the whole track.
          track.appendChild(el('div', 'pp-bar-fill pp-bar-unknown'));
        }
      } else {
        const fill = el('div', 'pp-bar-fill');
        // The host floors this at 2% for a day with spend, so the bar is never
        // invisible. The panel only places the figure it was given.
        fill.style.height = `${bar.heightPercent}%`;
        track.appendChild(fill);
      }
      column.appendChild(track);
      column.appendChild(el('span', 'pp-bar-label', bar.label));
      bars.appendChild(column);
    }
    node.appendChild(bars);

    if (anyUnknown) {
      node.appendChild(
        el(
          'p',
          'pp-note',
          'A hatched bar marks a day with requests whose cost could not be established. It is shown as unknown rather than as zero.'
        )
      );
    }
    return node;
  }

  /* ---------------------------------------------------------------------- */

  function recentSection(view) {
    const node = section('Recent requests', 'Newest first. Each row is one completed AI request.');

    const table = el('table', 'pp-table pp-table-recent');
    const head = el('thead');
    const headRow = el('tr');
    for (const label of ['When', 'Model', 'Role', 'Task', 'In', 'Out', 'Cached', 'Time', 'Cost']) {
      headRow.appendChild(el('th', null, label));
    }
    head.appendChild(headRow);
    table.appendChild(head);

    const body = el('tbody');
    for (const record of view.recent) {
      const row = el('tr');
      row.appendChild(el('td', 'pp-nowrap', record.atLabel));
      row.appendChild(el('td', 'pp-model-cell', record.modelLabel));
      row.appendChild(el('td', null, record.roleLabel));
      row.appendChild(el('td', 'pp-task-cell', record.task || '—'));
      row.appendChild(el('td', 'pp-num', record.inputLabel));
      row.appendChild(el('td', 'pp-num', record.outputLabel));
      row.appendChild(el('td', 'pp-num', record.cachedLabel));
      row.appendChild(el('td', 'pp-num', record.durationLabel));

      const costCell = el('td', 'pp-num');
      costCell.appendChild(el('span', null, record.costLabel));
      if (record.costSource !== 'reported') {
        const marker = el(
          'span',
          'pp-cost-source',
          record.costSource === 'estimated' ? 'est.' : 'n/a'
        );
        marker.title =
          record.costNote ||
          (record.costSource === 'estimated'
            ? 'Estimated from the catalogue prices in force when the request was made.'
            : 'The provider reported no cost and no price was available.');
        costCell.appendChild(marker);
      }
      row.appendChild(costCell);

      body.appendChild(row);
    }
    table.appendChild(body);
    node.appendChild(table);

    if (view.recent.length === 0) {
      node.appendChild(el('p', 'pp-note', 'No requests recorded yet.'));
    }
    return node;
  }

  function footer(view) {
    const node = el('footer', 'pp-footer');
    node.appendChild(el('p', 'pp-disclaimer', view.meta.disclaimer));
    node.appendChild(
      el(
        'p',
        'pp-note',
        `Showing ${view.meta.retained} retained requests. PairPilot stores usage on this machine only; it is never sent anywhere.`
      )
    );
    return node;
  }
})();
