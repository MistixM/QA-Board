import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const editorSource = readFileSync(new URL('../../mdev-src/editor.js', import.meta.url), 'utf8');
const annotationSource = editorSource.slice(editorSource.indexOf('const canvas ='), editorSource.indexOf('function loadImage('));

function editor() {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      dataset: {}, style: {}, attributes: {}, listeners: {}, hidden: false, value: '',
      addEventListener(name, handler) { this.listeners[name] = handler; },
      setAttribute(name, value) { this.attributes[name] = value; },
      focus() {}, setCustomValidity(value) { this.validationMessage = value; },
      reportValidity() {}, showModal() { this.open = true; },
      contains(target) { return target === this; }
    });
    return elements.get(id);
  }
  const operations = [];
  const contextStack = [];
  const ctx = {
    save() { contextStack.push({ strokeStyle: this.strokeStyle, fillStyle: this.fillStyle, lineWidth: this.lineWidth, globalAlpha: this.globalAlpha, dash: this.dash }); },
    restore() { Object.assign(this, contextStack.pop()); },
    setLineDash(dash) { this.dash = dash; },
    fillRect(...args) { operations.push({ kind: 'fillRect', args, color: this.fillStyle }); },
    strokeRect(...args) { operations.push({ kind: 'strokeRect', args, color: this.strokeStyle }); },
    drawImage() {},
    beginPath() { this.path = []; },
    moveTo(...args) { this.path.push(args); },
    lineTo(...args) { this.path.push(args); },
    stroke() { operations.push({ kind: 'stroke', path: this.path, color: this.strokeStyle, width: this.lineWidth, dash: this.dash }); },
    fillText(...args) { operations.push({ kind: 'text', args, color: this.fillStyle, font: this.font }); },
    measureText(text) { return { width: text.length * 20 }; }
  };
  const tools = ['box', 'line', 'arrow', 'text'].map(type => {
    const button = element(`tool-${type}`);
    button.dataset.tool = type;
    return button;
  });
  const swatches = ['#FF3333', '#3B82F6'].map(color => {
    const button = element(color);
    button.dataset.color = color;
    return button;
  });
  element('annotation-palette').querySelectorAll = () => swatches;
  const canvas = element('main-canvas');
  const captured = new Set();
  Object.assign(canvas, {
    width: 1000, height: 600,
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 500, height: 300 }),
    setPointerCapture: id => captured.add(id),
    hasPointerCapture: id => captured.has(id),
    releasePointerCapture: id => captured.delete(id)
  });
  const documentListeners = {};
  const context = vm.createContext({
    document: {
      getElementById: element,
      querySelectorAll: () => tools,
      addEventListener: (name, handler) => { documentListeners[name] = handler; }
    },
    Image: class { src = 'screenshot.png'; complete = true; naturalWidth = 1000; }
  });
  vm.runInContext(annotationSource, context);
  const pointer = (name, x, y, pointerId = 1) => canvas.listeners[name]({ clientX: x, clientY: y, pointerId, button: 0, preventDefault() {} });
  return {
    element, operations, pointer, captured, documentListeners,
    tool: type => element(`tool-${type}`).listeners.click(),
    color: color => element(color).listeners.click(),
    undo: (options = {}) => {
      let prevented = false;
      documentListeners.keydown({
        key: 'z', ctrlKey: true, target: canvas,
        ...options, preventDefault() { prevented = true; }
      });
      return prevented;
    },
    annotations: () => JSON.parse(vm.runInContext('JSON.stringify(annotations)', context)),
    redraw: includeDraft => vm.runInContext(`redrawCanvas(${includeDraft})`, context)
  };
}

test('boxes support reverse drags and use screenshot coordinates', () => {
  const ui = editor();
  ui.tool('box');
  ui.pointer('pointerdown', 110, 120);
  ui.pointer('pointerup', 30, 40);
  const [box] = ui.annotations();
  assert.deepEqual({ x: box.x, y: box.y, w: box.w, h: box.h }, { x: 40, y: 40, w: 160, h: 160 });
  assert.equal(box.color, '#FF3333');
  assert.equal(box.lineWidth, 6);
  assert.equal(ui.captured.size, 0);
});

