import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHighscoreTable } from './highscorePanel';
import type { HighscoreEntry } from '../engine/highscores';

describe('highscorePanel', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
  });

  it('renders empty message when no entries', () => {
    renderHighscoreTable(container, []);
    expect(container.querySelector('p')?.textContent).toContain('No runs recorded yet');
  });

  it('renders a table with entries', () => {
    const entries: HighscoreEntry[] = [
      {
        score: 1000,
        campaignName: 'Test Campaign',
        codebaseLinesOfCode: 500,
        codebaseComplexity: 10,
        levelsCleared: 3,
        levelName: 'Level 3',
        hash: 'abc123def456abc',
        timestampMs: 0,
      },
      {
        score: 500,
        campaignName: 'Test Campaign 2',
        levelsCleared: 1,
        levelName: 'Level 1',
        hash: 'def456',
        timestampMs: 0,
        replay: { version: 2, levels: [{}] } as any
      }
    ];

    const onWatchReplay = vi.fn();
    renderHighscoreTable(container, entries, { onWatchReplay });

    const table = container.querySelector('table.highscore-table')!;
    expect(table).not.toBeNull();

    const tbody = table.querySelector('tbody')!;
    expect(tbody.children).toHaveLength(2);

    const row1 = tbody.children[0];
    const cells1 = row1.querySelectorAll('td');
    expect(cells1[0].textContent).toBe('1');
    expect(cells1[1].textContent).toBe((1000).toLocaleString());
    expect(cells1[2].textContent).toBe('Test Campaign');
    expect(cells1[3].textContent).toBe((500).toLocaleString());
    expect(cells1[4].textContent).toBe('10');
    expect(cells1[5].textContent).toBe('3');
    expect(cells1[6].textContent).toBe('Level 3');
    expect(cells1[8].textContent).toBe('—'); // no replay

    const row2 = tbody.children[1];
    const cells2 = row2.querySelectorAll('td');
    expect(cells2[3].textContent).toBe('—');
    expect(cells2[4].textContent).toBe('—');
    
    const replayBtn = cells2[8].querySelector('button');
    expect(replayBtn).not.toBeNull();
    
    replayBtn!.click();
    expect(onWatchReplay).toHaveBeenCalledWith(entries[1]);
  });
});
