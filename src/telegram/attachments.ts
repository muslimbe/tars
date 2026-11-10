import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Api } from 'grammy';
import type { Message } from 'grammy/types';

import type { Logger } from '../log/logger.ts';
import { IMAGE_EXTS, TEXT_EXTS } from '../stores/attachments.ts';
import { scrub } from '../text/scrub.ts';
import type { AttachmentIngest } from './dispatcher.ts';

export interface IngestOptions {
  api: Pick<Api, 'getFile' | 'token'>;
  /** Saves a Telegram file URL to `dest`; `downloadFile` in production. */
  download(url: string, dest: string): Promise<void>;
  /** The attachments root; each chat gets a sub-directory. */
  dir: string;
  /** Larger files are refused before downloading (`TARS_ATTACHMENT_MAX_BYTES`). */
  maxBytes: number;
  log: Logger;
}

/** One file a message carries. */
interface Descriptor {
  fileId: string;
  filename: string;
  mime: string | undefined;
  size: number | undefined;
}

/** A Telegram file object; voice notes, video notes and photos lack some of these fields. */
interface TgFile {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

type Kind = 'image' | 'pdf' | 'text' | 'media';

/** Audio and video: saved for an external tool (e.g. a transcription MCP); tars itself can't read them. */
const MEDIA_EXTS = new Set(['ogg', 'oga', 'opus', 'mp3', 'm4a', 'aac', 'wav', 'flac', 'mp4', 'mov', 'webm', 'mkv']);

/** What a marker says when Telegram gave no MIME type. */
const DEFAULT_MIME: Record<Kind, string> = { image: 'image/jpeg', pdf: 'application/pdf', text: 'text/plain', media: 'application/octet-stream' };

/**
 * The dispatcher's attachment step: download each file of an
 * allowed message under `<dir>/<chat_id>/` and append one marker line per
 * file to its text — `[attachment: <path> …]`, or why it was refused or
 * failed — so the model can read it with `telegram_read_attachment`.
 */
export function attachmentIngest(o: IngestOptions): AttachmentIngest {
  return async (msg, cm) => {
    const files = descriptorsOf(msg);
    if (!files.length) return;
    mkdirSync(join(o.dir, String(msg.chat.id)), { recursive: true });
    const markers: string[] = [];
    for (const file of files) markers.push(await ingestOne(o, msg, file));
    const block = markers.join('\n');
    cm.text = cm.text ? `${cm.text}\n${block}` : block;
  };
}

/** The largest photo size, the document, and any voice note, audio, video or video note. */
function descriptorsOf(msg: Message): Descriptor[] {
  const id = msg.message_id;
  const photo = msg.photo?.at(-1);
  const files = [
    photo && fileOf(photo, `photo_${id}.jpg`, 'image/jpeg'),
    msg.document && fileOf(msg.document, `document_${id}`),
    msg.voice && fileOf(msg.voice, `voice_${id}.ogg`, 'audio/ogg'),
    msg.audio && fileOf(msg.audio, `audio_${id}`),
    msg.video && fileOf(msg.video, `video_${id}.mp4`, 'video/mp4'),
    msg.video_note && fileOf(msg.video_note, `video_note_${id}.mp4`, 'video/mp4'),
  ];
  return files.filter((d) => d !== undefined);
}

/** Telegram's name and MIME type when it gave them, else the fallbacks. */
const fileOf = (f: TgFile, name: string, mime?: string): Descriptor => ({ fileId: f.file_id, filename: f.file_name || name, mime: f.mime_type ?? mime, size: f.file_size });

async function ingestOne(o: IngestOptions, msg: Message, d: Descriptor): Promise<string> {
  const at = `chat=${msg.chat.id} msg=${msg.message_id} filename=${d.filename}`;
  const kind = classify(extOf(d.filename), d.mime);
  if (!kind) {
    o.log.info(`attachment rejected ${at} mime=${d.mime ?? 'unknown'} reason=unsupported_type`);
    return `[attachment rejected: filename=${d.filename} reason=unsupported_type]`;
  }
  if (d.size !== undefined && d.size > o.maxBytes) {
    o.log.info(`attachment rejected ${at} size=${d.size} reason=too_large`);
    return `[attachment rejected: filename=${d.filename} reason=too_large size=${humanSize(d.size)}]`;
  }
  const dest = join(o.dir, String(msg.chat.id), `${msg.message_id}_${safeFilename(d.filename, `file_${msg.message_id}`)}`);
  const failure = await download(o, d.fileId, dest);
  if (failure) {
    o.log.warn(`attachment download failed ${at} err=${failure}`);
    return `[attachment download failed: filename=${d.filename} reason=${failure}]`;
  }
  if (kind === 'text') scrubFile(dest, o.log);
  return savedMarker(o.log, msg, d, { dest, kind });
}

/** Fetch the file to `dest`; on failure, the error message the marker reports. */
async function download(o: IngestOptions, fileId: string, dest: string): Promise<string | undefined> {
  try {
    const file = await o.api.getFile(fileId);
    await o.download(`https://api.telegram.org/file/bot${o.api.token}/${file.file_path ?? ''}`, dest);
    return undefined;
  } catch (err) {
    return (err as Error).message;
  }
}

/** The `[attachment: …]` marker; the size is the file's on disk, after any scrub. */
function savedMarker(log: Logger, msg: Message, d: Descriptor, saved: { dest: string; kind: Kind }): string {
  const size = statSync(saved.dest, { throwIfNoEntry: false })?.size ?? d.size ?? 0;
  log.info(`attachment saved chat=${msg.chat.id} msg=${msg.message_id} path=${saved.dest} size=${size} kind=${saved.kind}`);
  return `[attachment: ${saved.dest} type=${d.mime || DEFAULT_MIME[saved.kind]} size=${humanSize(size)} filename=${d.filename}]`;
}

/** By extension, or by MIME for images, audio/video and PDFs; text is never inferred from the MIME type. */
function classify(ext: string, mime: string | undefined): Kind | undefined {
  if (IMAGE_EXTS.has(ext) || mime?.startsWith('image/')) return 'image';
  if (isMedia(ext, mime)) return 'media';
  if (ext === 'pdf' || mime === 'application/pdf') return 'pdf';
  return TEXT_EXTS.has(ext) ? 'text' : undefined;
}

const isMedia = (ext: string, mime: string | undefined) => MEDIA_EXTS.has(ext) || /^(audio|video)\//.test(mime ?? '');

/** Lower-cased text after the last dot (`.env` → `env`); empty without one. */
function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/**
 * No path separators or NULs, no leading/trailing dots or spaces, at most 120 UTF-8 bytes with the extension kept.
 * Bytes, not characters: Linux caps a file name at 255 bytes, which 120 emoji or CJK characters exceed.
 */
function safeFilename(name: string, fallback: string): string {
  const cleaned = name.replace(/[/\\]/g, '_').replaceAll('\0', '').replace(/^[. ]+|[. ]+$/g, '');
  if (!cleaned) return fallback;
  if (Buffer.byteLength(cleaned) <= 120) return cleaned;
  const ext = extOf(cleaned);
  const suffix = ext ? `.${ext}` : '';
  let head = '';
  let bytes = Buffer.byteLength(suffix);
  for (const ch of cleaned) {
    bytes += Buffer.byteLength(ch);
    if (bytes > 120) break;
    head += ch;
  }
  return head + suffix;
}

/** `512B`, `1.2KB`, `45.0MB`: binary units, one decimal. */
function humanSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)}MB`;
  return `${(n / 1024 ** 3).toFixed(1)}GB`;
}

/** Secrets in a text file must not reach the disk the model reads from; rewritten only when something was redacted. */
function scrubFile(path: string, log: Logger): void {
  try {
    // Invalid bytes become U+FFFD; every newline becomes \n.
    const text = readFileSync(path).toString('utf8').replace(/\r\n?/g, '\n');
    const cleaned = scrub(text);
    if (cleaned !== text) writeFileSync(path, cleaned);
  } catch (err) {
    log.warn(`attachment scrub failed path=${path} err=${(err as Error).message}`);
  }
}

/**
 * Save a Telegram file URL to `dest`. undici's own 300 s header and body
 * timeouts cut a stalled transfer, so the update queue can't hang on one.
 */
export async function downloadFile(url: string, dest: string): Promise<void> {
  let body: Buffer;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    throw new Error(`download failed: ${(err as Error).message}`, { cause: err });
  }
  await writeFile(dest, body);
}
