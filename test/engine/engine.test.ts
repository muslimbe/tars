import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { TurnResult } from '../../src/claude/turn.ts';
import { openDatabase } from '../../src/db/database.ts';
import { insertMessage } from '../../src/db/messages.ts';
import { Engine, type EngineWorker } from '../../src/engine/engine.ts';
import { HEARTBEAT_NUDGE, SILENT_STOP_NUDGE } from '../../src/engine/outcome.ts';
import { TypingIndicator } from '../../src/engine/typing.ts';
import type { ChatMessage } from '../../src/message.ts';
import { memoryLogger } from '../helpers/log.ts';
import { tempDir } from '../helpers/tmp.ts';
import { until } from '../helpers/wait.ts';

class FakeWorker implements EngineWorker {
  readonly sent: string[] = [];
  readonly injected: string[] = [];
  resets = 0;
  injectAccepts = true;
  send(text: string) {
    this.sent.push(text);
    return Promise.resolve();
  }
  inject(text: string) {
    this.injected.push(text);
    return Promise.resolve(this.injectAccepts);
  }
  resetSession() {
    this.resets++;
    return Promise.resolve();
  }
}

const engines: Engine[] = [];
afterEach(() => engines.splice(0).forEach((e) => e.stop()));

function setup(debounceMs = 0) {
  const worker = new FakeWorker();
  const log = memoryLogger();
  const db = openDatabase(join(tempDir(), 'h.db'), log);
  const notices: { chatId: number; text: string; replyTo?: number | undefined }[] = [];
  const typed: number[] = [];
  const typing = new TypingIndicator((chatId) => Promise.resolve(void typed.push(chatId)), log);
  const engine = new Engine({ worker, db, debounceMs, typing, log, notify: (chatId, text, replyTo) => Promise.resolve(void notices.push({ chatId, text, replyTo })) });
  engines.push(engine);
  return { engine, worker, db, log, notices, typed, sends: (n: number) => until(() => worker.sent.length >= n && worker.sent) };
}

let nextId = 1;
function msg(text: string, chatId = 111, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { chatId, messageId: nextId++, userId: chatId, firstName: 'Ali', direction: 'in', timestamp: new Date('2026-01-01T10:00:00Z'), text, ...extra };
}
const reminder = (text: string): ChatMessage => msg(`<reminder id="1" chat_id="111" user_id="-1">${text}</reminder>`, 111, { messageId: 0, userId: -1 });

function result(overrides: Partial<TurnResult> = {}): TurnResult {
  return { textBlocks: [], stderrTail: [], userVisibleAction: true, droppedText: false, control: { action: 'stop', reason: 'replied' }, ...overrides };
}

/** Submit, persist (so commits are visible), and wait for the turn-opening send. */
async function startTurn(t: ReturnType<typeof setup>, ...messages: ChatMessage[]) {
  const before = t.worker.sent.length;
  for (const m of messages) {
    if (m.messageId > 0) insertMessage(t.db, m);
    await t.engine.submit(m);
  }
  await t.sends(before + 1);
}

const processed = (t: ReturnType<typeof setup>) => t.db.prepare('SELECT message_id, consumed, processed FROM messages ORDER BY rowid').all();

