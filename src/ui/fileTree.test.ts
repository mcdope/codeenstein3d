// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderFileTree } from './fileTree';
import type { TreeNode } from '../fs/workspace';

describe('fileTree', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
  });

  it('renders an empty root directory', () => {
    const root: TreeNode = {
      name: 'root',
      path: 'root',
      kind: 'directory',
      handle: {} as any,
      children: [],
    };
    renderFileTree(container, root, { onSelectFile: vi.fn() });
    
    const ul = container.querySelector('ul.tree-list');
    expect(ul).not.toBeNull();
    expect(ul?.children).toHaveLength(0);
  });

  it('renders a directory with files and toggles on click', () => {
    const root: TreeNode = {
      name: 'root',
      path: 'root',
      kind: 'directory',
      handle: {} as any,
      children: [
        {
          name: 'src',
          path: 'root/src',
          kind: 'directory',
          handle: {} as any,
          children: [
            {
              name: 'index.ts',
              path: 'root/src/index.ts',
              kind: 'file',
              handle: {} as any,
            }
          ]
        },
        {
          name: 'README.md',
          path: 'root/README.md',
          kind: 'file',
          handle: {} as any,
        }
      ],
    };
    const onSelectFile = vi.fn();
    renderFileTree(container, root, { onSelectFile });
    
    const ul = container.querySelector('ul.tree-list')!;
    expect(ul.children).toHaveLength(2);

    const dirItem = ul.children[0] as HTMLLIElement;
    const fileItem = ul.children[1] as HTMLLIElement;

    // Check directory rendering
    const dirRow = dirItem.querySelector('.tree-row--directory') as HTMLButtonElement;
    expect(dirRow).not.toBeNull();
    expect(dirRow.title).toBe('root/src');
    expect(dirRow.textContent).toContain('📁 src');

    const twisty = dirRow.querySelector('.tree-twisty') as HTMLSpanElement;
    expect(twisty.classList.contains('tree-twisty--open')).toBe(false);

    const childList = dirItem.querySelector('ul.tree-list') as HTMLUListElement;
    expect(childList.hidden).toBe(true);

    // Toggle directory
    dirRow.click();
    expect(childList.hidden).toBe(false);
    expect(twisty.classList.contains('tree-twisty--open')).toBe(true);
    
    // Toggle again
    dirRow.click();
    expect(childList.hidden).toBe(true);
    expect(twisty.classList.contains('tree-twisty--open')).toBe(false);

    // Check file rendering
    const fileRow = fileItem.querySelector('.tree-row--file') as HTMLButtonElement;
    expect(fileRow).not.toBeNull();
    expect(fileRow.title).toBe('root/README.md');
    expect(fileRow.textContent).toContain('📄 README.md');

    // Click file
    fileRow.click();
    expect(onSelectFile).toHaveBeenCalledWith(root.children![1]);

    // Click nested file
    const nestedFileRow = childList.querySelector('.tree-row--file') as HTMLButtonElement;
    nestedFileRow.click();
    expect(onSelectFile).toHaveBeenCalledWith(root.children![0].children![0]);
  });

  it('handles node with undefined children', () => {
    const root: TreeNode = {
      name: 'root',
      path: 'root',
      kind: 'directory',
      handle: {} as any,
      children: [
        {
          name: 'empty_dir',
          path: 'root/empty_dir',
          kind: 'directory',
          handle: {} as any,
          // children is omitted here to hit line 56 fallback
        }
      ]
    };
    renderFileTree(container, root, { onSelectFile: vi.fn() });
    
    const ul = container.querySelector('ul.tree-list');
    expect(ul?.children).toHaveLength(1);
    
    const dirItem = ul!.children[0] as HTMLLIElement;
    const childList = dirItem.querySelector('ul.tree-list') as HTMLUListElement;
    expect(childList.children).toHaveLength(0);
  });
});
