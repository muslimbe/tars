import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import type { Message } from 'grammy/types';
import { describe, expect, it } from 'vitest';

import type { ChatMessage } from '../../src/message.ts';
import { AttachmentStore } from '../../src/stores/attachments.ts';
import { attachmentIngest, downloadFile } from '../../src/telegram/attachments.ts';
import { createBot } from '../../src/telegram/bot.ts';
import { readAttachmentTool } from '../../src/tools/telegram/attachment.ts';
import { FakeTelegram } from '../fakes/telegram.ts';
import { memoryLogger } from '../helpers/log.ts';
import { tempDir } from '../helpers/tmp.ts';

/** Stands for "the download succeeded but left no file". */
const NOTHING = Symbol('nothing');

function setup(maxBytes = 20_000_000) {
  const fake = new FakeTelegram();
  const bot = createBot('1:t', { network: fake.transformer, botInfo: fake.botInfo });
  const log = memoryLogger();
  const dir = join(tempDir(), 'attachments');
  /** What the file server holds per file_id: bytes, a failure, or nothing at all. */
  const files = new Map<string, string | Buffer | Error | typeof NOTHING>();
  const urls: string[] = [];
  const download = (url: string, dest: string): Promise<void> => {
    urls.push(url);
    const body = files.get(url.slice(url.lastIndexOf('/') + 1)) ?? '';
    if (body instanceof Error) return Promise.reject(body);
    if (body !== NOTHING) writeFileSync(dest, body);
    return Promise.resolve();
  };
  const hook = attachmentIngest({ api: bot.api, download, dir, maxBytes, log });
  /** Run the hook on a message; returns the text the dispatcher then persists. */
  const ingest = async (extra: Record<string, unknown>, text = '', messageId = 10): Promise<string> => {
    const msg = { message_id: messageId, date: 1_700_000_000, chat: { id: 111, type: 'private', first_name: 'Ali' }, ...extra } as Message;
    const cm: ChatMessage = { chatId: 111, messageId, userId: 111, direction: 'in', timestamp: new Date(), text };
    await hook(msg, cm);
    return cm.text;
  };
  return { fake, log, dir, files, urls, ingest };
}

const doc = (file_name: string | undefined, mime_type?: string, file_size?: number) => ({ document: { file_id: 'doc', file_unique_id: 'u', file_name, mime_type, file_size } });