test('horizontal and vertical lines and arrows preserve start and end direction', () => {
  for (const type of ['line', 'arrow']) {
    for (const end of [[110, 40], [30, 120], [15, 25]]) {
      const ui = editor();
      ui.tool(type);
      ui.pointer('pointerdown', 30, 40);
      ui.pointer('pointerup', ...end);
      const [mark] = ui.annotations();
      assert.equal(mark.type, type);
      assert.equal(mark.x, 40);
      assert.equal(mark.y, 40);
      assert.equal(mark.endX, (end[0] - 10) * 2);
      assert.equal(mark.endY, (end[1] - 20) * 2);
      const strokes = ui.operations.filter(operation => operation.kind === 'stroke');
      assert.equal(strokes.length, type === 'arrow' ? 2 : 1);
      if (type === 'arrow') assert.deepEqual(strokes[1].path[1], [mark.endX, mark.endY]);
    }
  }
});

test('palette and custom colors affect new marks while previous marks retain their colors', () => {
  const ui = editor();
  ui.tool('line');
  ui.pointer('pointerdown', 30, 40);
  ui.pointer('pointerup', 110, 120);
  ui.color('#3B82F6');
  ui.pointer('pointerdown', 30, 50);
  ui.pointer('pointerup', 110, 130);
  const custom = ui.element('annotation-custom-color');
  custom.value = '#12ab34';
  custom.listeners.input();
  ui.pointer('pointerdown', 30, 60);
  ui.pointer('pointerup', 110, 140);
  assert.deepEqual(ui.annotations().map(mark => mark.color), ['#FF3333', '#3B82F6', '#12AB34']);
  assert.equal(ui.element('annotation-color-preview').style.backgroundColor, '#12AB34');
  assert.equal(ui.element('#3B82F6').attributes['aria-pressed'], 'false');
});

test('cancelled drags and accidental clicks leave the screenshot unmarked', () => {
  const ui = editor();
  ui.tool('arrow');
  ui.pointer('pointerdown', 30, 40);
  ui.pointer('pointermove', 110, 120);
  ui.pointer('pointercancel', 110, 120);
  ui.pointer('pointerup', 110, 120);
  ui.pointer('pointerdown', 30, 40);
  ui.pointer('pointerup', 30, 40);
  assert.deepEqual(ui.annotations(), []);
  assert.equal(ui.captured.size, 0);
});

test('pointer capture clamps drawings released beyond the screenshot edge', () => {
  const ui = editor();
  ui.tool('line');
  ui.pointer('pointerdown', 30, 40);
  ui.pointer('pointerup', 900, -100);
  assert.equal(ui.annotations()[0].endX, 1000);
  assert.equal(ui.annotations()[0].endY, 0);
});

test('text supports multiple lines and the selected color, with readable size on scaled screenshots', () => {
  const ui = editor();
  ui.tool('text');
  ui.color('#3B82F6');
  ui.pointer('pointerdown', 30, 40);
  assert.equal(ui.element('annotation-text-dialog').open, true);
  ui.element('annotation-text-input').value = 'First line\nSecond line';
  ui.element('annotation-text-form').listeners.submit({ submitter: { value: 'add' } });
  const [text] = ui.annotations();
  assert.equal(text.text, 'First line\nSecond line');
  assert.equal(text.fontSize, 40);
  assert.equal(text.color, '#3B82F6');
  const drawn = ui.operations.filter(operation => operation.kind === 'text');
  assert.equal(drawn.length, 2);
  assert.equal(drawn[1].args[2] - drawn[0].args[2], 50);
});

test('cancelled or blank text does not create annotations', () => {
  const ui = editor();
  ui.tool('text');
  ui.pointer('pointerdown', 30, 40);
  const form = ui.element('annotation-text-form');
  form.listeners.submit({ submitter: { value: 'cancel' } });
  assert.deepEqual(ui.annotations(), []);
  ui.element('annotation-text-input').value = '   ';
  let prevented = false;
  form.listeners.submit({ submitter: { value: 'add' }, preventDefault() { prevented = true; } });
  assert.ok(prevented);
  assert.deepEqual(ui.annotations(), []);
});

