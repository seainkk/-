/** @OnlyCurrentDoc */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Email')
    .addItem('Проверить новые email в Promouser', 'validateNewEmail')
    .addItem('Загрузить готовые контакты в рассылку', 'uploadReadyEmail')
    .addToUi();
}

function validateNewEmail() { showCompanyEmailAction_('email'); }
function uploadReadyEmail() { showCompanyEmailAction_('mailing'); }

function showCompanyEmailAction_(action) {
  var book = SpreadsheetApp.getActiveSpreadsheet(), sheet = book.getSheetByName('Email');
  if (sheet) book.setActiveSheet(sheet);
  var project = '', id = book.getId();
  if (sheet && sheet.getLastColumn()) {
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getRichTextValues()[0];
    headers.some(function (header) {
      var url = header && header.getLinkUrl();
      if (!url || url.indexOf('https://seainkk.github.io/-/?validate=' + encodeURIComponent(id) + '&') !== 0) return false;
      var match = url.match(/[?&]project=(numshield|neosender)(?:&|$)/);
      if (match) project = match[1];
      return !!project;
    });
  }
  var src = 'https://seainkk.github.io/-/?validate=' + encodeURIComponent(id) + '&amp;action=' + action + (project ? '&amp;project=' + project : '');
  var html = HtmlService.createHtmlOutput('<!doctype html><html lang="ru"><meta charset="utf-8"><style>html,body,iframe{width:100%;height:100%;margin:0;border:0;display:block}</style><iframe title="Действия с email" referrerpolicy="no-referrer" src="' + src + '"></iframe></html>').setWidth(1030).setHeight(650);
  SpreadsheetApp.getUi().showModalDialog(html, action === 'email' ? 'Проверка новых email' : 'Загрузка готовых контактов в Coldy');
}
