"""Controlled-latency browser regressions for the shipped client.

Run: python tests/browser/performance_client.py
Requires Playwright Python and Chromium (no production/npm dependency).
All RPCs are local fakes; no Google or GitHub data is changed.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = Path(__file__).with_name('performance-fixture.js').read_text()
INDEX = (ROOT / 'src/Index.html').read_text()
HTML = INDEX.replace("<?!= include_('Styles'); ?>", (ROOT / 'src/Styles.html').read_text()).replace("<?!= include_('Client'); ?>", '<script>' + FIXTURE + '</script>' + (ROOT / 'src/Client.html').read_text())


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
        page = browser.new_page(viewport={'width': 1440, 'height': 1100})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))

        def reset(html=HTML):
            page.goto('about:blank')
            page.set_content(html)
            page.wait_for_selector('[data-source-id="source-companies"]')
            page.wait_for_function('backend.active===0')

        def segments():
            page.locator('#br-view-segments').click()
            page.wait_for_selector('[data-segment="existing-segment"]')
            page.wait_for_function('backend.active===0')

        def held(method):
            page.wait_for_function('(method)=>backend.pending.some(item=>item.method===method)', arg=method)

        def release(method):
            page.evaluate('(method)=>releaseRpc(method)', method)

        def idle():
            page.wait_for_function('backend.active===0')

        reset()
        segments()
        initial = page.evaluate('[backend.sourceGets,backend.dashboardGets]')
        page.locator('#br-add-segment').click()
        assert page.locator('#br-segment-panel').is_visible()
        assert page.locator('#br-segment-name').is_enabled()
        assert page.locator('#br-segment-submit').is_enabled()
        assert page.evaluate('[backend.sourceGets,backend.dashboardGets]') == initial, 'Warm form performs no redundant catalog/dashboard scans'
        page.locator('#br-segment-name').fill('Кухни')
        page.evaluate("backend.holdMethods=['createSegment','getSegmentsDashboard']")
        page.locator('#br-segment-submit').click()
        held('createSegment')
        assert page.locator('#br-segment-submit').is_disabled()
        assert 'Сохраняем' in page.locator('#br-segment-submit').inner_text()
        # A second programmatic submit must not send a second mutation.
        page.locator('#br-segment-form').evaluate("form=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))")
        assert page.evaluate("backend.calls.filter(item=>item.name==='createSegment').length") == 1
        release('createSegment')
        page.wait_for_selector('#br-segment-panel', state='hidden')
        assert 'Сегмент создан' in page.locator('#br-notice').inner_text()
        assert page.locator('#br-notice a').get_attribute('href').endswith('/created-segment-1')
        assert page.locator('[data-segment="created-segment-1"]').is_visible()
        assert page.locator('[data-segment="created-segment-1"] .br-segment-sheet-links a').first.get_attribute('href').endswith('/created-segment-1-companies/edit')
        held('getSegmentsDashboard')
        assert 'Сегмент создан' in page.locator('#br-notice').inner_text(), 'Acknowledgement remains visible while analytics is held'
        # A background read permits opening and typing in the next cached form.
        page.locator('#br-add-segment').click()
        page.locator('#br-segment-name').fill('Следующий сегмент')
        assert page.locator('#br-segment-panel').is_visible()
        assert page.locator('#br-segment-name').input_value() == 'Следующий сегмент'
        # Navigation renders cached sections while the existing RPC remains serialized.
        source_gets = page.evaluate('backend.sourceGets')
        page.locator('#br-view-sources').click()
        assert page.locator('[data-source-id="source-companies"]').is_visible()
        assert page.evaluate('backend.sourceGets') == source_gets
        page.locator('#br-view-segments').click()
        assert page.locator('[data-segment="created-segment-1"]').is_visible()
        page.evaluate('backend.holdMethods=[]')
        release('getSegmentsDashboard')
        idle()
        assert page.locator('#br-segment-name').input_value() == 'Следующий сегмент'
        page.locator('#br-segment-close').click()
        assert page.evaluate('backend.maxActive') == 1

        # Every mailing entry needs actual data for that segment, even within the cache window.
        page.locator('[data-segment="existing-segment"] .br-link-button').click()
        page.wait_for_selector('.br-mailing-service')
        first_mailings = page.evaluate("backend.calls.filter(item=>item.name==='getSegmentMailings').length")
        page.locator('#br-mailings-back').click()
        page.locator('[data-segment="empty-segment"] .br-link-button').click()
        page.wait_for_selector('.br-mailing-service')
        assert 'Пустой сегмент' in page.locator('#br-mailings-title').inner_text()
        assert page.evaluate("backend.calls.filter(item=>item.name==='getSegmentMailings').length") == first_mailings + 1

        # An unwarmed segment form loads missing sources once without preventing typing.
        # Startup source read is held, but navigation and the empty-segment form remain usable.
        page.goto('about:blank')
        page.set_content(HTML.replace("window.backend={holdMethods:[]", "window.backend={holdMethods:['getSourceBases']"))
        held('getSourceBases')
        page.locator('#br-view-segments').click()
        page.locator('#br-add-segment').click()
        page.locator('#br-segment-name').fill('Холодный старт')
        assert page.locator('#br-segment-name').is_enabled()
        assert page.locator('#br-segment-submit').is_disabled()
        release('getSourceBases')
        page.wait_for_function("!document.getElementById('br-segment-submit').disabled")
        assert page.locator('[data-choose-source="source-companies"]').is_enabled()
        assert page.locator('#br-segment-name').input_value() == 'Холодный старт'
        assert page.evaluate('backend.sourceGets') == 1
        assert page.evaluate('backend.maxActive') == 1

        # The catalog entry point fetches previously missing segment destinations,
        # then selects the requested ready source for automatic normalization.
        reset()
        page.evaluate("backend.holdMethods=['getSegmentsDashboard']")
        page.locator('[data-source-id="source-companies"] [data-add-source]').click()
        held('getSegmentsDashboard')
        page.locator('#br-segment-name').fill('Из реестра')
        assert page.locator('#br-segment-name').is_enabled()
        page.evaluate('backend.holdMethods=[]')
        release('getSegmentsDashboard')
        page.wait_for_function("document.querySelector('[data-choose-source=\"source-companies\"]').checked")
        assert page.locator('#br-segment-target option[value="existing-segment"]').count() == 1
        assert page.locator('#br-segment-name').input_value() == 'Из реестра'
        assert page.evaluate('backend.sourceGets') == 1
        assert page.evaluate('backend.maxActive') == 1

        # Cached readiness never bypasses the server's fresh preview check.
        # Empty segment creation is acknowledged separately from loading data.
        reset()
        segments()
        page.locator('#br-add-segment').click()
        page.locator('#br-segment-name').fill('Проверка готовности')
        page.locator('[data-choose-source="source-companies"]').check()
        page.evaluate("backend.sources[0].status='collection';backend.sources[0].canAddToSegment=false")
        page.locator('#br-segment-submit').click()
        page.wait_for_function("document.getElementById('br-segment-error').textContent.includes('База уже не готова')")
        assert page.locator('#br-segment-panel').is_visible()
        assert page.locator('#br-segment-name').input_value() == 'Проверка готовности'
        assert page.evaluate('backend.segmentCount') == 1
        assert page.evaluate('backend.normalizedImports') == 0
        page.evaluate("backend.sources[0].status='ready';backend.sources[0].canAddToSegment=true")
        page.locator('#br-segment-submit').click()
        page.wait_for_selector('#br-segment-normalized-preview:not([hidden])')
        assert page.evaluate('backend.normalizedImports') == 0
        assert 'ЛПР без контактов' in page.locator('#br-segment-preview-counts').inner_text()
        assert 'Спорная компания' in page.locator('#br-segment-preview-review').inner_text()
        assert page.locator('#br-segment-name').is_disabled()
        page.evaluate('backend.failNormalizedAfterCommit=true')
        page.locator('#br-segment-submit').click()
        page.wait_for_function("document.getElementById('br-segment-error').textContent.includes('Ответ потерялся')")
        first_id = page.evaluate("backend.calls.filter(item=>item.name==='importSegmentRecords').at(-1).p.requestId")
        page.locator('#br-segment-submit').click()
        page.wait_for_selector('#br-segment-panel', state='hidden')
        assert page.evaluate('backend.normalizedImports') == 1
        assert page.evaluate('backend.segmentCount') == 1
        assert page.evaluate("backend.calls.filter(item=>item.name==='importSegmentRecords').at(-1).p.requestId") == first_id

        # A failed post-save read must not turn acknowledged creation into a form error.
        reset()
        segments()
        page.locator('#br-add-segment').click()
        page.locator('#br-segment-name').fill('Без потери результата')
        page.evaluate('backend.failDashboard=true')
        page.locator('#br-segment-submit').click()
        page.wait_for_selector('#br-segment-panel', state='hidden')
        page.wait_for_function("document.getElementById('br-segments-health').textContent.includes('Аналитика временно недоступна')")
        assert 'Сегмент создан' in page.locator('#br-notice').inner_text()
        assert page.locator('[data-segment="created-segment-1"]').is_visible()
        page.locator('#br-refresh').click()
        page.wait_for_function("!document.getElementById('br-segments-health').textContent.includes('Аналитика временно недоступна')")

        # Link import acknowledgement also does not await the catalog scan.
        reset()
        page.locator('#br-import-open').click()
        page.locator('#br-import-mode-link').click()
        page.locator('#br-link-name').fill('Импорт без ожидания')
        page.locator('#br-link-url').fill('https://docs.google.com/spreadsheets/d/source_123456/edit')
        page.evaluate("backend.holdMethods=['getSourceBases']")
        page.locator('#br-link-submit').click()
        page.wait_for_function("document.querySelectorAll('#br-prepared-tabs button').length===3")
        idle()
        assert page.evaluate('backend.importCount') == 0
        page.locator('#br-prepared-confirm').click()
        page.wait_for_selector('#br-import-panel', state='hidden')
        assert 'Таблица создана' in page.locator('#br-notice').inner_text()
        assert page.locator('[data-source-id="prepared-source-1"]').is_visible()
        held('getSourceBases')
        page.locator('#br-import-open').click()
        page.locator('#br-link-name').fill('Следующая база')
        assert page.locator('#br-link-name').is_enabled()
        page.evaluate('backend.holdMethods=[]')
        release('getSourceBases')
        idle()
        assert page.locator('#br-link-name').input_value() == 'Следующая база'
        assert page.evaluate('backend.maxActive') == 1

        # Access revocation clears deferred work and prevents a keyed retry.
        page.locator('#br-import-cancel').click()
        page.evaluate('backend.revoked=true')
        page.locator('#br-refresh').click()
        page.wait_for_function("document.getElementById('bases-registry-app').dataset.access==='locked'")
        calls = page.evaluate('backend.calls.length')
        page.evaluate('tick(120000)')
        assert page.evaluate('backend.calls.length') == calls
        assert page.locator('#br-segment-panel').is_hidden()
        assert not errors, errors
        browser.close()
        print('PASS: cached forms/navigation, held RPC acknowledgement, no duplicate mutation, cold data, readiness/recovery, sync failure, import and revocation; max RPC concurrency 1')


if __name__ == '__main__':
    main()
