"""Contact workspace UI checks. Local RPCs only, no provider/network/user data."""
import sys
sys.dont_write_bytecode = True
from playwright.sync_api import sync_playwright
from grid_client import HTML


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
        page = browser.new_page(viewport={'width': 1440, 'height': 1000})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))

        def reset(automatic=False):
            page.goto('about:blank')
            page.set_content(HTML)
            page.evaluate('(enabled)=>{gridBackend.contactsEnabled=enabled;void openTestGrid();}', automatic)
            page.wait_for_function('gridBackend.active===0 && !document.getElementById("rg-grid-new-contacts").disabled')

        def idle():
            page.wait_for_function('gridBackend.active===0 && !RegistryGrid.hasPending()')

        def held(method):
            page.wait_for_function('(method)=>gridBackend.pending.some(item=>item.method===method)', arg=method)

        def release(method):
            page.evaluate('(method)=>releaseGridRpc(method)', method)

        # A focused unsaved cell is flushed before scanning. The browser sends
        # only file/receipt identifiers; it never resubmits existing checked rows.
        reset()
        page.evaluate("gridBackend.holdMethods=['saveGridRange']")
        page.locator('#rg-cell-2-2').dblclick()
        page.locator('#rg-grid-editor').fill('new@example.test')
        page.locator('#rg-grid-new-contacts').click()
        held('saveGridRange')
        assert page.evaluate("gridBackend.calls.filter(c=>c.method==='syncWorkbookContacts').length") == 0
        release('saveGridRange')
        idle()
        calls = page.evaluate('gridBackend.calls')
        save = next(i for i, call in enumerate(calls) if call['method'] == 'saveGridRange')
        sync = next(i for i, call in enumerate(calls) if call['method'] == 'syncWorkbookContacts')
        validation = next(i for i, call in enumerate(calls) if call['method'] == 'advanceWorkbookValidation')
        assert save < sync < validation
        assert set(calls[sync]['payload']) == {'id', 'requestId'}
        assert page.evaluate('gridBackend.checked') == ['valid@example.test', 'invalid@example.test']
        assert 'Уже проверенные' in page.locator('#rg-grid-contact-message').inner_text()
        assert page.evaluate('gridBackend.maxActive') == 1

        # Lost sync acknowledgement resumes the exact UUID, no duplicate append.
        reset()
        page.evaluate('gridBackend.failAfterSync=true')
        page.locator('#rg-grid-new-contacts').click()
        page.wait_for_selector('#rg-grid-contact-retry:not([hidden])')
        first = page.evaluate("gridBackend.calls.find(c=>c.method==='syncWorkbookContacts').payload")
        page.locator('#rg-grid-contact-retry').click()
        idle()
        attempts = page.evaluate("gridBackend.calls.filter(c=>c.method==='syncWorkbookContacts')")
        assert len(attempts) == 2 and attempts[1]['payload'] == first
        assert page.evaluate('gridBackend.syncRuns') == 1

        # A concurrent server job returns its original receipt. Continuation
        # must use that receipt rather than the fresh button-click UUID.
        reset()
        page.evaluate('gridBackend.syncProcessing=true')
        page.locator('#rg-grid-new-contacts').click()
        idle()
        calls=page.evaluate("gridBackend.calls.filter(c=>['syncWorkbookContacts','continueContactSync'].includes(c.method))")
        assert calls[0]['payload']['requestId']!='existing-contact-request'
        assert calls[1]['payload']['requestId']=='existing-contact-request'

        # Controlled source changes permit a fresh snapshot. Unknown write
        # results above retain the exact original mutation receipt instead.
        reset()
        page.evaluate("gridBackend.failures.syncWorkbookContacts=['CONTACT_SOURCE_CHANGED']")
        page.locator('#rg-grid-new-contacts').click()
        page.wait_for_function("document.getElementById('rg-grid-contact-progress').dataset.error==='true'")
        assert page.locator('#rg-grid-contact-retry').is_hidden()
        idle()
        page.locator('#rg-grid-new-contacts').click()
        idle()
        calls=page.evaluate("gridBackend.calls.filter(c=>c.method==='syncWorkbookContacts')")
        assert len(calls)==2 and calls[0]['payload']['requestId']!=calls[1]['payload']['requestId']

        # Only source edits schedule debounced scanning. Editing a generated tab
        # cannot create a validation loop or another billable request.
        reset(True)
        page.locator('#rg-cell-2-2').dblclick()
        page.locator('#rg-grid-editor').fill('automatic@example.test')
        page.locator('#rg-grid-editor').press('Enter')
        page.wait_for_function('gridBackend.syncRuns===1')
        idle()
        page.locator('#rg-grid-tabs button[data-sheet-id="1"]').click()
        idle()
        page.locator('#rg-cell-4-2').dblclick()
        page.locator('#rg-grid-editor').fill('Ручная заметка')
        page.locator('#rg-grid-editor').press('Enter')
        idle()
        page.wait_for_timeout(2300)
        assert page.evaluate('gridBackend.syncRuns') == 1

        # The API key is write-only. Its password input is cleared synchronously,
        # before a held RPC completes; the default budget remains manual.
        reset()
        page.locator('#rg-grid-validation-open').click()
        idle()
        page.locator('#rg-grid-provider-settings').evaluate('(node)=>node.open=true')
        assert page.locator('#rg-grid-provider-limit').input_value() == '0'
        page.locator('#rg-grid-provider-key').fill('demo-key-for-ui-test')
        page.locator('#rg-grid-provider-enabled').check()
        page.evaluate("gridBackend.holdMethods=['configurePromouser']")
        page.locator('#rg-grid-provider-save').click()
        held('configurePromouser')
        assert page.locator('#rg-grid-provider-key').input_value() == ''
        assert 'demo-key-for-ui-test' not in page.locator('#rg-grid-panel').inner_text()
        release('configurePromouser')
        idle()
        assert 'сохранено' in page.locator('#rg-grid-provider-message').inner_text()
        page.locator('#rg-grid-provider-balance').click()
        idle()
        assert '$12.50' in page.locator('#rg-grid-provider-message').inner_text()
        page.locator('#rg-grid-automation-toggle').click()
        idle()
        assert '5 минут' in page.locator('#rg-grid-automation-message').inner_text()

        # An explicit payment displays the quoted cost and is never sent simply
        # by opening the drawer. A retry uses the same payment receipt UUID.
        reset()
        page.evaluate("gridBackend.validationJobs=[{jobId:'quote1',kind:'email',state:'awaiting_payment',cost:1.25,canPay:true,message:'Ожидает оплаты'}]")
        page.locator('#rg-grid-validation-open').click()
        idle()
        assert page.evaluate("gridBackend.calls.filter(c=>c.method==='payValidationOrder').length") == 0
        pay = page.locator('#rg-grid-validation-jobs button')
        assert pay.inner_text() == 'Подтвердить оплату $1.25'
        page.evaluate("gridBackend.failures.payValidationOrder=['PAY_UNCERTAIN']")
        pay.click()
        idle()
        pay.click()
        idle()
        payments = page.evaluate("gridBackend.calls.filter(c=>c.method==='payValidationOrder')")
        assert len(payments) == 2 and payments[0]['payload'] == payments[1]['payload']

        # A changed price requires a fresh visible quote and a new approval.
        reset()
        page.evaluate("gridBackend.validationJobs=[{jobId:'quote2',kind:'telegram',state:'awaiting_payment',cost:1.25,canPay:true,message:'Ожидает оплаты'}]")
        page.locator('#rg-grid-validation-open').click()
        idle()
        page.evaluate("gridBackend.validationJobs[0].cost=1.50;gridBackend.failures.payValidationOrder=['PV_COST_CHANGED']")
        page.locator('#rg-grid-validation-jobs button').click()
        idle()
        assert page.locator('#rg-grid-validation-jobs button').inner_text()=='Подтвердить оплату $1.5'
        page.locator('#rg-grid-validation-jobs button').click()
        idle()
        payments=page.evaluate("gridBackend.calls.filter(c=>c.method==='payValidationOrder')")
        assert [c['payload']['expectedCostUsd'] for c in payments]==[1.25,1.5]
        assert payments[0]['payload']['requestId']!=payments[1]['payload']['requestId']

        # Status polling cannot run more often than Promouser's 15-second limit,
        # even when nextPollAt is already due. Hiding the drawer clears its timer.
        reset()
        page.evaluate("""()=>{const original=setTimeout;window.validationDelays=[];window.setTimeout=(fn,ms,...args)=>{if(ms>=10000)validationDelays.push(ms);return original(fn,ms,...args);};gridBackend.providerSettings={configured:true,enabled:true,autoPayLimitUsd:0,mode:'direct'};gridBackend.validationJobs=[{jobId:'running',kind:'email',state:'checking',nextPollAt:Date.now()-1000,canPay:false}];}""")
        page.locator('#rg-grid-validation-open').click()
        idle()
        assert page.evaluate('validationDelays.length')>=1
        assert all(delay>=15000 for delay in page.evaluate('validationDelays'))
        page.wait_for_function("gridBackend.calls.filter(c=>c.method==='refreshWorkbookValidation').length===1",timeout=20000)
        idle()
        page.wait_for_function("gridBackend.calls.filter(c=>c.method==='refreshWorkbookValidation').length===2",timeout=20000)
        idle()
        poll_calls=page.evaluate("gridBackend.calls.filter(c=>c.method==='refreshWorkbookValidation')")
        initial=page.evaluate("gridBackend.calls.find(c=>c.method==='getValidationState').at")
        assert poll_calls[0]['at']-initial>=14900
        assert poll_calls[1]['at']-poll_calls[0]['at']>=14900
        assert all(8<=len(call['payload']['requestId'])<=120 for call in poll_calls)
        assert poll_calls[0]['payload']['requestId']!=poll_calls[1]['payload']['requestId']
        assert 'Проверочная ошибка' not in page.locator('#rg-grid-validation-summary').inner_text()
        page.locator('#rg-grid-validation-close').click()
        page.wait_for_timeout(100)
        assert page.evaluate("gridBackend.calls.filter(c=>c.method==='refreshWorkbookValidation').length")==2

        # Server continuation hints include an explicitly budgeted auto-payment
        # and cached result pages without remaining provider jobs. Deterministic
        # timer delivery keeps this check local and advances the advertised clock.
        reset()
        page.evaluate("""()=>{let now=Date.now();Date.now=()=>now;const originalSet=setTimeout,originalClear=clearTimeout;window.continuationTimers=[];window.setTimeout=(fn,ms,...args)=>{if(ms>=15000){const timer={fn,delay:ms,active:true,id:originalSet(()=>{},3600000)};continuationTimers.push(timer);return timer.id;}return originalSet(fn,ms,...args);};window.clearTimeout=id=>{const timer=continuationTimers.find(item=>item.id===id);if(timer)timer.active=false;originalClear(id);};window.deliverContinuation=()=>{const timer=continuationTimers.find(item=>item.active);if(!timer)throw new Error('Нет запланированного продолжения');timer.active=false;originalClear(timer.id);now+=timer.delay;timer.fn();};gridBackend.providerSettings={configured:true,enabled:true,autoPayLimitUsd:5,mode:'direct'};gridBackend.validationState='pending';gridBackend.validationAutoAdvance=true;gridBackend.validationNextActionAt=now+1000;gridBackend.validationJobs=[{jobId:'budgeted',kind:'email',state:'awaiting_payment',cost:1,canPay:true}];}""")
        page.locator('#rg-grid-validation-open').click()
        idle()
        assert page.evaluate('continuationTimers.filter(t=>t.active).length')==1
        page.evaluate('deliverContinuation()')
        idle()
        assert page.evaluate("gridBackend.calls.filter(c=>c.method==='refreshWorkbookValidation').length")==1
        assert page.evaluate('continuationTimers.filter(t=>t.active).length')==1
        page.evaluate("gridBackend.validationJobs=[];gridBackend.validationState='pending';gridBackend.validationAutoAdvance=true;deliverContinuation()")
        idle()
        assert page.evaluate("gridBackend.calls.filter(c=>c.method==='refreshWorkbookValidation').length")==2
        assert page.evaluate('continuationTimers.filter(t=>t.active).length')==1
        page.evaluate("gridBackend.providerSettings.autoPayLimitUsd=0;gridBackend.validationAutoAdvance=false;gridBackend.validationJobs=[{jobId:'manual',kind:'email',state:'awaiting_payment',cost:1,canPay:true}];deliverContinuation()")
        idle()
        assert page.evaluate('continuationTimers.filter(t=>t.active).length')==0
        assert page.evaluate("gridBackend.calls.filter(c=>c.method==='payValidationOrder').length")==0

        # Access revocation wins over a late mutation response and clears secrets.
        reset()
        page.evaluate("gridBackend.holdMethods=['syncWorkbookContacts']")
        page.locator('#rg-grid-new-contacts').click()
        held('syncWorkbookContacts')
        page.evaluate('RegistryGrid.lock()')
        release('syncWorkbookContacts')
        page.wait_for_function('gridBackend.active===0')
        assert page.locator('#rg-grid-panel').is_hidden()
        assert page.locator('#rg-grid-provider-key').input_value() == ''
        assert page.evaluate("gridBackend.calls.filter(c=>c.method==='advanceWorkbookValidation').length") == 0

        reset()
        page.locator('#rg-grid-validation-open').click()
        idle()
        for width in [1440, 360, 320]:
            page.set_viewport_size({'width': width, 'height': 900})
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
            drawer = page.locator('#rg-grid-validation').bounding_box()
            assert drawer['x'] >= 0 and drawer['x'] + drawer['width'] <= width
        assert not errors, errors
        print('PASS: contact scan flush, exact retry, source-only debounce, checked-row preservation, write-only settings, explicit payment, lock, responsive drawer.')
        browser.close()


if __name__ == '__main__':
    main()
