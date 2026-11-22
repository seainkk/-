"""Held-request navigation regressions. Local fakes only; no provider calls."""
import sys
sys.dont_write_bytecode = True

from playwright.sync_api import expect, sync_playwright
from performance_client import FIXTURE, HTML, ROOT


def check_browser_history(browser):
    """Exercise the real entry and client on isolated, locally fulfilled origins."""
    context = browser.new_context()
    start = 'https://start.example.test/'
    entry = 'https://seainkk.github.io/-/#access_key=' + 'A' * 43
    shell = (ROOT / 'entry/index.html').read_text(encoding='utf-8')

    def serve(route):
        url = route.request.url
        if url.startswith(start):
            body = '<a href="' + entry + '">Открыть</a>'
        elif url.startswith('https://seainkk.github.io/-/'):
            body = shell
        elif url.startswith('https://script.google.com/macros/s/'):
            body = HTML
        else:
            route.abort()
            return
        route.fulfill(status=200, content_type='text/html; charset=utf-8', body=body)

    context.route('**/*', serve)
    host = context.new_page()
    try:
        host.goto(start)
        host.get_by_role('link', name='Открыть').click()
        expect(host.locator('body')).to_have_attribute('data-state', 'ready')
        app = host.frame_locator('#entry-frame-host iframe')
        app.locator('#br-view-segments').click()
        row = app.locator('[data-segment="existing-segment"]')
        row.get_by_role('button', name='Пополнить базы').click()
        host.wait_for_function('history.state?.basesRegistryBack===true')
        host.go_back(wait_until='commit')
        expect(app.locator('#br-segment-panel')).to_be_hidden()
        expect(row).to_be_visible()
        host.wait_for_function('history.state?.basesRegistryBack===true')
        host.go_back(wait_until='commit')
        expect(app.locator('#br-sources-view')).to_be_visible()
        expect(app.locator('#br-action-back')).to_be_hidden()
        assert host.url == entry
        host.go_back(wait_until='commit')
        expect(host).to_have_url(start)
    finally:
        context.close()


