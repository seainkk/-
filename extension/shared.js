/* Shared locally by the content script and service worker. No external code. */
(function () {
  'use strict';

  function isSpreadsheetUrl(value) {
    try {
      const url = new URL(value);
      if (url.origin !== 'https://docs.google.com') return false;
      const match = url.pathname.match(/^\/spreadsheets\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]+)(?:\/|$)/);
      return !!match && match[1] !== 'e';
    } catch (_) {
      return false;
    }
  }

  globalThis.RegistryTasks = Object.freeze({
    registryUrl: 'https://script.google.com/macros/s/AKfycbxKxdFPQt4gGQAOrgyRUBNm1yQEhEyEeXTiPPZqYz2KsVEZNyD6gXrDRj78BhgybCv0WA/exec',
    messageType: 'registry-tasks:toggle',
    isSpreadsheetUrl: isSpreadsheetUrl
  });
})();
