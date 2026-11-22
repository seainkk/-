"""Coldy settings, campaign uploads and email validation with local RPC fakes.

Run: python tests/browser/coldy_client.py
Requires Python Playwright and Chromium. No external requests or paid operations.
"""
import sys
from pathlib import Path

sys.dont_write_bytecode = True
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[2]
BROWSER = Path(__file__).parent


def source(name):
    return (ROOT / 'src' / name).read_text(encoding='utf-8')


COLDY_FIXTURE = (BROWSER / 'coldy-fixture.js').read_text(encoding='utf-8')
REGISTRY_HTML = source('Index.html').replace(
    "<?!= include_('Styles'); ?>", source('Styles.html')
).replace(
    "<?!= include_('Client'); ?>",
    '<script>' + (BROWSER / 'performance-fixture.js').read_text(encoding='utf-8')
    + COLDY_FIXTURE + '</script>' + source('Client.html')
)
GRID_HTML = (
    '<!doctype html><html lang="ru"><head><meta charset="utf-8">'
    '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + source('Styles.html') + source('GridStyles.html')
    + '</head><body><main id="bases-registry-app">' + source('GridPanel.html')
    + '</main><script>' + (BROWSER / 'grid-fixture.js').read_text(encoding='utf-8')
    + COLDY_FIXTURE + '</script>' + source('GridClient.html') + '</body></html>'
)


