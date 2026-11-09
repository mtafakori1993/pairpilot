/**
 * The panel's own sentences.
 *
 * These are small, which is why they are worth pinning: a notice is the one
 * place the panel speaks about something the developer cannot see for
 * themselves, and a sentence that overstates what happened — "refreshed" for a
 * refresh that failed, "now in use" for a selection that was refused — is worse
 * than no sentence at all.
 */

import { describe, expect, it } from 'vitest';
import {
  catalogNotice,
  destinationLabel,
  selectionClearedNotice,
  selectionSetNotice,
} from '../../src/ui/PanelNotices';

describe('a catalogue refresh', () => {
  it('reports how many models arrived', () => {
    const notice = catalogNotice({ status: 'refreshed', count: 412 });
    expect(notice.level).toBe('info');
    expect(notice.text).toContain('412');
    expect(notice.text).toContain('OpenRouter');
  });

  it('says "1 model" rather than "1 models"', () => {
    expect(catalogNotice({ status: 'refreshed', count: 1 }).text).toContain('1 model from');
  });

  it('names what is still on hand when a refresh fails', () => {
    // "The refresh failed" beside a full Explorer and beside an empty one are
    // different situations, and the sentence has to tell them apart.
    const withModels = catalogNotice({ status: 'failed', error: 'socket hang up', count: 40 });
    expect(withModels.level).toBe('warning');
    expect(withModels.text).toContain('socket hang up');
    expect(withModels.text).toContain('40 models already loaded');
    expect(withModels.text).toContain('out of date');

    const empty = catalogNotice({ status: 'failed', error: 'socket hang up', count: 0 });
    expect(empty.text).toContain('socket hang up');
    expect(empty.text).not.toContain('already loaded');
  });

  it('reports a skipped refresh as skipped, not as a failure', () => {
    // The catalogue is untouched by a skipped refresh, so this is information
    // rather than a warning.
    const notice = catalogNotice({ status: 'skipped' });
    expect(notice.level).toBe('info');
    expect(notice.text).toContain('already running');
  });
});

describe('naming a selection level', () => {
  it('uses the level label a sentence needs, not the table row', () => {
    expect(destinationLabel('global', null)).toBe('the global default');
    expect(destinationLabel('project', '/repo')).toBe('this project');
  });

  it('names a role by the label the rest of the UI shows', () => {
    expect(destinationLabel('role', 'coding')).toBe('the Coding role');
    expect(destinationLabel('role', 'large-repo-analysis')).toBe('the Large Repository Analysis role');
  });

  it('falls back to the raw key rather than inventing a name', () => {
    // A role id the build does not know is still better reported as itself than
    // described with a label PairPilot made up.
    expect(destinationLabel('role', 'something-new')).toBe('the something-new role');
    expect(destinationLabel('task', 'a-task')).toBe('the a-task task');
    expect(destinationLabel('role', null)).toContain('unknown');
  });
});

describe('a selection change', () => {
  it('says which model now applies, and where', () => {
    const notice = selectionSetNotice('vendor/one', 'role', 'coding');
    expect(notice.level).toBe('info');
    expect(notice.text).toBe('vendor/one is now used for the Coding role.');
  });

  it('says what happens next when a level is cleared', () => {
    // A cleared level is not "no model": it is the next level down.
    const notice = selectionClearedNotice('role', 'coding');
    expect(notice.text).toContain('Cleared the Coding role');
    expect(notice.text).toContain('falls back');
    expect(notice.text).toContain('default');
  });
});
