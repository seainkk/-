/** @OnlyCurrentDoc */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Email')
    .addItem('Проверить новые email в Promouser', 'validateNewEmail')
    .addItem('Загрузить готовые контакты в рассылку', 'uploadReadyEmail')
    .addToUi();
  SpreadsheetApp.getUi().createMenu('Телеграм')
    .addItem('Проверить новые телефоны в Promouser', 'validateNewPhones')
    .addItem('Выгрузить готовые контакты', 'exportTelegramReady')
    .addItem('Выгрузить телефоны для записной книжки', 'exportTelegramAddressBook')
    .addToUi();
}

function validateNewEmail() { showCompanyAction_('email', 'Email', 'Проверка новых email'); }
function uploadReadyEmail() { showCompanyAction_('mailing', 'Email', 'Загрузка готовых контактов в Coldy'); }
function validateNewPhones() { showCompanyAction_('telegram', 'Телеграм', 'Проверка новых телефонов'); }
function exportTelegramReady() { showCompanyAction_('telegramReady', 'Телеграм', 'Выгрузка готовых контактов'); }
function exportTelegramAddressBook() { showCompanyAction_('telegramAddressBook', 'Телеграм', 'Выгрузка телефонов для записной книжки'); }

function showCompanyAction_(action, tab, title) {
  var book = SpreadsheetApp.getActiveSpreadsheet(), sheet = book.getSheetByName(tab);
  if (!sheet && tab === 'Телеграм') sheet = book.getSheetByName('Телефоны');
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
  var html = HtmlService.createHtmlOutput('<!doctype html><html lang="ru"><meta charset="utf-8"><style>html,body,iframe{width:100%;height:100%;margin:0;border:0;display:block}</style><iframe title="' + title + '" referrerpolicy="no-referrer" src="' + src + '"></iframe></html>').setWidth(1030).setHeight(650);
  SpreadsheetApp.getUi().showModalDialog(html, title);
}