def main():
    with sync_playwright() as playwright:
        options = {'headless': True}
        if sys.platform == 'win32':
            options['channel'] = 'chrome'
        else:
            options.update(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        browser = playwright.chromium.launch(**options)
        page = browser.new_page(viewport={'width': 1440, 'height': 1000})
        errors, outbound = [], []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('request', lambda request: outbound.append(request.url))

        def registry_reset():
            page.goto('about:blank')
            page.set_content(REGISTRY_HTML)
            page.wait_for_function('backend.active===0 && backend.sourceGets>0')

        def registry_idle():
            page.wait_for_function('backend.active===0')

        def registry_calls(method):
            return page.evaluate('(method)=>backend.calls.filter(call=>call.name===method)', method)

        def open_settings():
            page.locator('#br-coldy-open').click()
            expect(page.locator('#br-coldy-dialog')).to_be_visible()
            registry_idle()

        def open_mailings():
            page.locator('#br-view-segments').click()
            page.wait_for_selector('[data-segment="existing-segment"]')
            registry_idle()
            page.locator('[data-segment="existing-segment"] .br-link-button').click()
            expect(page.locator('#br-coldy-bindings-panel')).to_be_visible()
            registry_idle()

        def grid_reset(editable=True):
            page.goto('about:blank')
            page.set_content(GRID_HTML)
            page.evaluate('(editable)=>{gridBackend.canEdit=editable;void openTestGrid();}', editable)
            page.wait_for_selector('#rg-cell-2-1')
            grid_idle()

        def grid_idle():
            page.wait_for_function('gridBackend.active===0 && !RegistryGrid.hasPending()')

        def grid_calls(method):
            return page.evaluate('(method)=>gridBackend.calls.filter(call=>call.method===method)', method)

        def open_validation():
            page.locator('#rg-grid-validation-open').click()
            expect(page.locator('#rg-grid-validation')).to_be_visible()
            grid_idle()

        # Opening settings and testing the connection are read-only. A saved
        # credential is never reflected into the password field or page text.
        registry_reset()
        assert not registry_calls('listColdyCampaigns'), 'No campaign API fanout at startup'
        assert not registry_calls('startColdyValidation')
        assert not registry_calls('startColdyUpload')
        open_settings()
        key = page.locator('#br-coldy-key')
        save = page.locator('#br-coldy-save')
        expect(key).to_have_attribute('type', 'password')
        expect(key).to_have_value('')
        expect(page.locator('#br-coldy-provider')).to_have_value('promouser')
        assert page.locator('#br-coldy-auto').count() == 0
        page.locator('#br-coldy-test').click()
        registry_idle()
        assert len(registry_calls('testColdyConnection')) == 1
        assert not registry_calls('startColdyValidation')
        assert not registry_calls('startColdyUpload')
        assert 'stored-coldy-fixture-key' not in page.locator('body').inner_text()

        # Blank means keep the existing key. Replacement is cleared before the
        # mutation resolves, including while a request is held by the fixture.
        save.click()
        registry_idle()
        assert 'apiKey' not in registry_calls('configureColdy')[-1]['p']
        assert registry_calls('configureColdy')[-1]['p']['autoValidateEmails'] is False
        assert page.evaluate('coldyBackend.key') == 'stored-coldy-fixture-key'
        page.evaluate("backend.holdMethods=['configureColdy']")
        key.fill('replacement-coldy-fixture-key')
        save.click()
        page.wait_for_function("backend.pending.some(call=>call.method==='configureColdy')")
        expect(key).to_have_value('')
        expect(save).to_be_disabled()
        page.evaluate("backend.holdMethods=[];releaseRpc('configureColdy')")
        expect(save).to_be_enabled()
        assert page.evaluate('coldyBackend.key') == 'replacement-coldy-fixture-key'

        # Choosing Coldy for email never enables automatic spending. All new
        # validation requires a preview and explicit confirmation in a workbook.
        page.locator('#br-coldy-provider').select_option('coldy')
        save.click()
        registry_idle()
        payload = registry_calls('configureColdy')[-1]['p']
        assert payload['autoValidateEmails'] is False
        assert payload['emailValidationProvider'] == 'coldy'
        assert 'autoPayLimitUsd' not in payload
        assert not registry_calls('startColdyValidation')

        key.fill('unsaved-key')
        page.keyboard.press('Escape')
        expect(page.locator('#br-coldy-dialog')).to_be_hidden()
        expect(key).to_have_value('')
        open_settings()
        key.fill('unsaved-key-before-revoke')
        page.evaluate('backend.revoked=true')
        page.locator('#br-coldy-test').click()
        expect(page.locator('#br-coldy-dialog')).to_be_hidden()
        expect(page.locator('#br-coldy-open')).to_be_hidden()
        expect(key).to_have_value('')

        # Missing owner OAuth consent is actionable in the central project.
        # The help survives rendering, uses no saved credential, and disappears
        # at the next attempt rather than suggesting the old error still holds.
        registry_reset()
        open_settings()
        key = page.locator('#br-coldy-key')
        owner_help = page.locator('#br-coldy-owner')
        test_connection = page.locator('#br-coldy-test')
        owner_error = '[COLDY_OWNER_AUTH_REQUIRED] Владельцу нужно разрешить внешние запросы Google.'

        def owner_auth_error():
            page.evaluate('(message)=>{coldyBackend.connectionError=message;}', owner_error)
            test_connection.click()
            registry_idle()
            expect(owner_help).to_be_visible()
            expect(key).to_have_value('')
            assert 'stored-coldy-fixture-key' not in page.locator('body').inner_text()

        expect(owner_help).to_be_hidden()
        owner_auth_error()
        expect(owner_help.locator('a')).to_have_attribute(
            'href', 'https://script.google.com/home/projects/'
            '1FyQVeeqd4X13NqQ7PtRMVg7U8p60yk-tWvgK-9vmPdpQgK-mQE3sL8aH/edit')
        expect(owner_help.locator('a')).to_have_attribute('rel', 'noopener noreferrer')
        expect(owner_help.locator('code')).to_have_text('authorizeGoogleAccess')
        for instruction in ['Выполнить', 'один раз', 'центральном проекте',
                            'не в каждой таблице', 'вводить его повторно не нужно',
                            'обновите страницу редактора', 'ContactAutomation.gs',
                            'без подчёркивания', 'Если фоновая обработка ещё не включена',
                            'Включить обработку изменений в Google Таблицах']:
            expect(owner_help).to_contain_text(instruction)
        assert not registry_calls('enableContactAutomation'), 'Consent stays a Google owner action'

        page.evaluate("coldyBackend.connectionError='';backend.holdMethods=['testColdyConnection']")
        test_connection.click()
        page.wait_for_function("backend.pending.some(call=>call.method==='testColdyConnection')")
        expect(owner_help).to_be_hidden()
        expect(test_connection).to_be_disabled()
        page.evaluate("backend.holdMethods=[];releaseRpc('testColdyConnection')")
        registry_idle()
        expect(owner_help).to_be_hidden()
        expect(page.locator('#br-coldy-message')).to_contain_text('Подключение подтверждено')

        page.evaluate("coldyBackend.connectionError='[COLDY_NETWORK] Соединение временно недоступно.'")
        test_connection.click()
        registry_idle()
        expect(owner_help).to_be_hidden()
        expect(page.locator('#br-coldy-message')).to_contain_text('временно недоступно')

        owner_auth_error()
        page.evaluate("backend.holdMethods=['configureColdy']")
        page.locator('#br-coldy-save').click()
        page.wait_for_function("backend.pending.some(call=>call.method==='configureColdy')")
        expect(owner_help).to_be_hidden()
        expect(key).to_have_value('')
        page.evaluate("backend.holdMethods=[];releaseRpc('configureColdy')")
        registry_idle()
        assert 'apiKey' not in registry_calls('configureColdy')[-1]['p']
        expect(owner_help).to_be_hidden()

        owner_auth_error()
        page.locator('#br-coldy-close').click()
        expect(owner_help).to_be_hidden()
        open_settings()
        expect(owner_help).to_be_hidden()
        # A late owner error from a closed dialog cannot reintroduce the help.
        page.evaluate("backend.holdMethods=['testColdyConnection']")
        test_connection.click()
        page.wait_for_function("backend.pending.some(call=>call.method==='testColdyConnection')")
        page.locator('#br-coldy-close').click()
        page.evaluate("backend.holdMethods=[];releaseRpc('testColdyConnection')")
        registry_idle()
        expect(owner_help).to_be_hidden()
        expect(page.locator('#br-coldy-dialog')).to_be_hidden()

        open_settings()
        owner_auth_error()
        page.evaluate('backend.revoked=true')
        test_connection.click()
        expect(page.locator('#br-coldy-dialog')).to_be_hidden()
        expect(owner_help).to_be_hidden()
        expect(key).to_have_value('')

        # Binding an existing campaign saves local policy; only a later preview
        # confirmation can upload contacts. Campaign names and samples are text.
        registry_reset()
        page.evaluate('coldyBackend.mailingsConnected=true')
        open_mailings()
        service = page.locator('#br-mailings-services .br-mailing-service').filter(has_text='Coldy')
        assert service.locator('dd').all_text_contents() == ['0', '—', '—']
        assert not registry_calls('startColdyUpload')
        assert page.locator('#br-coldy-campaign option').count() == 1
        assert not registry_calls('getProjectAnalyticsCampaigns')
        page.locator('#br-coldy-find-query').fill('Черновик')
        page.locator('#br-coldy-find-query').press('Enter')
        page.locator('#br-coldy-campaign').select_option('campaign-draft')
        page.locator('#br-coldy-companies').check()
        page.locator('#br-coldy-lpr').check()
        page.locator('#br-coldy-autoupload').uncheck()
        expect(page.locator('#br-coldy-active-consent')).not_to_be_checked()
        page.locator('#br-coldy-binding-save').click()
        registry_idle()
        binding = registry_calls('saveColdyBinding')[-1]['p']
        assert binding['segmentId'] == 'existing-segment'
        assert binding['includeCompanies'] is True and binding['includeLpr'] is True
        assert binding['allowActive'] is False
        assert not registry_calls('startColdyUpload')
        preview = page.locator('[data-coldy-preview="binding-campaign-draft"]')
        expect(preview).to_be_visible()
        page.evaluate('coldyBackend.canUpload=false')
        preview.click()
        registry_idle()
        expect(page.locator('#br-coldy-upload-preview')).to_be_visible()
        expect(page.locator('#br-coldy-upload-start')).to_be_disabled()
        assert not registry_calls('startColdyUpload')
        assert page.locator('#br-coldy-bindings-panel img').count() == 0
        assert page.locator('#br-coldy-upload-preview img').count() == 0
        page.evaluate('coldyBackend.canUpload=true')
        preview.click()
        registry_idle()

        # An unknown result reuses the exact payload and UUID. The local server
        # receipt counts one dispatch even when the response is lost.
        page.evaluate('coldyBackend.failAfterUpload=true')
        page.locator('#br-coldy-upload-start').click()
        expect(page.locator('#br-coldy-upload-retry')).to_be_visible()
        expect(page.locator('[data-coldy-preview="binding-campaign-draft"]')).to_be_disabled()
        expect(page.locator('#br-coldy-binding-save')).to_be_disabled()
        expect(page.locator('#br-coldy-upload-cancel')).to_be_disabled()
        first_upload = registry_calls('startColdyUpload')[-1]['p']
        page.locator('#br-coldy-upload-retry').click()
        registry_idle()
        uploads = registry_calls('startColdyUpload')
        assert len(uploads) == 2 and uploads[-1]['p'] == first_upload
        assert page.evaluate('coldyBackend.uploadRuns') == 1
        assert first_upload['previewToken'] == 'upload-preview-1'

        # A working campaign requires a separate saved opt-in. The UI explains
        # that adding contacts can send email; it never starts the campaign.
        page.locator('#br-coldy-find-query').fill('Рабочая кампания')
        page.locator('#br-coldy-find').click()
        page.locator('#br-coldy-campaign').select_option('campaign-active')
        page.locator('#br-coldy-companies').check()
        page.locator('#br-coldy-active-consent').check()
        page.locator('#br-coldy-binding-save').click()
        registry_idle()
        assert registry_calls('saveColdyBinding')[-1]['p']['allowActive'] is True

        # Continuation has its own recoverable step. A lost continuation keeps
        # the server job and request identifiers without sending another start.
        page.evaluate("coldyBackend.uploadState='processing';coldyBackend.failContinueUpload=true")
        page.locator('[data-coldy-preview="binding-campaign-draft"]').click()
        registry_idle()
        starts_before = len(registry_calls('startColdyUpload'))
        page.locator('#br-coldy-upload-start').click()
        expect(page.locator('#br-coldy-upload-retry')).to_be_visible()
        first_continue = registry_calls('continueColdyUpload')[-1]['p']
        page.locator('#br-coldy-upload-retry').click()
        registry_idle()
        continuations = registry_calls('continueColdyUpload')
        assert len(continuations) == 2 and continuations[-1]['p'] == first_continue
        assert len(registry_calls('startColdyUpload')) == starts_before + 1
        assert first_continue['jobId'] == 'upload-job-1'
        assert all(call['name'] not in ['activateColdyCampaign', 'startColdyCampaign']
                   for call in page.evaluate('backend.calls'))
        assert page.evaluate('backend.transport.every(call=>call.name==="callApp" && call.keyMatches)')

        # Scanning a workbook saves/extracts locally. Even a configured provider
        # and an automatic dollar budget cannot authorize new validation jobs.
        grid_reset()
        page.evaluate("""()=>{
          gridBackend.providerSettings={configured:true,enabled:true,autoPayLimitUsd:5,mode:'direct'};
          gridBackend.validationState='pending';gridBackend.validationAutoAdvance=false;
        }""")
        page.locator('#rg-grid-new-contacts').click()
        grid_idle()
        assert len(grid_calls('syncWorkbookContacts')) == 1
        for method in ['startColdyValidation', 'startPhoneValidation', 'startPromouserValidation',
                       'advanceColdyValidation', 'advanceWorkbookValidation', 'payValidationOrder']:
            assert not grid_calls(method), method

        # Opening validation, refreshing state and requesting a preview remain
        # free. A paid start needs both a server preview and the visible checkbox.
        grid_reset()
        open_validation()
        assert not grid_calls('startColdyValidation')
        assert not grid_calls('advanceColdyValidation')
        page.locator('#rg-grid-coldy-refresh').click()
        grid_idle()
        assert not grid_calls('startColdyValidation')
        page.locator('#rg-grid-coldy-preview').click()
        grid_idle()
        expect(page.locator('#rg-grid-coldy-credit-consent')).not_to_be_checked()
        expect(page.locator('#rg-grid-coldy-start')).to_be_disabled()
        assert not grid_calls('startColdyValidation')
        page.locator('#rg-grid-coldy-credit-consent').check()
        expect(page.locator('#rg-grid-coldy-start')).to_be_enabled()
        page.evaluate('coldyBackend.failAfterValidation=true')
        page.locator('#rg-grid-coldy-start').click()
        grid_idle()
        expect(page.locator('#rg-grid-coldy-preview')).to_be_disabled()
        first_validation = grid_calls('startColdyValidation')[-1]['payload']
        assert first_validation['acceptValidationCredits'] is True
        assert first_validation['previewToken'] == 'validation-preview-1'
        assert first_validation['id'] == 'grid_file_1234567890'
        assert 'emails' not in first_validation and 'sheetName' not in first_validation
        expect(page.locator('#rg-grid-coldy-retry')).to_be_visible()
        page.locator('#rg-grid-coldy-retry').click()
        grid_idle()
        attempts = grid_calls('startColdyValidation')
        assert len(attempts) == 2 and attempts[-1]['payload'] == first_validation
        assert page.evaluate('coldyBackend.validationRuns') == 1
        assert page.evaluate('gridBackend.checked') == ['valid@example.test', 'invalid@example.test']

        # A server rejection before dispatch permits a fresh preview and a new
        # approval. It is distinct from an unknown paid result retained above.
        grid_reset()
        open_validation()
        page.locator('#rg-grid-coldy-preview').click()
        grid_idle()
        page.locator('#rg-grid-coldy-credit-consent').check()
        page.evaluate("coldyBackend.failures.startColdyValidation=['COLDY_PREVIEW_CHANGED']")
        page.locator('#rg-grid-coldy-start').click()
        grid_idle()
        expect(page.locator('#rg-grid-coldy-retry')).to_be_hidden()
        expect(page.locator('#rg-grid-coldy-preview')).to_be_enabled()
        expect(page.locator('#rg-grid-coldy-start')).to_be_disabled()
        assert page.evaluate('coldyBackend.validationRuns') == 0
        rejected = grid_calls('startColdyValidation')[-1]['payload']
        page.locator('#rg-grid-coldy-preview').click()
        grid_idle()
        page.locator('#rg-grid-coldy-credit-consent').check()
        page.locator('#rg-grid-coldy-start').click()
        grid_idle()
        assert grid_calls('startColdyValidation')[-1]['payload']['requestId'] != rejected['requestId']
        assert page.evaluate('coldyBackend.validationRuns') == 1

        # Phone validation also needs a manual preview. Samples identify the
        # country, and uncertain starts keep the original approval receipt.
        grid_reset()
        open_validation()
        assert not grid_calls('startPhoneValidation')
        expect(page.locator('#rg-grid-phone-start')).to_be_disabled()
        page.locator('#rg-grid-phone-preview').click()
        grid_idle()
        expect(page.locator('#rg-grid-phone-sample')).to_contain_text('US')
        expect(page.locator('#rg-grid-phone-sample')).to_contain_text('RU')
        assert not grid_calls('startPhoneValidation')
        page.evaluate('coldyBackend.failAfterPhone=true')
        page.locator('#rg-grid-phone-start').click()
        grid_idle()
        expect(page.locator('#rg-grid-phone-retry')).to_be_visible()
        expect(page.locator('#rg-grid-phone-preview')).to_be_disabled()
        phone_payload = grid_calls('startPhoneValidation')[-1]['payload']
        assert phone_payload['previewToken'] == 'phone-preview-1'
        assert phone_payload['id'] == 'grid_file_1234567890'
        page.locator('#rg-grid-phone-retry').click()
        grid_idle()
        phone_attempts = grid_calls('startPhoneValidation')
        assert len(phone_attempts) == 2 and phone_attempts[-1]['payload'] == phone_payload
        assert page.evaluate('coldyBackend.phoneRuns') == 1

        # Promouser email follows the same manual preview/start gate. A saved
        # $5 order budget applies only after this explicit start approval.
        grid_reset()
        page.evaluate('gridBackend.providerSettings={configured:true,enabled:true,autoPayLimitUsd:5,mode:"direct"}')
        open_validation()
        expect(page.locator('#rg-grid-pv-email-section')).to_be_visible()
        expect(page.locator('#rg-grid-pv-email-start')).to_be_disabled()
        assert not grid_calls('startPromouserValidation')
        page.locator('#rg-grid-pv-email-preview').click()
        grid_idle()
        expect(page.locator('#rg-grid-pv-email-sample')).to_contain_text('new-pv@example.test')
        assert not grid_calls('startPromouserValidation')
        page.evaluate('coldyBackend.failAfterPvEmail=true')
        page.locator('#rg-grid-pv-email-start').click()
        grid_idle()
        expect(page.locator('#rg-grid-pv-email-retry')).to_be_visible()
        expect(page.locator('#rg-grid-pv-email-preview')).to_be_disabled()
        pv_payload = grid_calls('startPromouserValidation')[-1]['payload']
        assert pv_payload['kind'] == 'email'
        assert pv_payload['previewToken'] == 'pv-email-preview-1'
        page.locator('#rg-grid-pv-email-retry').click()
        grid_idle()
        pv_attempts = grid_calls('startPromouserValidation')
        assert len(pv_attempts) == 2 and pv_attempts[-1]['payload'] == pv_payload
        assert page.evaluate('coldyBackend.pvEmailRuns') == 1

        # Locking a workbook wins over a late response from a paid start. The
        # response cannot reopen the drawer or schedule more provider requests.
        grid_reset()
        open_validation()
        page.locator('#rg-grid-coldy-preview').click()
        grid_idle()
        page.locator('#rg-grid-coldy-credit-consent').check()
        page.evaluate("coldyBackend.holdMethods=['startColdyValidation']")
        page.locator('#rg-grid-coldy-start').click()
        page.wait_for_function("coldyBackend.pending.some(call=>call.method==='startColdyValidation')")
        page.evaluate('RegistryGrid.lock();releaseColdyRpc("startColdyValidation")')
        page.wait_for_function('gridBackend.active===0')
        expect(page.locator('#rg-grid-panel')).to_be_hidden()
        assert not grid_calls('advanceColdyValidation')

        # Provider status work obeys a 15-second floor, including an already-due
        # server hint. Hiding or locking the drawer cancels scheduled work.
        grid_reset()
        page.evaluate("""()=>{
          installColdyTimers();
          coldyBackend.settings.emailValidationProvider='coldy';
          coldyBackend.validationState='processing';coldyBackend.validationAutoAdvance=true;
          coldyBackend.validationNextActionAt=Date.now()-1000;
          coldyBackend.validationJobs=[{jobId:'validation-job',batchId:'batch-1',state:'processing',
            contacts:3,reservedCredits:3,chargedCredits:null,progress:{completed:0,total:3}}];
        }""")
        open_validation()
        expect(page.locator('#rg-grid-pv-email-section')).to_be_hidden()
        assert not grid_calls('startColdyValidation')
        assert not grid_calls('advanceColdyValidation')
        assert page.evaluate('coldyTimers.filter(timer=>timer.active).length') == 1
        assert all(delay >= 15000 for delay in page.evaluate('coldyTimers.map(timer=>timer.delay)'))
        page.evaluate('deliverColdyTimer()')
        grid_idle()
        polls = grid_calls('advanceColdyValidation')
        assert len(polls) == 1
        state_read = grid_calls('getColdyValidationState')[0]
        assert polls[0]['at'] - state_read['at'] >= 15000
        page.evaluate("coldyBackend.failures.advanceColdyValidation=['COLDY_UNCERTAIN'];deliverColdyTimer()")
        grid_idle()
        expect(page.locator('#rg-grid-coldy-retry')).to_be_visible()
        failed_poll = grid_calls('advanceColdyValidation')[-1]['payload']
        assert page.evaluate('coldyTimers.filter(timer=>timer.active).length') == 0
        page.locator('#rg-grid-coldy-retry').click()
        grid_idle()
        assert grid_calls('advanceColdyValidation')[-1]['payload'] == failed_poll
        assert len(grid_calls('advanceColdyValidation')) == 3
        page.locator('#rg-grid-validation-close').click()
        assert page.evaluate('coldyTimers.filter(timer=>timer.active).length') == 0

        open_validation()
        grid_idle()
        page.evaluate('RegistryGrid.lock()')
        expect(page.locator('#rg-grid-panel')).to_be_hidden()
        assert page.evaluate('coldyTimers.filter(timer=>timer.active).length') == 0

        # Read-only workbooks offer status reads but cannot create paid jobs.
        grid_reset(False)
        open_validation()
        expect(page.locator('#rg-grid-coldy-preview')).to_be_disabled()
        expect(page.locator('#rg-grid-coldy-start')).to_be_disabled()
        assert not grid_calls('startColdyValidation')
        assert not grid_calls('advanceColdyValidation')

        for width in [1440, 360, 320]:
            page.set_viewport_size({'width': width, 'height': 900})
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
        assert not errors, errors
        assert not outbound, outbound
        browser.close()
        print('PASS: Coldy write-only settings, manual provider previews, explicit credits, uploads, exact retries, read-only mode and 15s polling; local RPCs only.')


if __name__ == '__main__':
    main()