def main():
    with sync_playwright() as playwright:
        launch = {'channel':'chrome'} if sys.platform == 'win32' else {'executable_path':'/usr/bin/chromium'}
        browser = playwright.chromium.launch(**launch, headless=True, args=['--no-sandbox'])
        page = browser.new_page(viewport={'width': 1440, 'height': 1000})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))

        def reset(boot=''):
            html = HTML.replace('<script>' + FIXTURE + '</script>', '<script>' + FIXTURE + boot + '</script>')
            page.goto('about:blank')
            page.set_content(html)
            page.wait_for_selector('#bases-registry-app[data-access="ready"]')

        def idle():
            page.wait_for_function('backend.active===0')

        def held(tag):
            page.wait_for_function('(tag)=>backend.pending.some(item=>item.tag===tag||item.method===tag)', arg=tag)

        def release(tag):
            page.evaluate('(tag)=>releaseRpc(tag)', tag)

        def calls(name):
            return page.evaluate('(name)=>backend.calls.filter(call=>call.name===name)', name)

        def concurrency():
            assert page.evaluate('backend.maxActiveReads <= 2'), 'At most two read RPCs may overlap'
            assert page.evaluate('backend.maxActiveWrites <= 1'), 'Mutations stay serial'
            assert page.evaluate('backend.counterSnapshots.every(item=>item.active>=0&&item.reads>=0&&item.writes>=0&&item.active===item.reads+item.writes)')

        reset()
        add = page.locator('[data-add-source="source-companies"]')
        back = page.locator('#br-action-back')
        panel = page.locator('#br-segment-panel')
        selected = page.locator('[data-choose-source="source-companies"]')
        expect(add).to_be_visible()
        idle()
        expect(back).to_be_hidden()
        page.evaluate("backend.holdMethods=['getSegmentsDashboard']")
        add.click()
        held('getSegmentsDashboard')
        expect(back).to_be_enabled()
        page.keyboard.press('Escape')
        expect(panel).to_be_hidden()
        expect(add).to_be_focused()
        page.evaluate('backend.holdMethods=[]')
        release('getSegmentsDashboard')
        idle()
        expect(panel).to_be_hidden()
        expect(back).to_be_hidden()

        # Back returns to the previous step with the same chosen source and target.
        add.click()
        expect(selected).to_be_checked()
        page.locator('#br-segment-target').select_option('existing-segment')
        page.locator('#br-segment-submit').click()
        preview = page.locator('#br-segment-normalized-preview')
        expect(preview).to_be_visible()
        back.click()
        expect(preview).to_be_hidden()
        expect(selected).to_be_checked()
        expect(page.locator('#br-segment-target')).to_have_value('existing-segment')
        expect(page.locator('#br-segment-submit')).to_be_focused()
        page.locator('#br-segment-upload').click()
        expect(page.locator('#br-import-panel')).to_be_visible()
        back.click()
        expect(page.locator('#br-import-panel')).to_be_hidden()
        expect(panel).to_be_visible()
        expect(selected).to_be_checked()
        expect(page.locator('#br-segment-target')).to_have_value('existing-segment')
        back.click()
        expect(panel).to_be_hidden()
        expect(add).to_be_focused()
        expect(back).to_be_hidden()
        assert not calls('createSegment') and not calls('updateSegment') and not calls('importSegmentRecords')

        add.click()
        page.locator('#br-segment-target').select_option('existing-segment')
        page.locator('#br-segment-submit').click()
        expect(preview).to_be_visible()
        page.evaluate("backend.holdMethods=['importSegmentRecords'];backend.failNormalizedAfterCommit=true")
        page.locator('#br-segment-submit').click()
        held('importSegmentRecords')
        back.click()
        expect(panel).to_be_hidden()
        page.evaluate('backend.holdMethods=[]')
        release('importSegmentRecords')
        resume = page.locator('#br-segment-resume')
        expect(resume).to_be_visible()
        expect(add).to_be_focused()
        resume.click()
        expect(preview).to_be_visible()
        page.locator('#br-segment-submit').click()
        expect(panel).to_be_hidden()
        mutations = calls('importSegmentRecords')
        assert len(mutations) == 2 and mutations[0]['p'] == mutations[1]['p']
        assert page.evaluate('backend.normalizedImports') == 1

        # A slow catalog read must not hold the public settings panel hostage.
        reset("backend.holdMethods=['getSourceBases'];")
        held('getSourceBases')
        page.locator('#br-settings-open').click()
        page.locator('#br-provider-open').click()
        expect(page.locator('#br-provider-dialog')).to_be_visible()
        page.wait_for_function("backend.calls.some(call=>call.name==='getPromouserSettings')")
        expect(page.locator('#br-provider-save')).to_be_enabled()
        assert page.evaluate('backend.pending.some(item=>item.method==="getSourceBases")')
        assert not calls('configurePromouser')
        assert page.evaluate('backend.maxActiveReads') == 2
        concurrency()
        page.locator('#br-provider-close').click()
        page.locator('#br-settings-close').click()
        page.locator('#br-view-segments').click()
        expect(page.locator('[data-segment="existing-segment"]')).to_be_visible()
        page.evaluate("backend.segments[0].name='Сегмент второго проекта'")
        page.locator('#br-project').select_option('neosender')
        expect(page.locator('[data-segment="existing-segment"] .br-segment-row-name')).to_have_text('Сегмент второго проекта')
        assert not any(call['projectId']=='neosender' for call in calls('getSourceBases'))
        assert not any(call['projectId']=='neosender' for call in calls('listPreparedJobs'))
        page.evaluate('backend.holdMethods=[]')
        release('getSourceBases')
        page.locator('#br-view-sources').click()
        expect(page.locator('[data-source-id="source-companies"]')).to_be_visible()
        assert len([call for call in calls('getSourceBases') if call['projectId']=='neosender'])==1
        idle()

        # The lightweight segment projection provides real destinations and
        # workbook links before any business-sheet analytics have completed.
        reset("backend.holdAfterMethods=['getSegmentsDashboard:full'];")
        page.wait_for_selector('[data-source-id="source-companies"]')
        idle()
        page.locator('#br-view-segments').click()
        row = page.locator('[data-segment="existing-segment"]')
        expect(row).to_be_visible()
        held('getSegmentsDashboard:full')
        light_calls = [call for call in calls('getSegmentsDashboard') if call['p'] and call['p'].get('includeAnalysis') is False]
        assert len(light_calls) == 1
        expect(row.locator('.br-segment-status')).to_have_attribute('data-status', 'unknown')
        expect(row.locator('[data-grid-source="existing-segment-companies"]')).to_be_enabled()
        expect(row.locator('[data-grid-source="existing-segment-lpr"]')).to_be_enabled()
        expect(row.locator('[data-edit-segment]').first).to_be_enabled()
        expect(page.locator('#br-add-segment')).to_be_enabled()

        source_gets = len(calls('getSourceBases'))
        page.locator('#br-view-sources').click()
        expect(page.locator('[data-source-id="source-companies"]')).to_be_visible()
        assert len(calls('getSourceBases')) == source_gets, 'Warm navigation reuses the same access-scoped catalog'
        page.locator('#br-view-retarget').click()
        expect(page.locator('#br-retarget-view')).to_be_visible()
        page.locator('#br-view-segments').click()
        expect(row).to_be_visible()
        assert page.evaluate('backend.pending.some(item=>item.tag==="getSegmentsDashboard:full")')

        # An already running analytics read cannot block the next explicit
        # mutation. Duplicate submits remain one exact operation.
        page.locator('#br-add-segment').click()
        page.locator('#br-segment-name').fill('Новый сегмент после снимка')
        page.evaluate("backend.holdMethods=['createSegment']")
        page.locator('#br-segment-submit').click()
        held('createSegment')
        page.locator('#br-segment-form').evaluate('form=>form.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))')
        assert len(calls('createSegment')) == 1
        concurrency()
        page.evaluate('backend.holdMethods=[]')
        release('createSegment')
        expect(page.locator('#br-segment-panel')).to_be_hidden()
        expect(page.locator('[data-segment="created-segment-1"]')).to_be_visible()

        # The held analytics response was captured before creation. It must not
        # replace the newer local acknowledgement or refreshed metadata.
        page.evaluate('backend.holdAfterMethods=[]')
        release('getSegmentsDashboard:full')
        idle()
        expect(page.locator('[data-segment="created-segment-1"]')).to_be_visible()
        expect(page.locator('#br-notice')).to_contain_text('Сегмент создан')
        concurrency()
        assert not [call for call in page.evaluate('backend.calls') if call['name'] in [
            'startColdyValidation', 'startPhoneValidation', 'startPromouserValidation',
            'payValidationOrder', 'startColdyUpload']]

        # Failed optional analysis leaves the light catalog usable and does not
        # create a 250ms retry loop. Explicit refresh is the recovery action.
        reset("backend.failFullDashboardAlways=true;backend.fullSegments=clone(backend.segments);backend.fullSegments[0].companiesInWork=12;")
        page.wait_for_selector('[data-source-id="source-companies"]')
        idle()
        page.locator('#br-view-segments').click()
        expect(page.locator('[data-segment="existing-segment"]')).to_be_visible()
        page.wait_for_function('(backend.dashboardFullGets||0)===1 && backend.active===0')
        expect(page.locator('#br-segments-health')).to_contain_text('Аналитика временно недоступна')
        page.wait_for_timeout(800)
        assert page.evaluate('backend.dashboardFullGets') == 1
        expect(page.locator('#br-add-segment')).to_be_enabled()
        page.evaluate('backend.failFullDashboardAlways=false')
        page.locator('#br-refresh').click()
        expect(page.locator('[data-segment="existing-segment"] .br-segment-row-metrics dd').nth(3)).to_have_text('12')
        idle()
        concurrency()

        # A response for a mailing screen the user has left cannot strand the
        # next segment's screen. Its pending destination still gets one read.
        reset()
        page.wait_for_selector('[data-source-id="source-companies"]')
        idle()
        page.locator('#br-view-segments').click()
        page.wait_for_selector('[data-segment="existing-segment"]')
        page.evaluate("backend.holdAfterMethods=['getSegmentMailings']")
        page.locator('[data-segment="existing-segment"] .br-link-button').click()
        held('getSegmentMailings')
        page.locator('#br-mailings-back').click()
        page.locator('[data-segment="empty-segment"] .br-link-button').click()
        expect(page.locator('#br-mailings-title')).to_contain_text('Пустой сегмент')
        page.evaluate('backend.holdAfterMethods=[]')
        release('getSegmentMailings')
        page.wait_for_function("backend.calls.some(call=>call.name==='getSegmentMailings'&&call.p.segmentId==='empty-segment')")
        idle()
        assert [call['p']['segmentId'] for call in calls('getSegmentMailings')] == ['existing-segment', 'empty-segment']
        expect(page.locator('#br-mailings-title')).to_contain_text('Пустой сегмент')
        concurrency()

        # A key change locks the screen immediately, even if a previously
        # authorized response is still in flight. That late snapshot stays hidden.
        reset("backend.holdAfterMethods=['getSourceBases'];")
        held('getSourceBases')
        page.evaluate("backend.revoked=true;backend.location.hash='access_key='+'Z'.repeat(43);backend.historyChanged({location:backend.location});")
        expect(page.locator('#bases-registry-app')).to_have_attribute('data-access', 'locked')
        assert page.locator('[data-source-id]').count() == 0
        page.evaluate('backend.holdAfterMethods=[]')
        release('getSourceBases')
        idle()
        expect(page.locator('#bases-registry-app')).to_have_attribute('data-access', 'locked')
        assert page.locator('[data-source-id]').count() == 0
        assert page.locator('[data-segment]').count() == 0
        assert page.locator('#br-provider-key').input_value() == ''
        before_retry = len(calls('getSourceBases'))
        page.evaluate("backend.revoked=false;backend.location.hash='access_key='+MOCK_KEY;backend.sources[0].name='Новая сессия: компании';")
        page.locator('#br-access-retry').click()
        expect(page.locator('#bases-registry-app')).to_have_attribute('data-access', 'ready')
        expect(page.locator('[data-source-id="source-companies"] h2')).to_have_text('Новая сессия: компании')
        idle()
        assert len(calls('getSourceBases')) == before_retry + 1

        reset("backend.holdAfterMethods=['getSegmentsDashboard:light'];")
        page.wait_for_selector('[data-source-id="source-companies"]')
        idle()
        page.locator('#br-view-segments').click()
        held('getSegmentsDashboard:light')
        page.evaluate("backend.revoked=true;backend.location.hash='access_key='+'Z'.repeat(43);backend.historyChanged({location:backend.location});")
        expect(page.locator('#bases-registry-app')).to_have_attribute('data-access', 'locked')
        page.evaluate('backend.holdAfterMethods=[]')
        release('getSegmentsDashboard:light')
        idle()
        assert page.locator('[data-segment]').count() == 0
        assert page.locator('[data-source-id]').count() == 0
        page.evaluate("backend.revoked=false;backend.location.hash='access_key='+MOCK_KEY;backend.segments[0].name='Новая сессия: сегмент';")
        page.locator('#br-access-retry').click()
        expect(page.locator('#bases-registry-app')).to_have_attribute('data-access', 'ready')
        page.locator('#br-view-sources').click()
        page.wait_for_selector('[data-source-id="source-companies"]')
        page.locator('#br-view-segments').click()
        expect(page.locator('[data-segment="existing-segment"] .br-segment-row-name')).to_have_text('Новая сессия: сегмент')
        idle()
        concurrency()
        assert page.evaluate('backend.active===0&&backend.activeReads===0&&backend.activeWrites===0')

        # A location callback captures the fragment when requested. If that
        # fragment changes before delivery, the old startup cannot send its key.
        boot = "backend.holdLocation=true;backend.location.hash='access_key='+'Z'.repeat(43);"
        html = HTML.replace('<script>' + FIXTURE + '</script>', '<script>' + FIXTURE + boot + '</script>')
        page.goto('about:blank')
        page.set_content(html)
        page.wait_for_function('backend.pendingLocations.length===1')
        assert not calls('getAppBootstrap')
        page.evaluate("backend.location.hash='access_key='+MOCK_KEY;backend.sources[0].name='Только новая область';backend.historyChanged({location:backend.location});")
        expect(page.locator('#bases-registry-app')).to_have_attribute('data-access', 'locked')
        assert page.locator('[data-source-id]').count() == 0
        assert page.evaluate("backend.pendingLocations[0].location.hash==='access_key='+'Z'.repeat(43)")
        page.evaluate('backend.holdLocation=false;releaseLocation()')
        expect(page.locator('#bases-registry-app')).to_have_attribute('data-access', 'ready')
        expect(page.locator('[data-source-id="source-companies"] h2')).to_have_text('Только новая область')
        idle()
        assert len(calls('getAppBootstrap')) == 1
        assert len(calls('getSourceBases')) == 1
        assert page.evaluate('backend.transport.every(call=>call.keyMatches)')
        assert page.evaluate('backend.urlCalls') == 2
        assert page.evaluate('backend.active===0&&backend.activeReads===0&&backend.activeWrites===0')
        concurrency()
        assert not errors, errors
        check_browser_history(browser)
        browser.close()
        print('PASS: lightweight segment paint, warm navigation, independent settings, bounded reads, serial mutations and stale-response/key isolation.')


if __name__ == '__main__':
    main()
