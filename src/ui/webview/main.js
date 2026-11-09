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
      const none = document.createElement('span');
      none.className = 'hint';
      none.textContent = 'No file contents were sent with the last request.';
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

  function renderReview() {
    const container = el('review-content');
    container.textContent = '';

    // Stage 1: permission to create or update the file. Nothing exists yet for
    // a create, so this gate is about the path, not the content.
    if (snapshot.state === 'WAITING_FILE_APPROVAL' && snapshot.pendingFilePath) {
      container.appendChild(buildFileApprovalGate());
      return;
    }

    const proposal = snapshot.activeProposal;
    if (!proposal) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No code proposal is awaiting review.';
      container.appendChild(empty);
      return;
    }

    container.appendChild(buildReviewCard(proposal));
  }

  function buildFileApprovalGate() {
    const gate = document.createElement('div');
    gate.className = 'approval-gate';

    const heading = document.createElement('h3');
    heading.textContent =
      snapshot.pendingFileOperation === 'update'
        ? 'Permission to update a file'
        : 'Permission to create a file';
    gate.appendChild(heading);

    const pathLine = document.createElement('div');
    pathLine.className = 'card-sub';
    pathLine.textContent = snapshot.pendingFilePath;
    pathLine.setAttribute('dir', 'ltr');
    gate.appendChild(pathLine);

    const explanation = document.createElement('div');
    explanation.className = 'hint';
    explanation.textContent =
      snapshot.pendingFileOperation === 'update'
        ? 'PairPilot will show you a diff against the current content before anything changes on disk.'
        : 'PairPilot will create this file empty, write the proposed code into your editor, and then ask you to review it. If you reject the code, the file is removed again.';
    gate.appendChild(explanation);

    // A multi-file proposal repeats this gate per file, so the panel says which
    // one this is and what is still to come. Without that, "change 3" would look
    // like an unexplained new request.
    const progress = changeProgress();
    if (progress) {
      const position = document.createElement('div');
      position.className = 'hint';
      position.textContent =
        'This proposal writes ' +
        progress.total +
        ' files. You are being asked about file ' +
        progress.index +
        '. Each file is still shown for review as it is written.';
      gate.appendChild(position);

      const plan = document.createElement('ol');
      plan.className = 'change-plan';
      plan.setAttribute('dir', 'ltr');
      for (let i = 0; i < snapshot.changePlan.length; i++) {
        const entry = snapshot.changePlan[i];
        const item = document.createElement('li');
        // Every field is model-supplied text, so it goes in with textContent.
        item.textContent = entry.operation + ' ' + entry.file;
        if (i + 1 < progress.index) {
          item.className = 'done';
        } else if (i + 1 === progress.index) {
          item.className = 'current';
        }
        plan.appendChild(item);
      }
      gate.appendChild(plan);
    }

    const actions = document.createElement('div');
    actions.className = 'actions';

    const approve = document.createElement('button');
    approve.textContent =
      progress && progress.total > 1
        ? 'Allow this file'
        : snapshot.pendingFileOperation === 'update'
          ? 'Allow update'
          : 'Allow creation';
    approve.addEventListener('click', () => {
      post({ type: 'approveFileCreation', contentHash: currentHash() });
    });
    actions.appendChild(approve);

    // Approving the set is offered only when there is a set, and it approves the
    // same object the host holds — the set hash — so the host can verify it
    // against live state exactly as it verifies a single file.
    if (progress && progress.total > progress.index) {
      const remaining = progress.total - progress.index;
      const approveAll = document.createElement('button');
      approveAll.className = 'secondary';
      approveAll.textContent =
        'Allow all ' + remaining + ' remaining file' + (remaining === 1 ? '' : 's');
      approveAll.addEventListener('click', () => {
        post({ type: 'approveFileCreation', contentHash: progress.setId });
      });
      actions.appendChild(approveAll);
    }

    const reject = document.createElement('button');
    reject.className = 'secondary';
    reject.textContent = 'Decline';
    reject.addEventListener('click', () => {
      post({ type: 'rejectFileCreation', contentHash: currentHash() });
    });
    actions.appendChild(reject);

    gate.appendChild(actions);
    return gate;
  }

  /** The change-set position, or null for a single-file proposal. */
  function changeProgress() {
    if (!snapshot || !snapshot.changeProgress) {
      return null;
    }
    const progress = snapshot.changeProgress;
    if (!progress.total || progress.total < 2) {
      return null;
    }
    return progress;
  }

  /**
   * The content hash to echo back with a decision.
   *
   * The host verifies this against the live proposal, so a stale panel cannot
   * approve something the developer never saw.
   */
  function currentHash() {
    return (snapshot && snapshot.activeProposal && snapshot.activeProposal.contentHash) || '';
  }

  function buildReviewCard(proposal) {
    const card = document.createElement('div');
    card.className = 'card';

    const title = document.createElement('div');
    title.className = 'card-title';
    const name = document.createElement('span');
    name.textContent = proposal.relativePath;
    name.setAttribute('dir', 'ltr');
    title.appendChild(name);
    const op = document.createElement('span');
    op.className = 'state-pill';
    op.textContent = proposal.operation;
    title.appendChild(op);
    card.appendChild(title);

    const desc = document.createElement('div');
    desc.className = 'body-text';
    desc.textContent = proposal.description;
    applyDirection(desc, proposal.description);
    card.appendChild(desc);

    const openButton = document.createElement('button');
    openButton.className = 'link';
    openButton.textContent = 'Open the file in the editor';
    openButton.addEventListener('click', () => {
      post({ type: 'openFile', relativePath: proposal.relativePath });
    });
    card.appendChild(openButton);

    if (proposal.rationale) {
      card.appendChild(sectionTitle('Why this implementation'));
      const body = document.createElement('div');
      body.className = 'body-text';
      body.textContent = proposal.rationale;
      applyDirection(body, proposal.rationale);
      card.appendChild(body);
    }

    if (proposal.responsibilities && proposal.responsibilities.length > 0) {
      card.appendChild(sectionTitle('Responsibilities'));
      card.appendChild(bulletList(proposal.responsibilities));
    }

    if (proposal.dependencies && proposal.dependencies.length > 0) {
      card.appendChild(sectionTitle('Dependencies'));
      card.appendChild(bulletList(proposal.dependencies, true));
    }

    if (proposal.potentialProblems && proposal.potentialProblems.length > 0) {
      card.appendChild(sectionTitle('Potential problems'));
      const box = document.createElement('div');
      box.className = 'warning-box';
      const list = document.createElement('ul');
      list.className = 'tight';
      for (const item of proposal.potentialProblems) {
        const li = document.createElement('li');
        li.textContent = item;
        applyDirection(li, item);
        list.appendChild(li);
      }
      box.appendChild(list);
      card.appendChild(box);
    }

    card.appendChild(sectionTitle('Code'));
    for (const block of proposal.blocks) {
      const label = document.createElement('div');
      label.className = 'card-sub';
      label.textContent = `${block.id} · ${block.type}${block.description ? ' · ' + block.description : ''}`;
      card.appendChild(label);
      const pre = document.createElement('pre');
      pre.className = 'code';
      pre.textContent = block.code;
      card.appendChild(pre);
    }

    if (proposal.nextStep) {
      card.appendChild(sectionTitle('Suggested next step'));
      const next = document.createElement('div');
      next.className = 'hint';
      next.textContent = `${proposal.nextStep.title} — ${proposal.nextStep.reason}`;
      applyDirection(next, next.textContent);
      card.appendChild(next);
    }

    card.appendChild(buildReviewActions(proposal));
    return card;
  }

  function buildReviewActions(proposal) {
    const section = document.createElement('div');

    const feedbackLabel = document.createElement('div');
    feedbackLabel.className = 'section-title';
    feedbackLabel.textContent = 'Feedback for a revision';
    section.appendChild(feedbackLabel);

    const textarea = document.createElement('textarea');
    textarea.rows = 3;
    textarea.placeholder = 'Describe what should change…';
    textarea.value = drafts.feedback;
    textarea.addEventListener('input', () => {
      drafts.feedback = textarea.value;
    });
    applyDirection(textarea, textarea.value);
    section.appendChild(textarea);

    const actions = document.createElement('div');
    actions.className = 'actions';

    const approve = document.createElement('button');
    approve.textContent = 'Approve';
    approve.addEventListener('click', () => {
      post({ type: 'approveCode', contentHash: proposal.contentHash });
    });
    actions.appendChild(approve);

    const reject = document.createElement('button');
    reject.className = 'danger';
    reject.textContent = 'Reject';
    reject.addEventListener('click', () => {
      post({ type: 'rejectCode', contentHash: proposal.contentHash });
    });
    actions.appendChild(reject);

    const revise = document.createElement('button');
    revise.className = 'secondary';
    revise.textContent = 'Request changes';
    revise.addEventListener('click', () => {
      if (drafts.feedback.trim().length === 0) {
        window.alert('Describe the changes you want before requesting a revision.');
        return;
      }
      post({
        type: 'requestChanges',
        contentHash: proposal.contentHash,
        feedback: drafts.feedback,
      });
      drafts.feedback = '';
    });
    actions.appendChild(revise);

    section.appendChild(actions);
    return section;
  }

  function renderAdvisor() {
    const container = el('advisor-content');
    container.textContent = '';
    const rec = snapshot.recommendation;
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

    el('send-button').disabled = busy;
    el('cancel-button').disabled = !busy;
    textarea.disabled = busy;

    const hint = el('composer-hint');
    if (busy) {
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

      case 'codeDelta':
        if (snapshot) {
          if (!snapshot.streamingCode) {
            snapshot.streamingCode = [];
          }
          snapshot.streamingCode[message.blockIndex] =
            (snapshot.streamingCode[message.blockIndex] || '') + message.text;
          renderTaskStatus();
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
