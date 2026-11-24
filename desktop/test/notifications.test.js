'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createApprovalNotifier } = require('../notifications');

test('approval notifications are private, deduplicated and route to the right pending instance', () => {
  const shown = [];
  const actions = [];
  class FakeNotification extends EventEmitter {
    constructor(options) { super(); this.options = options; }
    show() { shown.push(this); }
    close() { this.emit('close'); }
  }
  let focused = false;
  let supported = true;
  const window = {
    isDestroyed: () => false, isFocused: () => focused, isMinimized: () => true,
    restore: () => actions.push('restore'), show: () => actions.push('show'), focus: () => actions.push('focus'),
    webContents: { send: (...args) => actions.push(args) }
  };
  const pending = new Set(['a:1', 'b:1']);
  const notifier = createApprovalNotifier({ Notification: FakeNotification, getWindow: () => window,
    isPending: target => pending.has(`${target.instanceId}:${target.requestId}`), isSupported: () => supported });
  const a = { instanceId: 'a', requestId: 1, port: 3101, detail: 'secret command' };
  const b = { instanceId: 'b', requestId: 1, port: 3102 };
  focused = true;
  notifier.notify(a);
  focused = false;
  supported = false;
  notifier.notify(a);
  assert.equal(shown.length, 0);
  supported = true;
  notifier.notify(a);
  notifier.notify(a);
  notifier.notify(b);
  assert.equal(shown.length, 2);
  assert.match(shown[0].options.body, /3101/);
  assert.doesNotMatch(JSON.stringify(shown[0].options), /secret command/);
  shown[1].emit('click');
  assert.deepEqual(actions, ['restore', 'show', 'focus', ['bridge:focus-instance', 'b']]);
  pending.delete('a:1');
  notifier.update();
  shown[0].emit('click');
  assert.equal(actions.length, 4, 'A stale toast does not navigate or approve');
});
