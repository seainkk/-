(() => {
  const state = window.gridBackend = { calls: [], active: 0, maxActive: 0, pending: [], holdMethods: [], failures: {}, failAfterSave: false, receipts: new Map(), canEdit: true };
  const sheet = (id, name, rows, columns) => ({ id, name, rowCount: rows, columnCount: columns, usedRows: 4, usedColumns: 4, cells: new Map() });
  state.sheets = [sheet(0, 'Исходная база', 240, 80), sheet(1, 'Email', 100, 26), sheet(2, 'Телефоны', 100, 26)];
  const key = (row, column) => row + ':' + column;
  const find = id => state.sheets.find(item => String(item.id) === String(id));
  const cell = (tab, row, column) => tab.cells.get(key(row, column)) || { input: '', display: '', revision: 0 };
  const display = input => input === '=1+1' ? '2' : input.startsWith("'") ? input.slice(1) : input;
  window.gridServerEdit = (sheetId, row, column, input) => { const tab = find(sheetId), old = cell(tab, row, column); tab.cells.set(key(row, column), { input: String(input), display: display(String(input)), revision: old.revision + 1 }); };
  for (const tab of state.sheets) {
    gridServerEdit(tab.id, 1, 1, 'Компания'); gridServerEdit(tab.id, 1, 2, 'Email'); gridServerEdit(tab.id, 1, 3, 'Телефон');
    gridServerEdit(tab.id, 2, 1, 'Альфа'); gridServerEdit(tab.id, 2, 2, 'hello@example.test');
    gridServerEdit(tab.id, 3, 1, '<img src=x onerror=alert(1)>'); gridServerEdit(tab.id, 3, 4, '=1+1');
  }
  function range(payload) {
    const tab = find(payload.sheetId), height = payload.rowCount || payload.values?.length || 1, width = payload.columnCount || payload.values?.[0]?.length || 1;
    return { id: payload.id, sheetId: tab.id, row: payload.row, column: payload.column, rowCount: height, columnCount: width, totalRows: tab.rowCount, totalColumns: tab.columnCount,
      values: Array.from({ length: height }, (_, r) => Array.from({ length: width }, (_, c) => cell(tab, payload.row + r, payload.column + c).display)),
      inputs: Array.from({ length: height }, (_, r) => Array.from({ length: width }, (_, c) => cell(tab, payload.row + r, payload.column + c).input)),
      versions: Array.from({ length: height }, (_, r) => Array.from({ length: width }, (_, c) => 'v' + cell(tab, payload.row + r, payload.column + c).revision)) };
  }
  function execute(method, payload) {
    const next = state.failures[method]?.shift(); if (next) throw new Error('[' + next + '] Проверочная ошибка.');
    if (method === 'getGridWorkbook') return { id: payload.id, name: 'Кухни — рабочая база', canEdit: state.canEdit, sheets: state.sheets.map(({ cells, ...value }) => ({ ...value })) };
    if (method === 'getGridRange') return range(payload);
    if (method === 'saveGridRange') {
      const previous = state.receipts.get(payload.requestId);
      if (previous) { if (JSON.stringify(previous) !== JSON.stringify(payload)) throw new Error('[REQUEST_REUSED] Изменён запрос.'); return { state: 'saved', recovered: true, ...range(payload) }; }
      const tab = find(payload.sheetId);
      for (let r = 0; r < payload.values.length; r++) for (let c = 0; c < payload.values[r].length; c++) if (payload.expected[r][c] !== 'v' + cell(tab, payload.row + r, payload.column + c).revision) throw new Error('[GRID_CONFLICT] Ячейка уже изменена другим пользователем.');
      for (let r = 0; r < payload.values.length; r++) for (let c = 0; c < payload.values[r].length; c++) gridServerEdit(tab.id, payload.row + r, payload.column + c, payload.values[r][c]);
      state.receipts.set(payload.requestId, structuredClone(payload));
      if (state.failAfterSave) { state.failAfterSave = false; throw new Error('[GRID_UNCERTAIN] Ответ о записи потерялся.'); }
      return { state: 'saved', recovered: false, ...range(payload) };
    }
    if (method === 'appendGridRows' || method === 'appendGridColumns') {
      const tab = find(payload.sheetId), previous = state.receipts.get(payload.requestId), rows = method === 'appendGridRows';
      if (!previous) { if ((rows ? tab.rowCount : tab.columnCount) !== (rows ? payload.expectedRowCount : payload.expectedColumnCount)) throw new Error('[GRID_CONFLICT] Размер листа изменился.'); if (rows) tab.rowCount += payload.count; else tab.columnCount += payload.count; state.receipts.set(payload.requestId, structuredClone(payload)); }
      return { state: 'saved', recovered: !!previous, id: payload.id, sheetId: tab.id, rowCount: tab.rowCount, columnCount: tab.columnCount };
    }
    throw new Error('Unexpected method: ' + method);
  }
  window.fakeGridRpc = (method, payload) => new Promise((resolve, reject) => {
    state.calls.push({ method, payload: structuredClone(payload) }); state.active++; state.maxActive = Math.max(state.active, state.maxActive);
    const run = () => { try { const value = execute(method, payload); state.active--; resolve(value); } catch (error) { state.active--; reject(error); } };
    if (state.holdMethods.includes(method)) state.pending.push({ method, run }); else setTimeout(run, 8);
  });
  window.releaseGridRpc = method => { const index = state.pending.findIndex(item => item.method === method); if (index < 0) throw new Error('No held method: ' + method); state.pending.splice(index, 1)[0].run(); };
  window.openTestGrid = () => RegistryGrid.open({ id: 'grid_file_1234567890', transport: fakeGridRpc, onClose: () => { window.gridClosed = (window.gridClosed || 0) + 1; } });
  window.copiedGridText = null;
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.copiedGridText = value; } } });
})();
