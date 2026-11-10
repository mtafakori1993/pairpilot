// PairPilot Webview script.
//
// The Webview is a presentation layer with no authority. It renders snapshots
// pushed by the Extension Host and sends *requests* back. It never decides
// whether a write is permitted, never touches the filesystem, and never sees an
// API key.
//
// Everything user-supplied is inserted with `textContent` or `createElement`
// rather than `innerHTML`, so a task description or an AI message containing
// markup cannot inject anything into the panel.

(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  /** Last snapshot from the host. Re-rendered on every `state` message. */
  let snapshot = null;
  /** Live streaming text, applied incrementally between snapshots. */
  let streamingText = '';
  /** Active tab id. */
  let activeTab = 'chat';
  /** Draft preserved across re-renders. */
  const drafts = { task: '', feedback: '' };
  /** Set while the user is typing, so a re-render does not steal focus. */
  let composing = false;

  const el = (id) => document.getElementById(id);

  /* ----------------------------------------------------------- utilities -- */

  /**
   * True when text is predominantly Persian/Arabic script.
   * Counts script characters against letters only, so a Persian sentence that
   * contains an English identifier is still treated as RTL.
   */
  function isRtl(text) {
    if (!text) {
      return false;
    }
    const rtl = (text.match(/[֐-׿؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/g) || []).length;
    const ltr = (text.match(/[A-Za-zÀ-ɏ]/g) || []).length;
    return rtl > 0 && rtl >= ltr;
  }

  /** Apply direction to an element based on its text content. */
  function applyDirection(node, text) {
    if (isRtl(text)) {
      node.classList.add('rtl');
      node.setAttribute('dir', 'rtl');
    } else {
      node.classList.remove('rtl');
      node.setAttribute('dir', 'ltr');
    }
  }

  function formatNumber(value) {
    if (typeof value !== 'number' || !isFinite(value)) {
      return '—';
    }
    return value.toLocaleString('en-US');
  }

  function formatCost(value) {
    if (value === null || typeof value !== 'number' || !isFinite(value)) {
      return null;
    }
    return '$' + value.toFixed(4);
  }

  function formatTime(ms) {
    try {
      return new Date(ms).toLocaleTimeString();
    } catch {
      return '';
    }
  }

  function formatDateTime(ms) {
    try {
      return new Date(ms).toLocaleString();
    } catch {
      return '';
    }
  }

  /** Human label for the state machine values shown in the header. */
  const STATE_LABELS = {
    IDLE: 'Idle',
    ANALYZING: 'Analyzing',
    PROPOSING: 'Proposing',
    WAITING_FILE_APPROVAL: 'Waiting: file permission',
    CREATING_FILE: 'Creating file',
    WRITING_CODE: 'Writing code',
    REVIEWING: 'Ready for review',
    WAITING_CODE_APPROVAL: 'Waiting: your review',
    APPROVED: 'Approved',
    REJECTED: 'Rejected',
    REQUESTING_CHANGES: 'Revising',
    ANALYZING_NEXT_STEP: 'Advisor',
    COMPLETED: 'Complete',
    FAILED: 'Failed',
    CANCELLED: 'Cancelled',
  };

  function post(message) {
    vscode.postMessage(message);
  }

  /* ------------------------------------------------------------ rendering -- */

  function render() {
    if (!snapshot) {
      return;
    }
    renderHeader();
    renderModelBar();
    renderTabs();
    renderNoticeBoxes();
    renderChat();
    renderContextChips();
    renderTaskStatus();
    renderReview();
    renderAdvisor();
    renderSessions();
    renderUsage();
    renderComposer();
  }


  /**
   * Provider and model, in one line, with the one action that matters.
   *
   * Read-only apart from the button: the panel does not choose a model, it opens
   * the native picker. That keeps a single configuration surface, and means the
   * Webview never holds a model id it could send back as a selection.
   */
  function renderModelBar() {
    const container = el('model-bar');
    container.textContent = '';

    const config = snapshot.modelConfig;
    if (!config) {
      return;
    }

    const text = document.createElement('span');
    text.className = 'model-bar-text';
    // Built with textContent, never innerHTML: the model name comes from a remote
    // catalogue and is not this panel's to trust.
    text.textContent = config.providerLabel + ' · ' + config.modelLabel;
    container.appendChild(text);

    const change = document.createElement('button');
    change.className = 'link';
    change.textContent = 'Change';
    change.title = 'Choose the provider or model in a VS Code picker';
    change.addEventListener('click', () => post({ type: 'chooseModel' }));
    container.appendChild(change);
  }

  function renderHeader() {
    const s = snapshot;
    el('project-name').textContent = s.projectName || 'No folder';

    const runtimeRow = el('runtime-status');
    runtimeRow.textContent = '';
    const dot = document.createElement('span');
    dot.className =
      'status-dot ' + (s.runtime.pending ? '' : s.runtime.available ? 'ok' : 'bad');
    runtimeRow.appendChild(dot);
    const label = document.createElement('span');
    label.textContent = s.runtime.pending
      ? 'Detecting runtime…'
      : s.runtime.available
        ? s.runtime.version
          ? `Claude Code ${s.runtime.version}`
          : 'Claude Code detected'
        : 'Runtime unavailable';
    runtimeRow.appendChild(label);
    if (!s.runtime.available && !s.runtime.pending) {
      runtimeRow.title = s.runtime.message;
    }

    el('state-pill').textContent = STATE_LABELS[s.state] || s.state;

    el('session-label').textContent = s.sessionId
      ? `${s.messages.length} messages`
      : 'No session';

    // The mode bar. `workflowMode` may be absent from a snapshot captured by an
    // older host build, so the whole block is guarded rather than assuming the
    // field is there — a panel that throws on a missing field shows nothing at
    // all, which is a worse failure than a missing badge.
    const mode = s.workflowMode;
    if (mode) {
      const bar = el('mode-bar');
      el('mode-label').textContent = mode.label;
      el('mode-summary').textContent = mode.summary;
      bar.title = mode.reason;
      bar.className = 'mode-bar ' + (mode.id === 'coding' ? 'coding' : 'planning');
    }
  }

  function renderTabs() {
    for (const tab of document.querySelectorAll('.tab')) {
      const id = tab.getAttribute('data-tab');
      tab.classList.toggle('active', id === activeTab);
    }
    for (const panel of document.querySelectorAll('.panel')) {
      panel.classList.toggle('active', panel.id === 'panel-' + activeTab);
    }

    const reviewBadge = el('review-badge');
    const pending = Boolean(snapshot.activeProposal) || snapshot.pendingApproval;
    reviewBadge.style.display = pending ? 'inline-block' : 'none';
    reviewBadge.textContent = '!';
  }

  function renderNoticeBoxes() {
    const container = el('notice-area');
    container.textContent = '';

    if (snapshot.error) {
      const box = document.createElement('div');
      box.className = 'error-box';
      box.textContent = snapshot.error;
      applyDirection(box, snapshot.error);
      container.appendChild(box);
    }
    if (snapshot.notice) {
      const box = document.createElement('div');
      box.className = 'notice-box';
      box.textContent = snapshot.notice;
      applyDirection(box, snapshot.notice);
      container.appendChild(box);
    }
  }

  function renderChat() {
    const list = el('messages');
    list.textContent = '';

    if (snapshot.messages.length === 0 && !snapshot.isStreaming) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent =
        'Describe a task. PairPilot will propose one file, ask your permission, then write it into your editor for review.';
      list.appendChild(empty);
      return;
    }

    for (const message of snapshot.messages) {
      list.appendChild(buildMessage(message.role, message.text, message.timestamp));
    }

    if (snapshot.isStreaming && streamingText.length > 0) {
      const node = buildMessage('assistant', streamingText, Date.now(), true);
      list.appendChild(node);
    }

    list.scrollTop = list.scrollHeight;
  }

  function buildMessage(role, text, timestamp, streaming) {
    const wrapper = document.createElement('div');
    wrapper.className = 'message ' + role + (streaming ? ' streaming' : '');

    const roleLine = document.createElement('div');
    roleLine.className = 'message-role';
    roleLine.textContent = role + (timestamp ? ' · ' + formatTime(timestamp) : '');
    wrapper.appendChild(roleLine);

    const body = document.createElement('div');
    body.className = 'message-text';
    // The AI's JSON is shown as-is; the review panel is where it becomes
    // readable. Truncating very long messages keeps the panel usable.
    const display = text.length > 6000 ? text.slice(0, 6000) + '\n… (truncated in the chat view)' : text;
    body.textContent = display;
    applyDirection(body, display);
    if (streaming) {
      body.classList.add('cursor-blink');
    }
    wrapper.appendChild(body);
    return wrapper;
  }

  function renderContextChips() {
    const container = el('context-chips');
    container.textContent = '';

    const files = snapshot.lastContextFiles || [];
    if (files.length === 0) {
      // This panel is about the *workspace context sent to the model*, which is
      // a different thing from the files of a proposal. The old wording — "No
      // file contents were sent with the last request." — said neither, and
      // sitting under a seven-file proposal it read as though the proposal had
      // lost its files. It had not; this list was simply empty, which is the
      // normal state when a request needed no surrounding context.
      const none = document.createElement('span');
      none.className = 'hint';
      none.textContent =
        'No workspace files were needed as context for the last request. This list is about code sent to the AI, not the files it proposes to write.';
      container.appendChild(none);
    } else {
      for (const file of files) {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.title = `${file.relativePath} — ${formatNumber(file.bytes)} bytes${file.truncated ? ' (truncated)' : ''}${file.sensitive ? ' (approved sensitive)' : ''}`;
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = file.relativePath + (file.truncated ? ' ✂' : '');
        chip.appendChild(name);
        container.appendChild(chip);
      }
      const summary = document.createElement('span');
      summary.className = 'hint';
      summary.textContent = `${files.length} file(s) sent with the last request.`;
      container.appendChild(summary);
    }
  }

  function renderTaskStatus() {
    const container = el('task-status');
    container.textContent = '';

    if (!snapshot.currentTask && !snapshot.currentStep && !snapshot.pendingApproval) {
      return;
    }

    const card = document.createElement('div');
    card.className = 'card';

    if (snapshot.currentTask) {
      const title = document.createElement('div');
      title.className = 'card-title';
      title.textContent = 'Current task';
      card.appendChild(title);
      const body = document.createElement('div');
      body.className = 'body-text';
      body.textContent = snapshot.currentTask;
      applyDirection(body, snapshot.currentTask);
      card.appendChild(body);
    }

    if (snapshot.currentStep) {
      const step = document.createElement('div');
      step.className = 'card-sub';
      const spinner = document.createElement('span');
      spinner.className = 'spinner';
      step.appendChild(spinner);
      const text = document.createElement('span');
      text.textContent = ' ' + snapshot.currentStep;
      step.appendChild(text);
      card.appendChild(step);
    }

    if (snapshot.streamingCode && snapshot.streamingCode.length > 0) {
      const pre = document.createElement('pre');
      pre.className = 'code';
      pre.textContent = snapshot.streamingCode.join('\n');
      card.appendChild(pre);
    }

    if (snapshot.pendingApproval) {
      const flag = document.createElement('div');
      flag.className = 'warning-box';
      flag.textContent = 'PairPilot is paused and waiting for your decision.';
      card.appendChild(flag);
    }

    container.appendChild(card);
  }

  /**
   * The Review tab is a *status* view now, not a decision surface.
   *
   * The decision happens in the editor that holds the code: a comment thread on
   * the file, a native prompt with the three buttons. Putting the buttons here
   * as well would be the panel-based review this was changed to remove — and
   * two places to approve from is two places to make one mistake in.
   *
   * So this shows which file is waiting, how far into the batch it is, and a
   * link that brings the editor's own review to the front. Nothing in it can
   * change what the workflow will do.
   */
  function renderReview() {
    const container = el('review-content');
    container.textContent = '';

    if (snapshot.batch && snapshot.batch.total > 1) {
      container.appendChild(buildBatchPanel(snapshot.batch));
    }

    const proposal = snapshot.activeProposal;
    const waiting =
      snapshot.state === 'WAITING_FILE_APPROVAL' ||
      snapshot.state === 'WAITING_CODE_APPROVAL' ||
      snapshot.state === 'REVIEWING';

    if (!waiting && !proposal) {
      if (snapshot.batch && snapshot.batch.total > 1) {
        return;
      }
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Nothing is waiting for review.';
      container.appendChild(empty);
      return;
    }

    const card = document.createElement('div');
    card.className = 'card';

    const title = document.createElement('div');
    title.className = 'card-title';
    const name = document.createElement('span');
    name.textContent = proposal ? proposal.relativePath : snapshot.pendingFilePath || '';
    name.setAttribute('dir', 'ltr');
    title.appendChild(name);
    card.appendChild(title);

    const where = document.createElement('div');
    where.className = 'body-text';
    const askingToWrite = snapshot.state === 'WAITING_FILE_APPROVAL';
    where.textContent = askingToWrite
      ? 'PairPilot is asking for permission to write this file. Nothing has been written yet — answer in the prompt that opened.'
      : 'The code is written. Review it in the editor, on the file itself.';
    card.appendChild(where);

    if (proposal && proposal.description) {
      const desc = document.createElement('div');
      desc.className = 'hint';
      desc.textContent = proposal.description;
      applyDirection(desc, proposal.description);
      card.appendChild(desc);
    }

    const open = document.createElement('button');
    open.textContent = askingToWrite ? 'Show the permission prompt' : 'Open the review in the editor';
    open.addEventListener('click', () => {
      post({ type: 'openReviewInEditor' });
    });
    card.appendChild(open);

    const note = document.createElement('div');
    note.className = 'hint';
    note.textContent = askingToWrite
      ? 'The decision belongs to the file: PairPilot asks before it writes, then shows the written code in the editor for approval.'
      : 'Approve, Request changes and Reject are on the file\'s comment thread and in the Command Palette, so the decision is made where the code is.';
    card.appendChild(note);

    container.appendChild(card);
  }

  /** Human wording and a css class for each batch file state. */
  const BATCH_STATUS = {
    pending: 'waiting',
    authorized: 'authorised to write',
    writing: 'writing now',
    completed: 'awaiting your review',
    approved: 'approved',
    failed: 'could not be written',
    revision: 'being revised',
    rejected: 'rejected',
  };

  /**
   * The seven files of a batch, each with its own state.
   *
   * Every value here is host-supplied, and the file names are model-supplied, so
   * everything goes in with textContent. A file already written can be opened in
   * the editor from here, which is the point of reviewing in the real editor
   * rather than in a preview.
   */
  function buildBatchPanel(batch) {
    const card = document.createElement('div');
    card.className = 'card batch-panel';

    const title = document.createElement('div');
    title.className = 'card-title';
    title.textContent =
      'This proposal writes ' +
      batch.total +
      ' files — ' +
      batch.completed +
      ' written, ' +
      batch.pending +
      ' to go';
    card.appendChild(title);

    if (batch.failed > 0) {
      const warning = document.createElement('div');
      warning.className = 'warning-box';
      warning.textContent =
        batch.failed + ' file(s) could not be written. The others are unaffected.';
      card.appendChild(warning);
    }

    for (const file of batch.files) {
      const row = document.createElement('div');
      row.className = 'batch-file ' + file.status;

      const name = document.createElement('span');
      name.className = 'batch-file-name';
      name.textContent = file.file;
      name.setAttribute('dir', 'ltr');
      name.title = file.note ? file.file + ' — ' + file.note : file.file;
      row.appendChild(name);

      const status = document.createElement('span');
      status.className = 'batch-file-status';
      status.textContent = BATCH_STATUS[file.status] || file.status;
      row.appendChild(status);

      // Written files can be opened for review in the real editor; the rest have
      // nothing to open yet.
      if (file.status === 'completed' || file.status === 'approved') {
        const open = document.createElement('button');
        open.className = 'link';
        open.textContent = 'Open';
        open.addEventListener('click', () => {
          post({ type: 'openFile', relativePath: file.file });
        });
        row.appendChild(open);
      }

      card.appendChild(row);
    }

    return card;
  }

  function renderAdvisor() {
    const container = el('advisor-content');
    container.textContent = '';
    const rec = snapshot.recommendation;
    const roadmap = snapshot.roadmap;

    // The roadmap offer is shown whether or not the advisor has a suggestion:
    // the plan the developer wrote outranks a model's guess at what comes next,
    // and a panel that hid the planned next file behind an optional advisor
    // recommendation would be offering advice instead of the roadmap.
    if (roadmap) {
      container.appendChild(buildRoadmapCard(roadmap));
    }

    if (!rec) {
      return;
    }

    const card = document.createElement('div');
    card.className = 'card';

    const title = document.createElement('div');
    title.className = 'card-title';
    const text = document.createElement('span');
    text.textContent = rec.title;
    applyDirection(text, rec.title);
    title.appendChild(text);
    const badge = document.createElement('span');
    badge.className = 'state-pill';
    badge.textContent = rec.required ? 'required' : 'optional';
    title.appendChild(badge);
    card.appendChild(title);

    const reason = document.createElement('div');
    reason.className = 'body-text';
    reason.textContent = rec.reason;
    applyDirection(reason, rec.reason);
    card.appendChild(reason);

    if (rec.responsibilities.length > 0) {
      card.appendChild(sectionTitle('Suggested responsibilities'));
      card.appendChild(bulletList(rec.responsibilities));
    }
    if (rec.files.length > 0) {
      card.appendChild(sectionTitle('Files'));
      card.appendChild(bulletList(rec.files, true));
    }

    const source = document.createElement('div');
    source.className = 'hint';
    source.textContent =
      rec.source === 'ai'
        ? 'Based on analysis of the approved code by the AI runtime.'
        : 'Based on PairPilot local dependency analysis.';
    card.appendChild(source);

    const actions = document.createElement('div');
    actions.className = 'actions';

    const accept = document.createElement('button');
    accept.textContent = 'Accept recommendation';
    accept.addEventListener('click', () => post({ type: 'acceptRecommendation' }));
    actions.appendChild(accept);

    const dismiss = document.createElement('button');
    dismiss.className = 'secondary';
    dismiss.textContent = 'Dismiss';
    dismiss.addEventListener('click', () => post({ type: 'dismissRecommendation' }));
    actions.appendChild(dismiss);

    card.appendChild(actions);
    container.appendChild(card);
  }

  /**
   * The next file the roadmap says to write.
   *
   * A single button, and it carries no path: the host starts the file it
   * offered. That is what keeps this a *read-only status view with a
   * navigation action* rather than a place where a file is chosen.
   */
  function buildRoadmapCard(roadmap) {
    const card = document.createElement('div');
    card.className = 'card';

    const title = document.createElement('div');
    title.className = 'card-title';
    title.textContent = 'Next on the roadmap';
    card.appendChild(title);

    const file = document.createElement('div');
    file.className = 'body-text';
    const path = document.createElement('code');
    path.textContent = roadmap.relativePath;
    file.appendChild(path);
    if (roadmap.taskId) {
      file.appendChild(document.createTextNode(` — task ${roadmap.taskId}`));
    }
    card.appendChild(file);

    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent =
      'Written into the file itself, then kept only when you approve it in the editor.';
    card.appendChild(hint);

    const actions = document.createElement('div');
    actions.className = 'actions';

    const write = document.createElement('button');
    write.textContent = 'Write this file';
    write.addEventListener('click', () => post({ type: 'continueRoadmap' }));
    actions.appendChild(write);

    card.appendChild(actions);
    return card;
  }

  function renderSessions() {
    const container = el('sessions-content');
    container.textContent = '';

    const toolbar = document.createElement('div');
    toolbar.className = 'toolbar';

    const create = document.createElement('button');
    create.textContent = 'New session';
    create.addEventListener('click', () => post({ type: 'newSession' }));
    toolbar.appendChild(create);

    const refresh = document.createElement('button');
    refresh.className = 'secondary';
    refresh.textContent = 'Show output log';
    refresh.addEventListener('click', () => post({ type: 'revealOutput' }));
    toolbar.appendChild(refresh);

    container.appendChild(toolbar);

    if (snapshot.sessions.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No sessions have been stored yet.';
      container.appendChild(empty);
      return;
    }

    for (const session of snapshot.sessions) {
      const item = document.createElement('div');
      item.className = 'session-item' + (session.id === snapshot.sessionId ? ' active' : '');

      const info = document.createElement('div');
      info.className = 'session-info';

      const title = document.createElement('div');
      title.className = 'session-title';
      title.textContent = session.title;
      applyDirection(title, session.title);
      info.appendChild(title);

      const meta = document.createElement('div');
      meta.className = 'session-meta';
      meta.textContent = `${formatDateTime(session.updatedAt)} · ${session.messageCount} msg · ${session.proposalCount} proposal(s)`;
      info.appendChild(meta);

      item.appendChild(info);

      const load = document.createElement('button');
      load.className = 'link';
      load.textContent = 'Resume';
      load.disabled = session.id === snapshot.sessionId;
      load.addEventListener('click', () => post({ type: 'loadSession', sessionId: session.id }));
      item.appendChild(load);

      const remove = document.createElement('button');
      remove.className = 'link';
      remove.textContent = 'Delete';
      remove.addEventListener('click', () => post({ type: 'deleteSession', sessionId: session.id }));
      item.appendChild(remove);

      container.appendChild(item);
    }
  }

  function renderUsage() {
    const container = el('usage-content');
    container.textContent = '';
    const usage = snapshot.usage;

    if (!usage.available) {
      const box = document.createElement('div');
      box.className = 'empty';
      // Spec section 12: say so plainly rather than showing invented numbers.
      box.textContent =
        'Usage unavailable — the AI runtime has not reported token counts for this session.';
      container.appendChild(box);
      return;
    }

    const grid = document.createElement('dl');
    grid.className = 'usage-grid';
    const rows = [
      ['Input tokens', formatNumber(usage.inputTokens)],
      ['Output tokens', formatNumber(usage.outputTokens)],
      ['Cache read tokens', formatNumber(usage.cacheReadTokens)],
      ['Cache write tokens', formatNumber(usage.cacheCreationTokens)],
      ['Total tokens', formatNumber(usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens)],
    ];
    const cost = formatCost(usage.costUsd);
    rows.push(['Reported cost', cost === null ? 'Not reported' : cost]);
    if (usage.model) {
      rows.push(['Model', usage.model]);
    }

    for (const [label, value] of rows) {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = value;
      grid.appendChild(dt);
      grid.appendChild(dd);
    }
    container.appendChild(grid);

    const note = document.createElement('div');
    note.className = 'hint';
    note.textContent =
      'Counts are exactly what the Claude Code runtime reported for this session. PairPilot never estimates token usage.';
    container.appendChild(note);
  }

  function renderComposer() {
    const textarea = el('task-input');
    if (!composing && textarea.value !== drafts.task) {
      textarea.value = drafts.task;
    }

    const busy = snapshot.isStreaming;
    const awaiting = snapshot.pendingApproval || Boolean(snapshot.activeProposal);

    // The two mid-stream controls exist only while a file is going into the
    // editor. Everywhere else there is no stream to hold and no partial file to
    // take back, and showing them greyed out would advertise something the host
    // would refuse.
    const writing = Boolean(snapshot.writingFile);
    const paused = Boolean(snapshot.writePaused);

    el('send-button').disabled = busy;
    el('cancel-button').disabled = !busy;
    textarea.disabled = busy;

    const pauseButton = el('pause-button');
    pauseButton.hidden = !writing;
    pauseButton.textContent = paused ? 'Resume' : 'Pause';
    pauseButton.setAttribute(
      'aria-label',
      paused ? 'Resume writing the file' : 'Pause writing the file'
    );
    el('change-while-writing-button').hidden = !writing;
    el('writing-feedback').hidden = !writing;

    const hint = el('composer-hint');
    if (writing && paused) {
      hint.textContent = `Paused at ${snapshot.writingFile}. Nobody is writing to the file while it is paused; the rest arrives when you resume.`;
    } else if (writing) {
      hint.textContent = `${snapshot.writingFile} is being written into the editor. Pause to read it, or Change this to have it written differently.`;
    } else if (busy) {
      hint.textContent = 'PairPilot is working. Use Cancel to stop and roll back any partial write.';
    } else if (awaiting) {
      hint.textContent = 'Resolve the review in the Review tab before starting another task.';
    } else if (!snapshot.runtime.available && !snapshot.runtime.pending) {
      hint.textContent = snapshot.runtime.message;
    } else {
      hint.textContent =
        'One file per request. The AI cannot modify files without your approval.';
    }

    const contextButton = el('add-context-button');
    contextButton.disabled = busy;
  }

  function sectionTitle(text) {
    const node = document.createElement('div');
    node.className = 'section-title';
    node.textContent = text;
    return node;
  }

  function bulletList(items, forceLtr) {
    const list = document.createElement('ul');
    list.className = 'tight';
    for (const item of items) {
      const li = document.createElement('li');
      li.textContent = item;
      if (forceLtr) {
        li.setAttribute('dir', 'ltr');
      } else {
        applyDirection(li, item);
      }
      list.appendChild(li);
    }
    return list;
  }

  /* --------------------------------------------------------------- events -- */

  function wire() {
    el('task-input').addEventListener('input', (event) => {
      drafts.task = event.target.value;
      composing = true;
      applyDirection(event.target, drafts.task);
    });
    el('task-input').addEventListener('blur', () => {
      composing = false;
    });
    el('task-input').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        send();
      }
    });

    el('send-button').addEventListener('click', send);
    el('cancel-button').addEventListener('click', () => post({ type: 'cancel' }));
    el('pause-button').addEventListener('click', () =>
      post(snapshot.writePaused ? { type: 'resumeWrite' } : { type: 'pauseWrite' })
    );
    el('change-while-writing-button').addEventListener('click', () => {
      // The feedback box is the composer's own, not a `window.prompt`: VS Code
      // webviews run sandboxed and a modal prompt is silently ignored there,
      // which would make this button appear to do nothing at all.
      const trimmed = el('writing-feedback').value.trim();
      if (trimmed.length === 0) {
        window.alert('Describe what should be different before asking for a change.');
        el('writing-feedback').focus();
        return;
      }
      drafts.feedback = trimmed;
      // Reuses the same request as the post-write "Request changes", so saying
      // "not like that" means the same thing whenever it is said. The host takes
      // the partial file back off disk first, because this write never finished.
      post({ type: 'requestChangesDuringWrite', feedback: trimmed });
    });
    el('add-context-button').addEventListener('click', () =>
      post({ type: 'addActiveEditorContext' })
    );

    for (const tab of document.querySelectorAll('.tab')) {
      tab.addEventListener('click', () => {
        activeTab = tab.getAttribute('data-tab');
        renderTabs();
      });
    }
  }

  function send() {
    const textarea = el('task-input');
    const text = textarea.value.trim();
    if (text.length === 0) {
      return;
    }
    post({ type: 'submitTask', text });
    drafts.task = '';
    textarea.value = '';
    composing = false;
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || typeof message.type !== 'string') {
      return;
    }

    switch (message.type) {
      case 'state':
        snapshot = message.snapshot;
        // The host clears streaming text when a turn settles.
        if (!snapshot.isStreaming) {
          streamingText = '';
        }
        render();
        break;

      case 'textDelta':
        streamingText += message.text;
        if (snapshot) {
          snapshot.isStreaming = true;
          renderChat();
        }
        break;

      case 'writingProgress':
        if (snapshot) {
          snapshot.currentStep = `Writing ${message.relativePath} — ${message.written} of ${message.total} characters`;
          renderTaskStatus();
        }
        break;

      case 'toast':
        // Kept deliberately quiet: the output channel holds the detail.
        break;

      default:
        break;
    }
  });

  wire();
  post({ type: 'ready' });
})();