describe('engine: batching and turns', () => {
  it('debounces a burst into one turn rendered as one envelope', async () => {
    const t = setup(50);
    await startTurn(t, msg('one'), msg('two'));
    expect(t.worker.sent).toHaveLength(1);
    expect(t.worker.sent[0]).toMatch(/<msg id="\d+" chat="111"[^>]*>\none\n<\/msg>\n<msg id="\d+" chat="111"[^>]*>\ntwo\n<\/msg>/);
    expect(t.log.text()).toContain('starting turn with 2 msgs');
  });

  it('injects messages that arrive mid-turn, from any chat', async () => {
    const t = setup();
    await startTurn(t, msg('first'));
    await t.engine.submit(msg('follow-up', 222));
    expect(t.worker.injected).toHaveLength(1);
    expect(t.worker.injected[0]).toContain('chat="222"');
    expect(t.worker.sent).toHaveLength(1);
  });

  it('marks messages consumed on send and processed only on a clean finish', async () => {
    const t = setup();
    let fired = 0;
    const m = msg('hello');
    insertMessage(t.db, m);
    await t.engine.submit(m, { onSuccess: () => Promise.resolve(void fired++) });
    await t.sends(1);
    expect(processed(t)).toEqual([{ message_id: m.messageId, consumed: 1, processed: 0 }]);
    t.engine.onResult(result());
    await until(() => fired === 1);
    expect(processed(t)).toEqual([{ message_id: m.messageId, consumed: 1, processed: 1 }]);
  });

  it('keeps a batch the worker could not inject and runs it as the next turn', async () => {
    const t = setup();
    await startTurn(t, msg('first'));
    t.worker.injectAccepts = false;
    await t.engine.submit(msg('late'));
    t.engine.onResult(result());
    const sent = await t.sends(2);
    expect(sent[1]).toContain('\nlate\n');
  });

  it('batches back-to-back submits even without a debounce (the boot replay)', async () => {
    const t = setup(0);
    await startTurn(t, msg('a'), msg('b'));
    expect(t.worker.sent).toHaveLength(1);
    expect(t.log.text()).toContain('starting turn with 2 msgs');
  });

  it('keeps routing on the chats the turn started with', async () => {
    const t = setup();
    await startTurn(t, msg('first'));
    await t.engine.submit(msg('follow-up', 222));
    expect([...t.engine.replyTargets.keys()]).toEqual([111]);
  });

  it('stops: no new turns, no hooks, and buffered rows wait for the boot replay', async () => {
    let hooks = 0;
    const count = { onSuccess: () => Promise.resolve(void hooks++), onFailure: () => Promise.resolve(void hooks++) };
    const t = setup();
    const inFlight = msg('in flight');
    insertMessage(t.db, inFlight);
    await t.engine.submit(inFlight, count);
    await t.sends(1);
    t.engine.stop();
    t.engine.onResult(result());
    const idle = setup(100);
    const buffered = msg('buffered');
    insertMessage(idle.db, buffered);
    await idle.engine.submit(buffered, count);
    idle.engine.stop();
    await new Promise((r) => setTimeout(r, 200));
    expect(hooks).toBe(0);
    expect(processed(t)).toEqual([{ message_id: inFlight.messageId, consumed: 1, processed: 0 }]);
    expect(idle.worker.sent).toEqual([]);
    expect(processed(idle)).toEqual([{ message_id: buffered.messageId, consumed: 0, processed: 0 }]);
  });

  it('shows typing for human chats only, not for reminder-only turns', async () => {
    const t = setup();
    await startTurn(t, reminder('wake up'));
    expect(t.worker.sent[0]).toBe('<reminder id="1" chat_id="111" user_id="-1">wake up</reminder>');
    expect(t.typed).toEqual([]);
  });

  it('shows no typing for a group message that is not for the bot', async () => {
    const quiet = setup();
    await startTurn(quiet, msg('chatter', -100, { quiet: true }));
    expect(quiet.typed).toEqual([]);
    const addressed = setup();
    await startTurn(addressed, msg('@bot a question', -100));
    expect(addressed.typed).toEqual([-100]);
  });
});

