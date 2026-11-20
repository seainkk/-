/** One explicit email provider; removing a key never enables a paid fallback. */
function emailValidationProvider_(context) {
  var value = context.properties.getProperty('EMAIL_VALIDATION_PROVIDER');
  if (value === null || value === undefined || value === '') return 'promouser';
  if (value !== 'promouser' && value !== 'coldy') fail_('VALIDATION_PROVIDER_INVALID', 'Выберите сервис проверки email в настройках подключения.');
  return value;
}
