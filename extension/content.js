(function () {
  'use strict';
  const config = globalThis.RegistryTasks;
  const hostId = 'team-registry-tasks-extension';
  if (!config.isSpreadsheetUrl(location.href) || document.getElementById(hostId)) return;

  const host = document.createElement('div');
  host.id = hostId;
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial !important; position: fixed !important;
      top: min(180px, 34vh) !important; left: 0 !important;
      z-index: 2147483646 !important; pointer-events: none !important;
      color-scheme: light; font-family: Arial, sans-serif !important; }
    *, *::before, *::after { box-sizing: border-box; }
    [hidden] { display: none !important; }
    button, a { font: inherit; -webkit-tap-highlight-color: transparent; }
    button:focus-visible, a:focus-visible { outline: 3px solid #4f8f6a; outline-offset: 3px; }
    .handle { pointer-events: auto; display: flex; align-items: center; gap: 8px;
      border: 1px solid #c9d6ce; border-left: 0; border-radius: 0 10px 10px 0;
      padding: 12px 7px; width: 32px; min-height: 102px; cursor: pointer;
      background: #f3f8f4; color: #245c3d; box-shadow: 0 2px 8px #203b2520;
      writing-mode: vertical-rl; font-size: 12px; font-weight: 700; }
    .handle:hover { background: #e5f0e8; }
    .panel { pointer-events: auto; width: 304px; max-width: calc(100vw - 32px);
      max-height: calc(100vh - min(180px, 34vh) - 16px); overflow: auto;
      background: #fff; color: #25392d; border: 1px solid #d4dfd7; border-left: 0;
      border-radius: 0 16px 16px 0; box-shadow: 3px 8px 30px #213c2930;
      font-size: 14px; line-height: 1.5; }
    .header { display: flex; justify-content: space-between; align-items: center;
      padding: 20px 18px 14px; border-bottom: 1px solid #edf1ed; }
    .eyebrow { margin: 0 0 2px; color: #728176; font-size: 11px; letter-spacing: .6px; }
    h2 { font-size: 21px; line-height: 1.3; margin: 0; font-weight: 600; }
    .close { background: #f4f6f4; border: 0; border-radius: 8px; color: #4b5d50;
      width: 32px; height: 32px; cursor: pointer; font-size: 22px; line-height: 1; }
    .close:hover { background: #e8eee9; }
    .body { padding: 18px; }
    .intro { color: #65746a; margin: 0 0 16px; font-size: 13px; }
    .task { display: flex; align-items: center; gap: 10px; text-align: left;
      width: 100%; border: 1px solid #e3e8e4; border-radius: 10px; padding: 13px 11px;
      background: #f8faf8; color: #69756c; margin-bottom: 10px; opacity: 1; cursor: default; }
    .task-icon { display: inline-grid; place-items: center; flex: 0 0 28px;
      height: 28px; border-radius: 7px; background: #eaf0eb; font-size: 17px; }
    .task-name { flex: 1; font-size: 13px; line-height: 1.4; }
    .soon { color: #778479; background: #ebefeb; font-size: 10px; padding: 3px 5px; border-radius: 4px; }
    .note { color: #7a857d; font-size: 12px; margin: 14px 0 20px; }
    .registry { display: flex; align-items: center; justify-content: space-between;
      text-decoration: none; background: #eef5ef; color: #2d6845; border: 1px solid #dce8de;
      border-radius: 9px; padding: 12px; font-size: 13px; font-weight: 600; }
    .registry:hover { background: #e2eee5; }
    .footer { padding: 12px 18px; background: #f9fbf9; border-top: 1px solid #edf1ed;
      color: #8a958d; font-size: 11px; }
    @media (prefers-reduced-motion: no-preference) { .handle, .registry, .close { transition: background .15s; } }
  `;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  const toggle = element('button', 'handle', '☷  Задачи');
  toggle.type = 'button';
  toggle.setAttribute('aria-label', 'Открыть меню задач');
  toggle.setAttribute('aria-controls', 'registry-tasks-panel');
  toggle.title = 'Открыть меню задач';
  const panel = element('section', 'panel');
  panel.id = 'registry-tasks-panel';
  panel.setAttribute('aria-labelledby', 'registry-tasks-title');
  const header = element('div', 'header');
  const heading = element('div');
  heading.append(element('p', 'eyebrow', 'РЕЕСТР БАЗ'));
  const title = element('h2', '', 'Задачи');
  title.id = 'registry-tasks-title';
  heading.append(title);
  const close = element('button', 'close', '‹');
  close.type = 'button';
  close.setAttribute('aria-label', 'Свернуть меню задач');
  close.title = 'Свернуть меню задач';
  header.append(heading, close);
  const body = element('div', 'body');
  body.append(element('p', 'intro', 'Инструменты для работы с контактами'));
  [ ['@', 'Провалидировать email'], ['⇄', 'Распределить контакты'] ].forEach(function (task) {
    const button = element('button', 'task');
    button.type = 'button';
    button.disabled = true;
    button.setAttribute('aria-disabled', 'true');
    button.setAttribute('aria-describedby', 'registry-tasks-placeholder');
    const icon = element('span', 'task-icon', task[0]);
    icon.setAttribute('aria-hidden', 'true');
    button.append(icon, element('span', 'task-name', task[1]), element('span', 'soon', 'Скоро'));
    body.append(button);
  });
  const note = element('p', 'note', 'Кнопки пока недоступны. Здесь появятся новые задачи.');
  note.id = 'registry-tasks-placeholder';
  const registry = element('a', 'registry', 'Открыть реестр баз ↗');
  registry.href = config.registryUrl;
  registry.target = '_blank';
  registry.rel = 'noopener noreferrer';
  body.append(note, registry);
  panel.append(header, body, element('div', 'footer', 'Меню команды · 0.1.0'));
  root.append(style, toggle, panel);

  let expanded = false;
  let changedByUser = false;
  function setExpanded(value, focus) {
    expanded = value;
    panel.hidden = !value;
    toggle.hidden = value;
    toggle.setAttribute('aria-expanded', String(value));
    host.setAttribute('data-expanded', String(value));
    if (focus) (value ? close : toggle).focus();
  }
  function changeExpanded(value) {
    changedByUser = true;
    setExpanded(value, true);
    try {
      chrome.storage.local.set({ registryTasksExpanded: value }).catch(function () {});
    } catch (_) {
      // The menu remains usable if storage is unavailable (for example after an update).
    }
  }
  setExpanded(false, false);
  toggle.addEventListener('click', function () { changeExpanded(true); });
  close.addEventListener('click', function () { changeExpanded(false); });
  root.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && expanded) {
      event.preventDefault();
      changeExpanded(false);
    }
  });
  document.documentElement.append(host);

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (message && message.type === config.messageType && config.isSpreadsheetUrl(location.href)) {
      changeExpanded(!expanded);
      sendResponse({ handled: true });
    }
  });
  try {
    chrome.storage.local.get('registryTasksExpanded').then(function (state) {
      if (!changedByUser && typeof state.registryTasksExpanded === 'boolean') {
        setExpanded(state.registryTasksExpanded, false);
      }
    }).catch(function () {});
  } catch (_) {
    // Default state is collapsed when local settings cannot be read.
  }
})();