describe('engine: turn endings', () => {
  it('discards text left behind by a skip', async () => {
    const t = setup();
    await startTurn(t, msg('chatter', -100));
    t.engine.onResult(result({ control: { action: 'skip', reason: 'not for me' }, textBlocks: ['thinking aloud'], droppedText: true, userVisibleAction: false }));
    await until(() => t.log.text().includes('discarded as internal narration'));
    expect(t.notices).toEqual([]);
    expect(t.log.text()).toContain('skip turn produced undelivered text — discarded as internal narration: ["thinking aloud"]');
  });

  it('delivers text the model never sent, threaded to the message it answers', async () => {
    const t = setup();
    const m = msg('question');
    await startTurn(t, m);
    t.engine.onResult(result({ textBlocks: ['the answer', 'more'], droppedText: true, userVisibleAction: false }));
    await until(() => t.notices.length === 1);
    expect(t.notices).toEqual([{ chatId: 111, text: 'the answer\n\nmore', replyTo: m.messageId }]);
    expect(t.log.text()).toContain('delivered dropped text to chat 111 (1 chunk(s))');
  });

  it('alerts the owner instead when the dropped text is a known failure', async () => {
    const t = setup();
    await startTurn(t, msg('question'));
    t.engine.onResult(result({ textBlocks: ['There is an issue with the selected model'], droppedText: true, userVisibleAction: false }));
    await until(() => t.log.text().includes('The configured Claude model is unavailable'));
    expect(t.notices).toEqual([]);
  });

  it('ends the turn when the control action is missing: never nudged, dropped text still delivered', async () => {
    const t = setup();
    let fired = 0;
    await t.engine.submit(msg('x'), { onSuccess: () => Promise.resolve(void fired++) });
    await t.sends(1);
    t.engine.onResult(result({ control: undefined, userVisibleAction: false }));
    await until(() => fired === 1);
    expect(t.worker.sent).toHaveLength(1);
    expect(t.log.text()).toContain('turn done (action=none, dropped_text=false, text_blocks=0)');
    await startTurn(t, msg('y'));
    t.engine.onResult(result({ control: undefined, textBlocks: ['said'], droppedText: true, userVisibleAction: false }));
    await until(() => t.notices.length === 1);
    expect(t.notices[0]?.text).toBe('said');
  });

  it('delivers dropped text on a heartbeat and ends the turn there', async () => {
    const t = setup();
    await startTurn(t, msg('task'));
    t.engine.onResult(result({ control: { action: 'heartbeat' }, textBlocks: ['progress'], droppedText: true, userVisibleAction: false }));
    await until(() => t.notices.length === 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(t.worker.sent).toHaveLength(1);
  });

  it('handles an abort before an API error or dropped text in the same result', async () => {
    const t = setup();
    await startTurn(t, msg('x'));
    t.engine.onResult(result({ abortedReason: 'liveness-wedge', apiError: 'Usage policy violation', textBlocks: ['t'], droppedText: true }));
    await until(() => t.log.text().includes('(liveness-wedge)'));
    expect(t.worker.resets).toBe(0);
  });

  it('starts no new turn while the last result is still being handled, so each result applies to its own turn', async () => {
    const worker = new FakeWorker();
    const log = memoryLogger();
    const db = openDatabase(join(tempDir(), 'h.db'), log);
    const delivered: { chatId: number; text: string }[] = [];
    let release = () => {};
    const notify = (chatId: number, text: string) =>
      new Promise<void>((resolve) => {
        delivered.push({ chatId, text });
        release = resolve;
      });
    const engine = new Engine({ worker, db, debounceMs: 0, typing: new TypingIndicator(() => Promise.resolve(), log), log, notify });
    engines.push(engine);
    await engine.submit(msg('first', 111));
    await until(() => worker.sent.length === 1);
    engine.onResult(result({ textBlocks: ['answer one'], droppedText: true, userVisibleAction: false }));
    await until(() => delivered.length === 1);
    await engine.submit(msg('second', 222));
    await new Promise((r) => setTimeout(r, 20));
    expect(worker.sent).toHaveLength(1);
    release();
    await until(() => worker.sent.length === 2);
    expect(worker.sent[1]).toContain('chat="222"');
    engine.onResult(result({ textBlocks: ['answer two'], droppedText: true, userVisibleAction: false }));
    await until(() => delivered.length === 2);
    release();
    expect(delivered).toEqual([{ chatId: 111, text: 'answer one' }, { chatId: 222, text: 'answer two' }]);
  });

  it('continues after a heartbeat (folding new messages) and caps runaway heartbeats', async () => {
    const t = setup();
    await startTurn(t, msg('long task'));
    t.engine.onResult(result({ control: { action: 'heartbeat' } }));
    expect((await t.sends(2))[1]).toBe(HEARTBEAT_NUDGE);
    for (let i = 0; i < 9; i++) {
      t.engine.onResult(result({ control: { action: 'heartbeat' } }));
      await t.sends(3 + i);
    }
    t.engine.onResult(result({ control: { action: 'heartbeat' } }));
    await until(() => t.log.text().includes('turn done (action=heartbeat'));
    await new Promise((r) => setTimeout(r, 20));
    expect(t.worker.sent).toHaveLength(11);
  });

  it('injects a message that arrives while a heartbeat continuation is still going out', async () => {
    const t = setup();
    await startTurn(t, msg('long task'));
    let release = () => {};
    t.worker.send = (text) => {
      t.worker.sent.push(text);
      t.worker.injectAccepts = false; // like the real worker: no turn to join until the send is written
      return new Promise((resolve) => (release = () => resolve(void (t.worker.injectAccepts = true))));
    };
    t.engine.onResult(result({ control: { action: 'heartbeat' } }));
    await t.sends(2);
    const late = t.engine.submit(msg('late'));
    await new Promise((r) => setTimeout(r, 10));
    release();
    await late;
    expect(t.engine.pendingCount).toBe(0);
  });

  it('drops a turn opening that the worker shutdown cut short, quietly', async () => {
    const t = setup();
    let fail = (_err: Error) => {};
    t.worker.send = () => new Promise((_resolve, reject) => (fail = reject));
    await t.engine.submit(msg('x'));
    await until(() => t.log.text().includes('hot-path stage=worker-send'));
    t.engine.stop();
    fail(new Error('claude worker stopped'));
    await new Promise((r) => setTimeout(r, 10));
    expect(t.log.records.filter((r) => r.level === 'ERROR')).toEqual([]);
  });

  it('shows no typing for a reminder injected into a running turn', async () => {
    const t = setup();
    await startTurn(t, reminder('first'));
    await t.engine.submit({ ...reminder('second'), chatId: 222 });
    expect(t.worker.injected).toHaveLength(1);
    expect(t.typed).toEqual([]);
  });

  it('re-engages a silent stop once, then accepts it', async () => {
    const t = setup();
    await startTurn(t, msg('hi'));
    const silent = result({ userVisibleAction: false });
    t.engine.onResult(silent);
    expect((await t.sends(2))[1]).toBe(SILENT_STOP_NUDGE);
    t.engine.onResult(silent);
    await until(() => t.log.text().includes('silent stop persisted after re-engagement — user got no reply'));
    expect(t.worker.sent).toHaveLength(2);
  });

  it('never nudges a reminder-only turn', async () => {
    const t = setup();
    await startTurn(t, reminder('digest'));
    t.engine.onResult(result({ userVisibleAction: false }));
    await until(() => t.log.text().includes('turn done (action=stop'));
    expect(t.worker.sent).toHaveLength(1);
  });

  it('reports a breaker abort, flushes partial text and keeps reminders advancing', async () => {
    const t = setup();
    let success = 0;
    await t.engine.submit(msg('x'), { onSuccess: () => Promise.resolve(void success++) });
    await t.sends(1);
    t.engine.onResult({ textBlocks: ['partial'], stderrTail: [], userVisibleAction: false, droppedText: false, abortedReason: 'tool-error-limit' });
    await until(() => success === 1);
    expect(t.log.text()).toContain('⚠️ Hit an internal error and had to restart mid-task (tool-error-limit). Please resend the last message.');
    expect(t.notices.map((n) => n.text)).toEqual(['partial']);
  });

  it.each(['session-reset', 'crash'] as const)('reverts reminder hooks when the turn is discarded (%s)', async (reason) => {
    const t = setup();
    let failed = 0;
    await t.engine.submit(reminder('r'), { onSuccess: () => Promise.resolve(), onFailure: () => Promise.resolve(void failed++) });
    await t.sends(1);
    t.engine.onResult({ textBlocks: [], stderrTail: [], userVisibleAction: false, droppedText: false, abortedReason: reason });
    await until(() => failed === 1);
    if (reason === 'crash') expect(t.log.text()).toContain('⚠️ Claude Code crashed mid-turn and is restarting');
  });

  it('alerts on a classified API error without resetting the session', async () => {
    const t = setup();
    await startTurn(t, msg('x'));
    t.engine.onResult(result({ apiError: 'Rate limit exceeded', control: undefined }));
    await until(() => t.log.text().includes("I've been rate-limited by the API"));
    expect(t.worker.resets).toBe(0);
  });

  it('keeps the session when Claude Code itself ended the turn with an error', async () => {
    const t = setup();
    await startTurn(t, msg('x'));
    t.engine.onResult(result({ cliError: 'error_during_execution: boom', control: undefined }));
    await until(() => t.log.text().includes('(error_during_execution: boom)'));
    expect(t.worker.resets).toBe(0);
    expect(t.notices).toEqual([]);
  });

  it('resets a poisoned session with a recap, but not when the recap opened the failed turn', async () => {
    const t = setup();
    const m = msg('bad request');
    await startTurn(t, m);
    t.engine.onResult(result({ apiError: 'Usage policy violation', control: undefined }));
    await until(() => t.worker.resets === 1);
    expect(t.notices[0]?.text).toBe(
      "⚠️ Claude rejected that request and the turn failed. I've started a fresh session and will carry a short recap of the recent conversation into it. Please rephrase and resend.\n\nDetails:\nUsage policy violation",
    );
    insertMessage(t.db, { ...msg('older'), direction: 'out' });
    t.engine.stashRestoreContext('owner-reset');
    await startTurn(t, msg('again'));
    expect(t.worker.sent.at(-1)).toMatch(/^<restored_context reason="owner-reset">/);
    t.engine.onResult(result({ apiError: 'Usage policy violation', control: undefined }));
    await until(() => t.worker.resets === 2);
    expect(t.notices.at(-1)?.text).toContain('I\'ve started a completely fresh session — the recent recap could not be carried over');
  });

  it('alerts the owner when the turn\'s stderr names a failure', async () => {
    const t = setup();
    await startTurn(t, msg('x'));
    t.engine.onResult(result({ stderrTail: ['Error: invalid api key'] }));
    await until(() => t.log.text().includes('Claude authentication failed'));
  });

  it('keeps handling results after one handler fails', async () => {
    const t = setup();
    await t.engine.submit(msg('x'), { onSuccess: () => Promise.reject(new Error('boom')) });
    await t.sends(1);
    t.engine.onResult(result());
    await until(() => t.log.text().includes('turn-success callback failed'));
    await startTurn(t, msg('next'));
    expect(t.worker.sent).toHaveLength(2);
  });

  it('reports pending count and turn age for /health', async () => {
    const t = setup();
    expect(t.engine.turnElapsedSeconds).toBeUndefined();
    await startTurn(t, msg('x'));
    expect(t.engine.turnElapsedSeconds).toBeGreaterThanOrEqual(0);
    expect(t.engine.pendingCount).toBe(0);
  });
});