describe('attachment ingest', () => {
  it('downloads the largest photo size and appends its marker after the caption', async () => {
    const t = setup();
    t.files.set('big', 'jpg');
    const photo = [{ file_id: 'small', file_unique_id: 's', width: 90, height: 90, file_size: 1 }, { file_id: 'big', file_unique_id: 'b', width: 900, height: 900, file_size: 3 }];
    const text = await t.ingest({ photo, caption: 'look' }, 'look');
    const dest = join(t.dir, '111', '10_photo_10.jpg');
    expect(text).toBe(`look\n[attachment: ${dest} type=image/jpeg size=3B filename=photo_10.jpg]`);
    expect(t.fake.sent('getFile').map((c) => c.payload)).toEqual([{ file_id: 'big' }]);
    expect(t.urls).toEqual(['https://api.telegram.org/file/bot1:t/files/big']);
    expect(readFileSync(dest, 'utf8')).toBe('jpg');
    expect(t.log.text()).toContain(`INFO attachment saved chat=111 msg=10 path=${dest} size=3 kind=image`);
  });

  it('leaves messages without files alone, and gives a file-only message just the marker', async () => {
    const t = setup();
    expect(await t.ingest({ text: 'plain' }, 'plain')).toBe('plain');
    expect(existsSync(join(t.dir, '111'))).toBe(false);
    t.files.set('doc', 'x');
    expect(await t.ingest(doc(undefined, 'application/pdf'))).toBe(`[attachment: ${join(t.dir, '111', '10_document_10')} type=application/pdf size=1B filename=document_10]`);
  });

  it('accepts images by extension or image/* MIME, PDFs by extension or MIME, text by extension only', async () => {
    const t = setup();
    const cases: [string, string | undefined, string][] = [
      ...['jpg', 'jpeg', 'png', 'webp', 'gif'].map((ext): [string, undefined, string] => [`a.${ext}`, undefined, 'type=image/jpeg']),
      ['photo.HEIC', 'image/heic', 'type=image/heic'],
      ['scan.pdf', undefined, 'type=application/pdf'],
      ['blob.bin', 'application/pdf', 'type=application/pdf'],
      ['notes.md', undefined, 'type=text/plain'],
      ['run.exe', 'application/octet-stream', 'reason=unsupported_type'],
      ['README', 'text/plain', 'reason=unsupported_type'],
    ];
    for (const [i, [name, mime, expected]] of cases.entries()) expect(await t.ingest(doc(name, mime), '', 100 + i)).toContain(expected);
    expect(t.log.text()).toContain('attachment rejected chat=111 msg=109 filename=run.exe mime=application/octet-stream reason=unsupported_type');
    expect(t.log.text()).toContain('attachment rejected chat=111 msg=110 filename=README mime=text/plain reason=unsupported_type');
  });

  it('saves voice notes, audio, video and video notes, naming them when Telegram gave no name', async () => {
    const t = setup();
    const file = (file_id: string, extra: Record<string, unknown> = {}) => ({ file_id, file_unique_id: file_id, duration: 3, file_size: 5, ...extra });
    for (const id of ['v', 'a', 'vid', 'vn']) t.files.set(id, 'bytes');
    const at = (name: string) => join(t.dir, '111', name);
    expect(await t.ingest({ voice: file('v') }, '', 10)).toBe(`[attachment: ${at('10_voice_10.ogg')} type=audio/ogg size=5B filename=voice_10.ogg]`);
    expect(await t.ingest({ audio: file('a', { file_name: 'talk.mp3', mime_type: 'audio/mpeg' }) }, '', 11)).toBe(`[attachment: ${at('11_talk.mp3')} type=audio/mpeg size=5B filename=talk.mp3]`);
    expect(await t.ingest({ video: file('vid', { width: 1, height: 1 }) }, '', 12)).toBe(`[attachment: ${at('12_video_12.mp4')} type=video/mp4 size=5B filename=video_12.mp4]`);
    expect(await t.ingest({ video_note: file('vn', { length: 1 }) }, '', 13)).toBe(`[attachment: ${at('13_video_note_13.mp4')} type=video/mp4 size=5B filename=video_note_13.mp4]`);
    expect(t.log.text()).toContain(`INFO attachment saved chat=111 msg=10 path=${at('10_voice_10.ogg')} size=5 kind=media`);
  });

  it('accepts audio and video documents by extension or audio/* and video/* MIME', async () => {
    const t = setup();
    expect(await t.ingest(doc('meeting.m4a'), '', 20)).toContain('type=application/octet-stream size=');
    expect(await t.ingest(doc('blob', 'audio/x-wav'), '', 21)).toContain('type=audio/x-wav size=');
    expect(await t.ingest(doc('clip.bin', 'video/quicktime'), '', 22)).toContain('type=video/quicktime size=');
    expect(t.log.text()).not.toContain('reason=unsupported_type');
  });

  it('refuses unsupported types first, then files over the size cap, without downloading', async () => {
    const t = setup();
    expect(await t.ingest(doc('big.pdf', undefined, 20_000_001))).toBe('[attachment rejected: filename=big.pdf reason=too_large size=19.1MB]');
    expect(await t.ingest(doc('big.exe', undefined, 20_000_001))).toBe('[attachment rejected: filename=big.exe reason=unsupported_type]');
    expect(t.log.text()).toContain('attachment rejected chat=111 msg=10 filename=big.exe mime=unknown reason=unsupported_type');
    expect(t.log.text()).toContain('attachment rejected chat=111 msg=10 filename=big.pdf size=20000001 reason=too_large');
    expect(t.fake.sent('getFile')).toEqual([]);
    expect(await t.ingest(doc('unknown-size.pdf'))).toContain('[attachment: ');
  });

  it('prints sizes in binary units with one decimal', async () => {
    const t = setup(0);
    const sizes: [number, string][] = [
      [1023, '1023B'], [1024, '1.0KB'], [1280, '1.3KB'], [1_048_576, '1.0MB'], [47_185_920, '45.0MB'], [1_073_741_824, '1.0GB'],
    ];
    for (const [size, shown] of sizes) expect(await t.ingest(doc('f.pdf', undefined, size))).toBe(`[attachment rejected: filename=f.pdf reason=too_large size=${shown}]`);
  });

  it('saves under a safe name: no separators or NULs, trimmed, at most 120 bytes with the extension kept', async () => {
    const t = setup();
    const saved = async (name: string, mime?: string) => /\[attachment: (\S+) /.exec(await t.ingest(doc(name, mime)))?.[1];
    expect(await saved('../../etc/passwd.txt')).toBe(join(t.dir, '111', '10__.._etc_passwd.txt'));
    expect(await saved('a\\b\0c.txt')).toBe(join(t.dir, '111', '10_a_bc.txt'));
    expect(await saved('...', 'application/pdf')).toBe(join(t.dir, '111', '10_file_10'));
    expect(await saved(`${'x'.repeat(130)}.PDF`)).toBe(join(t.dir, '111', `10_${'x'.repeat(116)}.pdf`));
    // The cap counts bytes, never splitting a character, so the name fits Linux's 255-byte limit.
    expect(await saved(`${'😀'.repeat(130)}.png`)).toBe(join(t.dir, '111', `10_${'😀'.repeat(29)}.png`));
  });

  it('turns a failed download into a marker carrying the error', async () => {
    const t = setup();
    t.fake.fail('getFile', 400, 'Bad Request: file is too big');
    const telegramError = "Call to 'getFile' failed! (400: Bad Request: file is too big)";
    expect(await t.ingest(doc('a.txt'))).toBe(`[attachment download failed: filename=a.txt reason=${telegramError}]`);
    expect(t.log.text()).toContain(`WARNING attachment download failed chat=111 msg=10 filename=a.txt err=${telegramError}`);
    t.files.set('doc', new Error('HTTP 502'));
    expect(await t.ingest(doc('a.txt'))).toBe('[attachment download failed: filename=a.txt reason=HTTP 502]');
    t.files.set('doc', Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }));
    expect(await t.ingest(doc('a.txt'))).toBe('[attachment download failed: filename=a.txt reason=EACCES: permission denied]');
  });

  it('scrubs secrets out of text files on disk, rewriting only what changed', async () => {
    const t = setup();
    t.files.set('doc', `key: sk-${'a'.repeat(24)}\r\nnext\r\n`);
    const marker = await t.ingest(doc('notes.md'));
    expect(readFileSync(join(t.dir, '111', '10_notes.md'), 'utf8')).toBe('key: [REDACTED]\nnext\n');
    expect(marker).toContain('size=21B');
    t.files.set('doc', 'a\r\nb');
    await t.ingest(doc('clean.txt'));
    expect(readFileSync(join(t.dir, '111', '10_clean.txt'), 'utf8')).toBe('a\r\nb');
    t.files.set('doc', `sk-${'a'.repeat(24)}`);
    await t.ingest(doc('pic.png'));
    expect(readFileSync(join(t.dir, '111', '10_pic.png'), 'utf8')).toBe(`sk-${'a'.repeat(24)}`);
  });

  it('still announces a file whose scrub failed, with the size Telegram reported', async () => {
    const t = setup();
    t.files.set('doc', NOTHING);
    expect(await t.ingest(doc('gone.txt', undefined, 42))).toBe(`[attachment: ${join(t.dir, '111', '10_gone.txt')} type=text/plain size=42B filename=gone.txt]`);
    expect(t.log.text()).toContain(`WARNING attachment scrub failed path=${join(t.dir, '111', '10_gone.txt')} err=ENOENT`);
  });

  it('writes paths that telegram_read_attachment reads back', async () => {
    const t = setup();
    t.files.set('doc', 'the report');
    const marker = await t.ingest(doc('report.txt'));
    const path = /\[attachment: (\S+) /.exec(marker)?.[1] ?? '';
    const tool = readAttachmentTool(new AttachmentStore(t.dir));
    expect(await tool.run({ path })).toEqual({ content: 'the report', data: { path: '111/10_report.txt', size_bytes: 10, truncated: false } });
  });
});

describe('downloadFile', () => {
  it('saves the body, and reports an HTTP failure', async () => {
    const server = createServer((req, res) => (req.url === '/file/bot1:t/files/ok' ? res.end('payload') : res.writeHead(404).end()));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/file/bot1:t/files`;
    const dest = join(tempDir(), 'out');
    try {
      await downloadFile(`${base}/ok`, dest);
      expect(readFileSync(dest, 'utf8')).toBe('payload');
      await expect(downloadFile(`${base}/missing`, dest)).rejects.toMatchObject({ message: 'download failed: HTTP 404' });
    } finally {
      server.close();
    }
  });
});
