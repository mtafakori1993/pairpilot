/**
 * AI Providers & Models — Webview script.
 *
 * Two rules govern everything here.
 *
 *  1. **No `innerHTML`, anywhere.** The model catalogue is remote data: names,
 *     descriptions and vendor strings come from OpenRouter. Every value is
 *     placed with `textContent`, so a description containing markup is rendered
 *     as the text it is. The CSP already blocks inline script; this makes the
 *     panel safe by construction rather than by one header being correct.
 *  2. **No arithmetic and no formatting.** Prices, token counts and dates arrive
 *     already formatted by the extension host. This script lays out strings. It
 *     cannot round a cost to zero, and it cannot turn an unknown value into a
 *     figure, because it never sees a number it might mis-handle.
 *
 * The panel holds exactly one piece of state of its own — the search box's text
 * while the developer is typing — so that a snapshot arriving mid-keystroke
 * cannot delete characters out from under them.
 */

(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  /** The search box's local value. The snapshot's copy lags behind a keystroke. */
  let localSearch = null;
  let searchFocused = false;
  let debounceTimer = null;
  let latest = null;

  const root = document.getElementById('root');

  /**
   * The tooltip that travels with every fit score.
   *
   * A percentage beside a model name reads as a grade of the model. It is
   * nothing of the kind: it orders a shortlist against the requirements printed
   * above it, from catalogue metadata alone. The Model Advisor's disclaimer is
   * rendered next to these scores; this is what says so on hover.
   */
  const SCORE_TITLE =
    'Fit against the requirements listed for this task, computed from catalogue metadata. Not a measure of output quality.';

  /* ---------------------------------------------------------------------- */
  /* Messaging                                                              */
  /* ---------------------------------------------------------------------- */

  function post(message) {
    vscode.postMessage(message);
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || message.type !== 'state') {
      return;
    }
    latest = message.snapshot;
    if (localSearch === null) {
      localSearch = latest.query.search;
    }
    render();
  });

  post({ type: 'ready' });

  /* ---------------------------------------------------------------------- */
  /* DOM helpers                                                            */
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

  /** A button that posts a message when clicked. */
  function button(label, message, className) {
    const node = buttonEl(label, className);
    node.addEventListener('click', () => post(message));
    return node;
  }

  /**
   * A button with no handler yet.
   *
   * Destructive actions need to confirm *before* anything is posted, and a
   * button that already posts on click cannot be made to wait by adding a second
   * listener — both would fire. So the handler is attached by the caller in
   * exactly one place.
   */
  function buttonEl(label, className) {
    const node = el('button', `pp-button ${className || ''}`.trim(), label);
    node.type = 'button';
    return node;
  }

  function badge(label, kind) {
    return el('span', `pp-badge pp-badge-${kind}`, label);
  }

  /** A fit score, with the sentence that stops it being read as a grade. */
  function scoreBadge(label) {
    const node = badge(label, 'muted');
    node.title = SCORE_TITLE;
    return node;
  }

  function section(title, subtitle) {
    const node = el('section', 'pp-section');
    const head = el('div', 'pp-section-head');
    head.appendChild(el('h2', 'pp-section-title', title));
    if (subtitle) {
      head.appendChild(el('p', 'pp-section-subtitle', subtitle));
    }
    node.appendChild(head);
    return node;
  }

  function labelled(label, value) {
    const row = el('div', 'pp-field');
    row.appendChild(el('span', 'pp-field-label', label));
    row.appendChild(el('span', 'pp-field-value', value === null ? 'Not provided' : value));
    return row;
  }

  /* ---------------------------------------------------------------------- */
  /* Render                                                                 */
  /* ---------------------------------------------------------------------- */

  function render() {
    if (!latest) {
      return;
    }
    root.setAttribute('aria-busy', 'false');
    root.replaceChildren();

    root.appendChild(header(latest));
    if (latest.notice) {
      root.appendChild(noticeBar(latest.notice));
    }

    const grid = el('div', 'pp-grid');
    const main = el('div', 'pp-main');
    main.appendChild(providersSection(latest));
    main.appendChild(selectionSection(latest));
    main.appendChild(explorerSection(latest));
    main.appendChild(advisorSection(latest));
    grid.appendChild(main);

    if (latest.details) {
      grid.appendChild(detailsPane(latest.details));
    }
    root.appendChild(grid);

    if (searchFocused) {
      const input = document.getElementById('pp-search');
      if (input) {
        input.focus();
        const end = input.value.length;
        input.setSelectionRange(end, end);
      }
    }
  }

  function header(snapshot) {
    const node = el('header', 'pp-header');
    const left = el('div');
    left.appendChild(el('h1', 'pp-title', 'AI Providers & Models'));

    const catalog = snapshot.catalog;
    let line;
    if (catalog.count === 0) {
      line =
        catalog.error !== null
          ? `Model catalogue: not available. ${catalog.error}`
          : 'Model catalogue: not loaded yet.';
    } else {
      line = `Model catalogue: ${catalog.countLabel} models, loaded ${catalog.ageLabel}.`;
      if (catalog.stale) {
        line += ' These entries are from a previous refresh.';
      }
    }
    left.appendChild(el('p', 'pp-subtitle', line));
    node.appendChild(left);

    const actions = el('div', 'pp-header-actions');
    actions.appendChild(button('Refresh catalogue', { type: 'refreshCatalog' }));
    actions.appendChild(button('Get an OpenRouter key', { type: 'openExternal', target: 'keys' }, 'pp-button-quiet'));
    node.appendChild(actions);
    return node;
  }

  function noticeBar(notice) {
    return el('div', `pp-notice pp-notice-${notice.level}`, notice.text);
  }

  /* ---------------------------------------------------------------------- */
  /* Providers                                                              */
  /* ---------------------------------------------------------------------- */

  function providersSection(snapshot) {
    const node = section(
      'Providers',
      'PairPilot runs its turns on one provider at a time. Switching providers does not change which models are recommended — the Model Advisor reads the catalogue, not the active provider.'
    );
    const list = el('div', 'pp-provider-list');
    for (const provider of snapshot.providers) {
      list.appendChild(providerCard(provider));
    }
    node.appendChild(list);
    return node;
  }

  function providerCard(provider) {
    const card = el('article', 'pp-card' + (provider.isActive ? ' pp-card-active' : ''));
    const head = el('div', 'pp-card-head');
    head.appendChild(el('h3', 'pp-card-title', provider.label));
    if (provider.isActive) {
      head.appendChild(badge('Active', 'ok'));
    } else if (!provider.enabled) {
      head.appendChild(badge('Switched off', 'muted'));
    }
    if (!provider.available && provider.selectable) {
      head.appendChild(badge('Unavailable', 'warn'));
    }
    card.appendChild(head);
    card.appendChild(el('p', 'pp-card-description', provider.description));

    card.appendChild(el('p', 'pp-status', provider.statusMessage));

    const fields = el('div', 'pp-fields');
    fields.appendChild(labelled('Base URL', provider.baseUrl));
    if (provider.controls.apiKey) {
      fields.appendChild(labelled('API key', provider.maskedKey));
      fields.appendChild(labelled('Authentication', authLabel(provider.authState)));
      fields.appendChild(labelled('Connection', connectionLabel(provider.connectionState)));
      if (provider.account) {
        // Every figure here arrived formatted. A key with no limit shows no
        // limit line at all, rather than a limit of "Unavailable", which would
        // describe a key without a cap as a fact nobody knows.
        const account = provider.account;
        if (account.keyLabel) {
          fields.appendChild(labelled('Key', account.keyLabel));
        }
        fields.appendChild(labelled('Key usage', account.usageLabel));
        if (account.limitLabel) {
          fields.appendChild(labelled('Key limit', account.limitLabel));
        }
        if (account.limitRemainingLabel) {
          fields.appendChild(labelled('Limit remaining', account.limitRemainingLabel));
        }
        if (account.limitReset) {
          fields.appendChild(labelled('Limit resets', account.limitReset));
        }
        if (account.planLabel) {
          fields.appendChild(labelled('Plan', account.planLabel));
        }
        fields.appendChild(labelled('Account figures read', account.fetchedAtLabel));
      }
    }
    if (provider.controls.catalog) {
      fields.appendChild(labelled('Catalogue', provider.catalogModelCountLabel));
    }
    card.appendChild(fields);

    if (provider.lastConnectionError) {
      card.appendChild(el('p', 'pp-warning', provider.lastConnectionError));
    }

    const actions = el('div', 'pp-actions');

    if (provider.controls.apiKey) {
      actions.appendChild(
        button(provider.hasStoredKey ? 'Replace API key' : 'Set API key', { type: 'setApiKey' })
      );
      const test = button('Test connection', { type: 'testConnection' });
      test.disabled = !provider.hasStoredKey;
      actions.appendChild(test);
      if (provider.hasStoredKey) {
        // Confirmed first, posted second. Nothing is deleted on a stray click.
        const clear = buttonEl('Disconnect', 'pp-button-danger');
        clear.addEventListener('click', () => {
          const confirmed = window.confirm(
            'Remove the stored OpenRouter API key?\n\nThe key is deleted from VS Code\'s encrypted secret storage. PairPilot cannot recover it, and you would need to paste it again.'
          );
          if (confirmed) {
            post({ type: 'clearApiKey' });
          }
        });
        actions.appendChild(clear);
      }
      actions.appendChild(button('Check credits', { type: 'openExternal', target: 'credits' }, 'pp-button-quiet'));
      actions.appendChild(button('View usage', { type: 'openExternal', target: 'usage' }, 'pp-button-quiet'));
    }

    if (provider.controls.disable) {
      actions.appendChild(
        button(
          provider.enabled ? 'Switch off' : 'Switch on',
          { type: 'setProviderEnabled', providerId: provider.id, enabled: !provider.enabled },
          'pp-button-quiet'
        )
      );
    }

    if (!provider.isActive && provider.selectable) {
      actions.appendChild(
        button('Use this provider', { type: 'selectProvider', providerId: provider.id }, 'pp-button-primary')
      );
    }

    card.appendChild(actions);
    return card;
  }

  function authLabel(state) {
    switch (state) {
      case 'valid':
        return 'Key stored and accepted by the provider';
      case 'stored':
        return 'Key stored, not yet verified';
      case 'invalid':
        return 'Key stored, rejected by the provider';
      default:
        return 'No key stored';
    }
  }

  function connectionLabel(state) {
    switch (state) {
      case 'connected':
        return 'Connected';
      case 'connecting':
        return 'Checking…';
      case 'error':
        return 'Last attempt failed';
      default:
        return 'Not tested yet';
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Selection                                                              */
  /* ---------------------------------------------------------------------- */

  function selectionSection(snapshot) {
    const selection = snapshot.selection;
    const resolved = selection.resolved;
    const subtitle = resolved.isProviderDefault
      ? 'No model is selected for coding, so the provider’s own default applies. PairPilot never substitutes a model on its own.'
      : `Coding turns currently resolve to ${resolved.modelName || resolved.modelId} (${resolved.sourceLabel}).`;

    const node = section('Model selection', subtitle);

    if (snapshot.activeProviderId === 'claude-code') {
      node.appendChild(
        el(
          'p',
          'pp-note',
          'The active provider is the Claude Code CLI, which chooses its own model. The selections below apply when a remote provider such as OpenRouter is active.'
        )
      );
    }

    for (const dangling of selection.dangling) {
      node.appendChild(
        el(
          'p',
          'pp-warning',
          `${dangling.where} points at "${dangling.modelId}", which is not in the current catalogue. The next turn on a remote provider would fail with an unknown-model error until you choose another model.`
        )
      );
    }

    const table = el('table', 'pp-table');
    const head = el('thead');
    const headRow = el('tr');
    for (const label of ['Level', 'Model', 'Read by']) {
      headRow.appendChild(el('th', null, label));
    }
    head.appendChild(headRow);
    table.appendChild(head);

    const body = el('tbody');
    for (const level of selection.levels) {
      const row = el('tr');
      row.appendChild(el('td', null, level.label));
      const modelCell = el('td');
      if (level.modelId === null) {
        modelCell.appendChild(el('span', 'pp-muted', 'Provider default'));
      } else {
        modelCell.appendChild(el('span', null, level.modelName || level.modelId));
        if (!level.modelName) {
          modelCell.appendChild(el('span', 'pp-muted', ' (not in the catalogue)'));
        }
      }
      row.appendChild(modelCell);
      const consumerCell = el('td');
      if (level.consumerLabel) {
        consumerCell.appendChild(el('span', null, level.consumerLabel));
      } else {
        consumerCell.appendChild(el('span', 'pp-muted', 'No workflow yet'));
      }
      row.appendChild(consumerCell);

      const actionCell = el('td', 'pp-cell-actions');
      if (level.modelId !== null) {
        const clear = el('button', 'pp-link', 'Clear');
        clear.type = 'button';
        clear.addEventListener('click', () =>
          post({ type: 'clearSelection', level: level.level, key: level.key })
        );
        actionCell.appendChild(clear);
      }
      row.appendChild(actionCell);
      body.appendChild(row);
    }
    table.appendChild(body);
    node.appendChild(table);

    node.appendChild(
      el(
        'p',
        'pp-note',
        'Column three names the PairPilot workflow that reads each level today. Roles with no reader are stored preferences: PairPilot has no Planning or Coding Studio screen, so nothing acts on them yet.'
      )
    );
    return node;
  }

  /* ---------------------------------------------------------------------- */
  /* Model Explorer                                                         */
  /* ---------------------------------------------------------------------- */

  function explorerSection(snapshot) {
    const node = section(
      'Model Explorer',
      'Every field below comes from the model catalogue. A blank or "not provided" value means the catalogue did not publish it — PairPilot does not fill gaps with guesses.'
    );

    const query = snapshot.query;

    const controls = el('div', 'pp-controls');

    const search = el('input', 'pp-input');
    search.id = 'pp-search';
    search.type = 'search';
    search.placeholder = 'Search name, id, developer or description';
    search.value = localSearch === null ? query.search : localSearch;
    search.setAttribute('aria-label', 'Search models');
    search.addEventListener('focus', () => {
      searchFocused = true;
    });
    search.addEventListener('blur', () => {
      searchFocused = false;
    });
    search.addEventListener('input', () => {
      localSearch = search.value;
      if (debounceTimer !== null) {
        window.clearTimeout(debounceTimer);
      }
      // Debounced so a fast typist sends one message rather than one per key.
      debounceTimer = window.setTimeout(() => {
        debounceTimer = null;
        sendQuery({ search: localSearch });
      }, 180);
    });
    controls.appendChild(search);

    const sortWrap = el('label', 'pp-select-wrap');
    sortWrap.appendChild(el('span', 'pp-field-label', 'Sort'));
    const sort = el('select', 'pp-select');
    for (const option of snapshot.sorts) {
      const item = el('option', null, option.label);
      item.value = option.id;
      if (option.id === query.sort) {
        item.selected = true;
      }
      sort.appendChild(item);
    }
    sort.addEventListener('change', () => sendQuery({ sort: sort.value }));
    sortWrap.appendChild(sort);
    controls.appendChild(sortWrap);

    const favoritesWrap = el('label', 'pp-check');
    const favorites = el('input');
    favorites.type = 'checkbox';
    favorites.checked = query.favoritesOnly;
    favorites.addEventListener('change', () => sendQuery({ favoritesOnly: favorites.checked }));
    favoritesWrap.appendChild(favorites);
    favoritesWrap.appendChild(el('span', null, 'Favourites only'));
    controls.appendChild(favoritesWrap);

    node.appendChild(controls);

    const chips = el('div', 'pp-chips');
    for (const filter of snapshot.filters) {
      const chip = el('button', 'pp-chip' + (filter.active ? ' pp-chip-on' : ''), filter.label);
      chip.type = 'button';
      chip.title = filter.rule;
      chip.setAttribute('aria-pressed', filter.active ? 'true' : 'false');
      chip.addEventListener('click', () => {
        const next = filter.active
          ? query.quickFilters.filter((id) => id !== filter.id)
          : query.quickFilters.concat([filter.id]);
        sendQuery({ quickFilters: next });
      });
      chips.appendChild(chip);
    }
    node.appendChild(chips);

    const summary = el(
      'p',
      'pp-result-line',
      snapshot.matchingModels === 0
        ? 'No model matches the current filters.'
        : `Showing ${snapshot.page.firstOrdinal}–${snapshot.page.lastOrdinal} of ${snapshot.matchingModels} matching models` +
          (snapshot.matchingModels === snapshot.totalModels
            ? ` (${snapshot.totalModels} in the catalogue).`
            : `, out of ${snapshot.totalModels} in the catalogue.`)
    );
    node.appendChild(summary);

    if (snapshot.models.length > 0) {
      node.appendChild(modelTable(snapshot));
    }
    if (snapshot.page.hasMore) {
      node.appendChild(button('Load more models', { type: 'loadMore' }));
    }

    if (snapshot.favorites.length > 0 || snapshot.recent.length > 0) {
      const quick = el('div', 'pp-quick-picks');
      if (snapshot.recent.length > 0) {
        quick.appendChild(el('h3', 'pp-subhead', 'Recently used'));
        quick.appendChild(modelChipRow(snapshot.recent));
      }
      if (snapshot.favorites.length > 0) {
        quick.appendChild(el('h3', 'pp-subhead', 'Favourites'));
        quick.appendChild(modelChipRow(snapshot.favorites));
      }
      node.appendChild(quick);
    }

    return node;
  }

  function modelChipRow(rows) {
    const wrap = el('div', 'pp-chips');
    for (const row of rows) {
      const chip = el('button', 'pp-chip', row.name);
      chip.type = 'button';
      chip.addEventListener('click', () => post({ type: 'showModelDetails', modelId: row.id }));
      wrap.appendChild(chip);
    }
    return wrap;
  }

  function modelTable(snapshot) {
    const table = el('table', 'pp-table pp-table-models');
    const head = el('thead');
    const headRow = el('tr');
    for (const label of ['', 'Model', 'Context', 'Max out', 'Input /M', 'Output /M', 'Capabilities', '']) {
      headRow.appendChild(el('th', null, label));
    }
    head.appendChild(headRow);
    table.appendChild(head);

    const body = el('tbody');
    for (const model of snapshot.models) {
      const row = el('tr', model.isSelected ? 'pp-row-selected' : null);

      const starCell = el('td');
      const star = el('button', 'pp-star' + (model.isFavorite ? ' pp-star-on' : ''), model.isFavorite ? '★' : '☆');
      star.type = 'button';
      star.title = model.isFavorite ? 'Remove from favourites' : 'Add to favourites';
      star.setAttribute('aria-label', star.title);
      star.addEventListener('click', (event) => {
        event.stopPropagation();
        post({ type: 'toggleFavorite', modelId: model.id });
      });
      starCell.appendChild(star);
      row.appendChild(starCell);

      const nameCell = el('td');
      nameCell.appendChild(el('span', 'pp-model-name', model.name));
      nameCell.appendChild(el('span', 'pp-model-id', model.id));
      if (model.developer) {
        nameCell.appendChild(el('span', 'pp-model-dev', model.developer));
      }
      row.appendChild(nameCell);

      row.appendChild(el('td', 'pp-num', model.contextLabel));
      row.appendChild(el('td', 'pp-num', model.maxOutputLabel));
      row.appendChild(el('td', 'pp-num', model.inputPriceLabel));
      row.appendChild(el('td', 'pp-num', model.outputPriceLabel));

      const caps = el('td');
      if (model.capabilityChips.length === 0) {
        caps.appendChild(el('span', 'pp-muted', '—'));
      } else {
        for (const chip of model.capabilityChips) {
          caps.appendChild(el('span', 'pp-mini', chip));
        }
      }
      row.appendChild(caps);

      const actionCell = el('td', 'pp-cell-actions');
      const details = el('button', 'pp-link', 'Details');
      details.type = 'button';
      details.addEventListener('click', (event) => {
        event.stopPropagation();
        post({ type: 'showModelDetails', modelId: model.id });
      });
      actionCell.appendChild(details);
      row.appendChild(actionCell);

      body.appendChild(row);
    }
    table.appendChild(body);
    return table;
  }

  function sendQuery(patch) {
    const current = latest ? latest.query : { search: '', quickFilters: [], sort: 'name', favoritesOnly: false };
    post({
      type: 'setQuery',
      search: patch.search !== undefined ? patch.search : current.search,
      quickFilters: patch.quickFilters !== undefined ? patch.quickFilters : current.quickFilters,
      sort: patch.sort !== undefined ? patch.sort : current.sort,
      favoritesOnly: patch.favoritesOnly !== undefined ? patch.favoritesOnly : current.favoritesOnly,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Model details                                                          */
  /* ---------------------------------------------------------------------- */

  function detailsPane(details) {
    const node = el('aside', 'pp-details');
    const head = el('div', 'pp-section-head');
    head.appendChild(el('h2', 'pp-section-title', details.row.name));
    const close = el('button', 'pp-link', 'Close');
    close.type = 'button';
    close.addEventListener('click', () => post({ type: 'showModelDetails', modelId: null }));
    head.appendChild(close);
    node.appendChild(head);

    node.appendChild(el('p', 'pp-model-id', details.row.id));
    if (details.canonicalSlug && details.canonicalSlug !== details.row.id) {
      node.appendChild(labelled('Canonical slug', details.canonicalSlug));
    }
    node.appendChild(labelled('Developer', details.row.developer));
    node.appendChild(el('p', 'pp-description', details.row.description || 'The catalogue publishes no description for this model.'));

    const actions = el('div', 'pp-actions');
    actions.appendChild(
      button(details.row.isFavorite ? 'Remove from favourites' : 'Add to favourites', {
        type: 'toggleFavorite',
        modelId: details.row.id,
      }, 'pp-button-quiet')
    );
    node.appendChild(actions);

    node.appendChild(destinationSection(details));

    node.appendChild(el('h3', 'pp-subhead', 'Pricing, per million tokens'));
    const pricingTable = el('table', 'pp-table');
    const pricingBody = el('tbody');
    for (const row of details.pricingRows) {
      const tr = el('tr');
      tr.appendChild(el('th', 'pp-th-label', row.label));
      tr.appendChild(el('td', 'pp-num', row.value));
      pricingBody.appendChild(tr);
    }
    pricingTable.appendChild(pricingBody);
    node.appendChild(pricingTable);
    if (details.row.isFree) {
      node.appendChild(el('p', 'pp-note', 'The catalogue prices both input and output at exactly zero.'));
    }

    node.appendChild(el('h3', 'pp-subhead', 'Limits'));
    const limits = el('div', 'pp-fields');
    limits.appendChild(labelled('Context window', details.row.contextLabel === '—' ? null : details.row.contextLabel + ' tokens'));
    limits.appendChild(labelled('Maximum output', details.row.maxOutputLabel === '—' ? null : details.row.maxOutputLabel + ' tokens'));
    limits.appendChild(labelled('Published', details.createdLabel));
    node.appendChild(limits);

    node.appendChild(el('h3', 'pp-subhead', 'Capabilities, as declared'));
    const caps = el('div', 'pp-fields');
    caps.appendChild(labelled('Tool calling', yesNo(details.capabilities.toolCalling)));
    caps.appendChild(labelled('Structured output', yesNo(details.capabilities.structuredOutput)));
    caps.appendChild(labelled('Reasoning', yesNo(details.capabilities.reasoning)));
    caps.appendChild(
      labelled(
        'Input modalities',
        details.capabilities.inputModalities.length === 0 ? null : details.capabilities.inputModalities.join(', ')
      )
    );
    caps.appendChild(
      labelled(
        'Output modalities',
        details.capabilities.outputModalities.length === 0 ? null : details.capabilities.outputModalities.join(', ')
      )
    );
    node.appendChild(caps);

    if (details.supportedParameters.length > 0) {
      const params = el('div', 'pp-chips');
      for (const parameter of details.supportedParameters) {
        params.appendChild(el('span', 'pp-mini', parameter));
      }
      node.appendChild(params);
    }

    if (details.unknownFields.length > 0) {
      node.appendChild(
        el(
          'p',
          'pp-note',
          `The catalogue did not publish: ${details.unknownFields.join(', ')}. Those fields are shown as "Not provided" rather than guessed.`
        )
      );
    }

    node.appendChild(whyUseSection(details));

    if (details.selectedAt.length > 0) {
      node.appendChild(
        el('p', 'pp-note', `Selected at: ${details.selectedAt.join(', ')}.`)
      );
    }

    return node;
  }

  /**
   * "Use this model for" — the one place a model is chosen for a level.
   *
   * The destinations come from the selection summary the Host built, so the
   * panel cannot name a level the Host would refuse: the option carries the
   * level's own key, including the workspace path for the project level, which
   * the Host validates again on receipt.
   *
   * Each option states what that level holds now, because choosing one replaces
   * a selection the developer may have forgotten they made.
   */
  function destinationSection(details) {
    const selection = latest ? latest.selection : null;
    if (!selection || selection.levels.length === 0) {
      return el('div');
    }

    const wrap = el('div', 'pp-destinations');
    wrap.appendChild(el('h3', 'pp-subhead', 'Use this model for'));

    const picker = el('label', 'pp-select-wrap');
    picker.appendChild(el('span', 'pp-field-label', 'Selection level'));
    const select = el('select', 'pp-select');
    select.setAttribute('aria-label', `Use ${details.row.name} for a selection level`);

    const placeholder = el('option', null, 'Choose a level…');
    placeholder.value = '';
    placeholder.selected = true;
    select.appendChild(placeholder);

    selection.levels.forEach((level, index) => {
      const current =
        level.modelId === null
          ? 'provider default'
          : level.modelName || level.modelId + ' (not in the catalogue)';
      const option = el('option', null, `${level.label} — now: ${current}`);
      // The index, not the key: a workspace path is an awkward option value and
      // the panel only ever sends a level the Host listed.
      option.value = String(index);
      select.appendChild(option);
    });

    select.addEventListener('change', () => {
      const index = Number(select.value);
      const level = Number.isInteger(index) ? selection.levels[index] : undefined;
      if (!level) {
        return;
      }
      post({ type: 'selectModel', level: level.level, key: level.key, modelId: details.row.id });
    });
    picker.appendChild(select);
    wrap.appendChild(picker);

    wrap.appendChild(
      el(
        'p',
        'pp-note',
        'A more specific level beats a broader one: a role beats this project, and this project beats the global default. Setting a level changes what the next request uses — PairPilot never switches models on its own.'
      )
    );
    return wrap;
  }

  function whyUseSection(details) {
    const wrap = el('div', 'pp-why');
    wrap.appendChild(el('h3', 'pp-subhead', 'Why should I use this model?'));

    const picker = el('label', 'pp-select-wrap');
    picker.appendChild(el('span', 'pp-field-label', 'For this kind of work'));
    const select = el('select', 'pp-select');

    // The explanation's own task is the authority on which option is current:
    // it is the task the ranking below was actually computed for.
    const explanation = details.explanation;
    const currentTaskId = explanation ? explanation.taskId : null;

    if (latest && latest.adviceTasks) {
      for (const task of latest.adviceTasks) {
        const option = el('option', null, task.label);
        option.value = task.id;
        if (task.id === currentTaskId) {
          option.selected = true;
        }
        select.appendChild(option);
      }
    }
    select.addEventListener('change', () => {
      post({ type: 'requestAdvice', taskId: select.value });
    });
    picker.appendChild(select);
    wrap.appendChild(picker);

    if (!explanation) {
      wrap.appendChild(
        el('p', 'pp-note', 'Choose a kind of work to see how this model compares with the rest of the catalogue for it.')
      );
      return wrap;
    }

    if (explanation.rank === null) {
      const reason = el('div', 'pp-explanation');
      reason.appendChild(el('p', 'pp-explanation-headline', `Not ranked for ${explanation.taskLabel}.`));
      reason.appendChild(el('p', null, explanation.excludedReason || 'It was not included in this task’s ranking.'));
      wrap.appendChild(reason);
    } else {
      const ranked = el('div', 'pp-explanation');
      const placed = el(
        'p',
        'pp-explanation-headline',
        `Ranked ${explanation.rank} of ${explanation.poolSize} for ${explanation.taskLabel}` +
          (explanation.rank <= explanation.shortlistSize ? ', so it is on the shortlist.' : '.')
      );
      ranked.appendChild(placed);

      if (explanation.recommendation) {
        placed.appendChild(document.createTextNode(' '));
        placed.appendChild(scoreBadge(explanation.recommendation.scoreLabel));

        const list = el('ul', 'pp-reasons');
        for (const reason of explanation.recommendation.reasons) {
          const item = el('li');
          item.appendChild(el('strong', null, reason.fact + ' '));
          item.appendChild(el('span', null, reason.implication));
          list.appendChild(item);
        }
        ranked.appendChild(list);

        const tradeoffs = el('div', 'pp-tradeoffs');
        tradeoffs.appendChild(el('h4', 'pp-subhead', 'What you give up'));
        const tradeList = el('ul', 'pp-reasons');
        for (const tradeoff of explanation.recommendation.tradeoffs) {
          tradeList.appendChild(el('li', null, tradeoff));
        }
        tradeoffs.appendChild(tradeList);
        ranked.appendChild(tradeoffs);
      }

      const apply = el('div', 'pp-actions');
      apply.appendChild(
        button(
          `Use this model for ${explanation.taskLabel}`,
          { type: 'applyAdvice', roleId: explanation.taskId, modelId: details.row.id },
          'pp-button-primary'
        )
      );
      ranked.appendChild(apply);
      wrap.appendChild(ranked);
    }

    wrap.appendChild(el('p', 'pp-disclaimer', explanation.disclaimer));
    if (explanation.caveat) {
      wrap.appendChild(el('p', 'pp-note', explanation.caveat));
    }
    return wrap;
  }

  function yesNo(value) {
    return value ? 'Declared' : 'Not declared';
  }

  /* ---------------------------------------------------------------------- */
  /* Model Advisor                                                          */
  /* ---------------------------------------------------------------------- */

  function advisorSection(snapshot) {
    const advice = snapshot.advice;
    const node = section(
      'Model Advisor',
      'Recommendations are a fit against stated requirements, computed from catalogue metadata. Applying one only changes the stored selection for the next turn.'
    );

    const picker = el('label', 'pp-select-wrap');
    picker.appendChild(el('span', 'pp-field-label', 'Task'));
    const select = el('select', 'pp-select');
    for (const task of snapshot.adviceTasks) {
      const option = el('option', null, task.label);
      option.value = task.id;
      if (advice && advice.taskId === task.id) {
        option.selected = true;
      }
      select.appendChild(option);
    }
    select.addEventListener('change', () => post({ type: 'requestAdvice', taskId: select.value }));
    picker.appendChild(select);
    node.appendChild(picker);

    if (!advice) {
      return node;
    }

    if (advice.requirements.length > 0) {
      const requirements = el('div', 'pp-requirements');
      requirements.appendChild(el('h3', 'pp-subhead', 'What this task needs'));
      const list = el('ul', 'pp-reasons');
      for (const requirement of advice.requirements) {
        list.appendChild(el('li', null, requirement));
      }
      requirements.appendChild(list);
      node.appendChild(requirements);
    }

    if (advice.caveat) {
      node.appendChild(el('p', 'pp-note', advice.caveat));
    }

    if (advice.recommendations.length === 0) {
      node.appendChild(el('p', 'pp-note', 'No models are available to recommend yet.'));
      return node;
    }

    const cards = el('div', 'pp-recommendations');
    advice.recommendations.forEach((recommendation, index) => {
      cards.appendChild(recommendationCard(recommendation, index, advice));
    });
    node.appendChild(cards);
    node.appendChild(el('p', 'pp-disclaimer', advice.disclaimer));
    return node;
  }

  function recommendationCard(recommendation, index, advice) {
    const card = el('article', 'pp-card');
    const head = el('div', 'pp-card-head');
    head.appendChild(el('h3', 'pp-card-title', `${index + 1}. ${recommendation.name}`));
    head.appendChild(scoreBadge(recommendation.scoreLabel));
    card.appendChild(head);
    card.appendChild(el('p', 'pp-model-id', recommendation.modelId));

    const reasons = el('ul', 'pp-reasons');
    for (const reason of recommendation.reasons) {
      const item = el('li');
      item.appendChild(el('strong', null, reason.fact + ' '));
      item.appendChild(el('span', null, reason.implication));
      reasons.appendChild(item);
    }
    card.appendChild(reasons);

    const tradeoffs = el('div', 'pp-tradeoffs');
    tradeoffs.appendChild(el('h4', 'pp-subhead', 'What you give up'));
    const tradeList = el('ul', 'pp-reasons');
    for (const tradeoff of recommendation.tradeoffs) {
      tradeList.appendChild(el('li', null, tradeoff));
    }
    tradeoffs.appendChild(tradeList);
    card.appendChild(tradeoffs);

    const actions = el('div', 'pp-actions');
    actions.appendChild(
      button(
        `Use for ${advice.taskLabel}`,
        { type: 'applyAdvice', roleId: advice.taskId, modelId: recommendation.modelId },
        'pp-button-primary'
      )
    );
    actions.appendChild(
      button('Details', { type: 'showModelDetails', modelId: recommendation.modelId }, 'pp-button-quiet')
    );
    card.appendChild(actions);
    return card;
  }
})();
