// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isFileSystemAccessSupported,
  pickDirectory,
  pickWorkspace,
  readDirectoryTree,
  compareNodes,
  readFileText,
  type TreeNode
} from './workspace';

describe('workspace', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('isFileSystemAccessSupported', () => {
    it('returns true if showDirectoryPicker exists', () => {
      vi.stubGlobal('window', { showDirectoryPicker: vi.fn() });
      expect(isFileSystemAccessSupported()).toBe(true);
    });

    it('returns false if showDirectoryPicker does not exist', () => {
      vi.stubGlobal('window', {});
      expect(isFileSystemAccessSupported()).toBe(false);
    });
  });

  describe('pickDirectory', () => {
    it('throws if API is not available', async () => {
      vi.stubGlobal('window', {});
      await expect(pickDirectory('id')).rejects.toThrow(/not available/i);
    });

    it('returns handle on success', async () => {
      const handle = {};
      vi.stubGlobal('window', {
        showDirectoryPicker: vi.fn().mockResolvedValue(handle),
      });
      const result = await pickDirectory('my-id');
      expect(window.showDirectoryPicker).toHaveBeenCalledWith({ id: 'my-id', mode: 'read' });
      expect(result).toBe(handle);
    });

    it('returns null on AbortError', async () => {
      vi.stubGlobal('window', {
        showDirectoryPicker: vi.fn().mockRejectedValue(new DOMException('abort', 'AbortError')),
      });
      const result = await pickDirectory('id');
      expect(result).toBeNull();
    });

    it('throws other errors', async () => {
      const err = new Error('Other error');
      vi.stubGlobal('window', {
        showDirectoryPicker: vi.fn().mockRejectedValue(err),
      });
      await expect(pickDirectory('id')).rejects.toThrow('Other error');
    });
  });

  describe('pickWorkspace', () => {
    it('calls pickDirectory with codeenstein-workspace', async () => {
      const handle = {};
      vi.stubGlobal('window', {
        showDirectoryPicker: vi.fn().mockResolvedValue(handle),
      });
      const result = await pickWorkspace();
      expect(window.showDirectoryPicker).toHaveBeenCalledWith({ id: 'codeenstein-workspace', mode: 'read' });
      expect(result).toBe(handle);
    });
  });

  describe('compareNodes', () => {
    it('sorts directories before files', () => {
      const a = { kind: 'directory', name: 'a' } as TreeNode;
      const b = { kind: 'file', name: 'b' } as TreeNode;
      expect(compareNodes(a, b)).toBe(-1);
      expect(compareNodes(b, a)).toBe(1);
    });

    it('sorts alphabetically case-insensitive', () => {
      const a = { kind: 'file', name: 'a' } as TreeNode;
      const b = { kind: 'file', name: 'B' } as TreeNode;
      expect(compareNodes(a, b)).toBe(-1);
      expect(compareNodes(b, a)).toBe(1);
    });
  });

  describe('readFileText', () => {
    it('calls getFile and text()', async () => {
      const handle = {
        getFile: vi.fn().mockResolvedValue({
          text: vi.fn().mockResolvedValue('file content')
        })
      };
      const text = await readFileText(handle as any);
      expect(text).toBe('file content');
    });
  });

  describe('readDirectoryTree', () => {
    it('builds a tree, ignores directories, sorts children', async () => {
      const file1 = { kind: 'file', name: 'fileB' };
      const file2 = { kind: 'file', name: 'fileA' };
      const ignoredDir = { kind: 'directory', name: 'node_modules' };
      const nestedDir = {
        kind: 'directory',
        name: 'src',
        values: async function* () {
          yield { kind: 'file', name: 'index.ts' };
        }
      };
      
      const rootDir = {
        kind: 'directory',
        name: 'root',
        values: async function* () {
          yield file1;
          yield file2;
          yield ignoredDir;
          yield nestedDir;
        }
      };

      const tree = await readDirectoryTree(rootDir as any);
      
      expect(tree.name).toBe('root');
      expect(tree.path).toBe('root');
      expect(tree.kind).toBe('directory');
      expect(tree.children).toHaveLength(3);
      
      expect(tree.children![0].name).toBe('src');
      expect(tree.children![0].path).toBe('root/src');
      expect(tree.children![0].children).toHaveLength(1);
      expect(tree.children![0].children![0].name).toBe('index.ts');
      expect(tree.children![0].children![0].path).toBe('root/src/index.ts');

      expect(tree.children![1].name).toBe('fileA');
      expect(tree.children![1].path).toBe('root/fileA');
      
      expect(tree.children![2].name).toBe('fileB');
      expect(tree.children![2].path).toBe('root/fileB');
    });

    it('works with parentPath', async () => {
      const rootDir = {
        kind: 'directory',
        name: 'sub',
        values: async function* () {}
      };
      const tree = await readDirectoryTree(rootDir as any, 'parent');
      expect(tree.path).toBe('parent/sub');
    });
  });
});