test('export redraw includes committed annotations and excludes the draft; Clear removes all types', () => {
  const ui = editor();
  ui.tool('line');
  ui.pointer('pointerdown', 30, 40);
  ui.pointer('pointerup', 110, 120);
  ui.tool('box');
  ui.pointer('pointerdown', 40, 50);
  ui.pointer('pointermove', 120, 130);
  ui.operations.length = 0;
  ui.redraw(false);
  assert.equal(ui.operations.filter(operation => operation.kind === 'stroke').length, 1);
  assert.equal(ui.operations.filter(operation => operation.kind === 'strokeRect').length, 0);
  ui.element('clear-ann-btn').listeners.click();
  assert.deepEqual(ui.annotations(), []);
  assert.equal(ui.element('clear-ann-btn').hidden, true);
  assert.equal(ui.captured.size, 0);
});

test('Ctrl+Z and Cmd+Z undo annotations one at a time across every tool', () => {
  const ui = editor();
  for (const type of ['box', 'line', 'arrow']) {
    ui.tool(type);
    ui.pointer('pointerdown', 30, 40);
    ui.pointer('pointerup', 110, 120);
  }
  ui.tool('text');
  ui.pointer('pointerdown', 30, 40);
  ui.element('annotation-text-input').value = 'Label';
  ui.element('annotation-text-form').listeners.submit({ submitter: { value: 'add' } });
  ui.element('annotation-text-dialog').open = false;
  ui.element('annotation-text-dialog').listeners.close();
  assert.deepEqual(ui.annotations().map(mark => mark.type), ['box', 'line', 'arrow', 'text']);
  assert.ok(ui.undo({ ctrlKey: false, metaKey: true, key: 'Z' }));
  assert.deepEqual(ui.annotations().map(mark => mark.type), ['box', 'line', 'arrow']);
  assert.equal(ui.element('clear-ann-btn').hidden, false);
  assert.ok(ui.undo());
  assert.ok(ui.undo());
  assert.ok(ui.undo());
  assert.deepEqual(ui.annotations(), []);
  assert.equal(ui.element('clear-ann-btn').hidden, true);
  assert.equal(ui.undo(), false);
});

test('undo restores annotations removed by Clear', () => {
  const ui = editor();
  ui.tool('line');
  ui.pointer('pointerdown', 30, 40);
  ui.pointer('pointerup', 110, 120);
  const original = ui.annotations();
  ui.element('clear-ann-btn').listeners.click();
  assert.deepEqual(ui.annotations(), []);
  assert.ok(ui.undo());
  assert.deepEqual(ui.annotations(), original);
  assert.equal(ui.element('clear-ann-btn').hidden, false);
  assert.ok(ui.undo());
  assert.deepEqual(ui.annotations(), []);
});

test('text fields, editable content, dialogs, and other shortcuts keep their native behavior', () => {
  const ui = editor();
  ui.tool('box');
  ui.pointer('pointerdown', 30, 40);
  ui.pointer('pointerup', 110, 120);
  for (const options of [
    { target: { closest: () => ({ tagName: 'TEXTAREA' }) } },
    { target: { isContentEditable: true } },
    { shiftKey: true }, { altKey: true }, { ctrlKey: false },
    { defaultPrevented: true }, { isComposing: true }
  ]) {
    assert.equal(ui.undo(options), false);
    assert.equal(ui.annotations().length, 1);
  }
  ui.element('annotation-text-dialog').open = true;
  assert.equal(ui.undo(), false);
  assert.equal(ui.annotations().length, 1);
});

test('undo cancels an unfinished drag before removing a completed annotation', () => {
  const ui = editor();
  ui.tool('arrow');
  ui.pointer('pointerdown', 30, 40);
  ui.pointer('pointerup', 110, 120);
  ui.pointer('pointerdown', 40, 50);
  ui.pointer('pointermove', 120, 130);
  assert.ok(ui.undo());
  assert.equal(ui.captured.size, 0);
  assert.equal(ui.annotations().length, 1);
  ui.pointer('pointerup', 120, 130);
  assert.ok(ui.undo());
  assert.deepEqual(ui.annotations(), []);
});
