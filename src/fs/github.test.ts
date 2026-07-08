import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseGithubRepoInput, fetchGithubTree } from './github';

describe('github', () => {
  describe('parseGithubRepoInput', () => {
    it('parses owner/repo', () => {
      expect(parseGithubRepoInput('foo/bar')).toEqual({ owner: 'foo', repo: 'bar' });
    });
    it('parses full URL', () => {
      expect(parseGithubRepoInput('https://github.com/foo/bar')).toEqual({ owner: 'foo', repo: 'bar' });
      expect(parseGithubRepoInput('http://www.github.com/foo/bar/')).toEqual({ owner: 'foo', repo: 'bar' });
    });
    it('removes .git', () => {
      expect(parseGithubRepoInput('foo/bar.git')).toEqual({ owner: 'foo', repo: 'bar' });
      expect(parseGithubRepoInput('https://github.com/foo/bar.git')).toEqual({ owner: 'foo', repo: 'bar' });
    });
    it('returns null for invalid inputs', () => {
      expect(parseGithubRepoInput('foo')).toBeNull();
      expect(parseGithubRepoInput('https://google.com/foo/bar')).toBeNull();
    });
  });

  describe('fetchGithubTree', () => {
    let mockFetch: any;

    beforeEach(() => {
      mockFetch = vi.fn();
      vi.stubGlobal('fetch', mockFetch);
      vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('throws if default branch fetch fails', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404, statusText: 'Not Found' });
      await expect(fetchGithubTree({ owner: 'foo', repo: 'bar' })).rejects.toThrow(/not found or inaccessible/i);
    });

    it('throws if tree fetch fails', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ default_branch: 'main' }) });
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Error' });
      await expect(fetchGithubTree({ owner: 'foo', repo: 'bar' })).rejects.toThrow(/Failed to fetch repository tree/i);
    });

    it('builds a tree from fetched data', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ default_branch: 'main' }) });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          tree: [
            { path: 'src/main.ts', type: 'blob' },
            { path: 'src/nested/deep.ts', type: 'blob' }, // hit truthy accPath
            { path: 'README.md', type: 'blob' },
            { path: 'node_modules/foo/bar.ts', type: 'blob' }, // should be ignored
            { path: 'dist/index.js', type: 'blob' }, // should be ignored
            { path: 'some-dir', type: 'tree' } // hit non-blob
          ],
          truncated: true
        })
      });

      const tree = await fetchGithubTree({ owner: 'foo', repo: 'bar' });

      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('was truncated'));

      expect(tree.name).toBe('bar');
      expect(tree.kind).toBe('directory');
      expect(tree.children).toHaveLength(2);

      // Directories first (src), then files (README.md)
      expect(tree.children![0].name).toBe('src');
      expect(tree.children![0].kind).toBe('directory');
      expect(tree.children![0].children![0].name).toBe('nested');
      expect(tree.children![0].children![0].kind).toBe('directory');
      expect(tree.children![0].children![1].name).toBe('main.ts');
      
      expect(tree.children![1].name).toBe('README.md');

      // Test DIRECTORY_STUB
      await expect((tree.handle as any).getFile()).rejects.toThrow('Not a file');

      // Test GithubFileHandle
      const fileNode = tree.children![1];
      expect(fileNode.kind).toBe('file');

      // Test fetch from github file handle
      const fileHandle = fileNode.handle as any;
      
      mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'hello world' });
      const fileObj = await fileHandle.getFile();
      const text = await fileObj.text();
      expect(text).toBe('hello world');
      expect(mockFetch).toHaveBeenCalledWith('https://raw.githubusercontent.com/foo/bar/main/README.md');

      // Test caching
      const text2 = await fileObj.text();
      expect(text2).toBe('hello world');
      expect(mockFetch).toHaveBeenCalledTimes(3); // no extra fetch

      const fileObj2 = await fileHandle.getFile();
      expect(await fileObj2.text()).toBe('hello world');
      expect(mockFetch).toHaveBeenCalledTimes(3); // still no extra fetch
    });

    it('throws if file fetch fails', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ default_branch: 'main' }) });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ tree: [{ path: 'test.txt', type: 'blob' }] })
      });

      const tree = await fetchGithubTree({ owner: 'foo', repo: 'bar' });
      const handle = tree.children![0].handle as any;

      mockFetch.mockResolvedValueOnce({ ok: false, status: 404, statusText: 'Not Found' });
      await expect(handle.getFile()).rejects.toThrow(/Failed to fetch/i);
    });
  });
});
