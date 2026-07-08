import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BgmPlayer, bgm } from './bgm';
import { audio } from './audio';

describe('BgmPlayer', () => {
  let player: BgmPlayer;
  let playMock: any;
  let pauseMock: any;

  beforeEach(() => {
    // URL mocking
    global.URL.createObjectURL = vi.fn(() => 'blob:mock-url');
    global.URL.revokeObjectURL = vi.fn();

    // Audio element mocking
    if (!window.HTMLAudioElement.prototype.play) {
      window.HTMLAudioElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    }
    if (!window.HTMLAudioElement.prototype.pause) {
      window.HTMLAudioElement.prototype.pause = vi.fn();
    }
    
    playMock = vi.spyOn(window.HTMLAudioElement.prototype, 'play').mockResolvedValue(undefined);
    pauseMock = vi.spyOn(window.HTMLAudioElement.prototype, 'pause').mockImplementation(() => {});
    
    vi.spyOn(audio, 'isSilenced').mockReturnValue(false);
    
    // AudioContext mocking for MediaElementSource
    if (!window.AudioContext.prototype.createMediaElementSource) {
      window.AudioContext.prototype.createMediaElementSource = vi.fn(() => ({}) as any);
    }

    player = new BgmPlayer();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exports a singleton', () => {
    expect(bgm).toBeInstanceOf(BgmPlayer);
  });

  it('initially has 0 tracks', () => {
    expect(player.trackCount).toBe(0);
  });

  it('stops playback', () => {
    player.stop();
    expect(pauseMock).toHaveBeenCalled();
  });

  describe('loadFolder', () => {
    it('returns 0 and does not play for an empty folder', async () => {
      const mockDir = {
        values: async function* () {
          // empty
        }
      } as unknown as FileSystemDirectoryHandle;

      const count = await player.loadFolder(mockDir);
      expect(count).toBe(0);
      expect(player.trackCount).toBe(0);
      expect(playMock).not.toHaveBeenCalled();
    });

    it('loads playable files and shuffles them, ignoring non-BGM extensions', async () => {
      const mockDir = {
        values: async function* () {
          yield { kind: 'file', name: 'track1.mp3', getFile: async () => new Blob() };
          yield { kind: 'file', name: 'track2.ogg', getFile: async () => new Blob() };
          yield { kind: 'file', name: 'track3.wav', getFile: async () => new Blob() };
          yield { kind: 'file', name: 'track4.WAV', getFile: async () => new Blob() };
          yield { kind: 'file', name: 'doc.txt', getFile: async () => new Blob() };
          yield { kind: 'directory', name: 'sub.mp3' };
        }
      } as unknown as FileSystemDirectoryHandle;

      const resumeSpy = vi.spyOn(audio, 'resume');
      const connectSpy = vi.spyOn(audio, 'connectBgmSource');

      const count = await player.loadFolder(mockDir);
      expect(count).toBe(4);
      expect(player.trackCount).toBe(4);
      expect(playMock).toHaveBeenCalled();
      expect(resumeSpy).toHaveBeenCalled();
      expect(connectSpy).toHaveBeenCalled();
    });
  });

  describe('playback logic', () => {
    it('wireAndPlay returns early if audio is silenced', async () => {
      vi.spyOn(audio, 'isSilenced').mockReturnValue(true);
      const mockDir = {
        values: async function* () {
          yield { kind: 'file', name: 'test.mp3', getFile: async () => new Blob() };
        }
      } as unknown as FileSystemDirectoryHandle;

      await player.loadFolder(mockDir);
      expect(playMock).not.toHaveBeenCalled();
    });

    it('revokes previous object URLs when advancing', async () => {
      const mockDir = {
        values: async function* () {
          yield { kind: 'file', name: 'test1.mp3', getFile: async () => new Blob() };
          yield { kind: 'file', name: 'test2.mp3', getFile: async () => new Blob() };
        }
      } as unknown as FileSystemDirectoryHandle;

      await player.loadFolder(mockDir);
      
      const audioEl = (player as any).el;
      const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');
      
      audioEl.dispatchEvent(new Event('ended'));
      await new Promise(r => setTimeout(r, 50));
      
      expect(revokeSpy).toHaveBeenCalledTimes(1);
      expect(revokeSpy).toHaveBeenCalledWith('blob:mock-url');
    });

    it('creates MediaElementSource only once', async () => {
      const mockDir = {
        values: async function* () {
          yield { kind: 'file', name: 'test1.mp3', getFile: async () => new Blob() };
          yield { kind: 'file', name: 'test2.mp3', getFile: async () => new Blob() };
        }
      } as unknown as FileSystemDirectoryHandle;

      const createSourceSpy = vi.spyOn(window.AudioContext.prototype, 'createMediaElementSource');
      await player.loadFolder(mockDir);
      expect(createSourceSpy).toHaveBeenCalledTimes(1);

      const audioEl = (player as any).el;
      
      audioEl.dispatchEvent(new Event('ended'));
      await new Promise(r => setTimeout(r, 50));

      // Advance should reuse the source node
      expect(createSourceSpy).toHaveBeenCalledTimes(1);
    });

    it('does not throw when play() rejects', async () => {
      playMock.mockRejectedValueOnce(new Error('autoplay blocked'));
      
      const mockDir = {
        values: async function* () {
          yield { kind: 'file', name: 'test.mp3', getFile: async () => new Blob() };
        }
      } as unknown as FileSystemDirectoryHandle;

      // Ensure that an exception is not thrown back to the caller
      await expect(player.loadFolder(mockDir)).resolves.toBe(1);
    });
    
    it('advance does nothing if no handles', async () => {
      // simulate "ended" event firing before loading any files
      const audioEl = (player as any).el;
      audioEl.dispatchEvent(new Event('ended'));
      expect(playMock).not.toHaveBeenCalled();
    });
    
    it('playCurrent returns early if handles are empty', async () => {
      // edge case branch inside playCurrent
      await (player as any).playCurrent();
      expect(playMock).not.toHaveBeenCalled();
    });
    
    it('does not create source if resume returns null', async () => {
      vi.spyOn(audio, 'resume').mockReturnValue(null);
      const mockDir = {
        values: async function* () {
          yield { kind: 'file', name: 'test.mp3', getFile: async () => new Blob() };
        }
      } as unknown as FileSystemDirectoryHandle;

      const createSourceSpy = vi.spyOn(window.AudioContext.prototype, 'createMediaElementSource');
      await player.loadFolder(mockDir);
      expect(createSourceSpy).not.toHaveBeenCalled();
    });
  });
});
