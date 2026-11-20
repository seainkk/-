"""Direct uploads from the registry to segment workbooks, using local RPC fakes."""
import json
import sys

from playwright.sync_api import expect, sync_playwright

from performance_client import FIXTURE, HTML


def main():
    with sync_playwright() as playwright:
        launch = {'channel': 'chrome'} if sys.platform == 'win32' else {'executable_path': '/usr/bin/chromium'}
        browser = playwright.chromium.launch(**launch, headless=True, args=['--no-sandbox'])
        page = browser.new_page(viewport={'width': 1366, 'height': 900})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        destination = page.locator('#br-import-destination')
        prepared = page.locator('#br-prepared-preview')
        final = page.locator('#br-segment-normalized-preview')
        confirm = page.locator('#br-segment-submit')

        def open_form(from_segments=False):
            page.goto('about:blank')
            page.set_content(HTML)
            expect(page.locator('[data-source-id="source-companies"]')).to_be_visible()
            if from_segments:
                page.locator('#br-view-segments').click()
                page.locator('#br-segments-import').click()
            else:
                page.locator('#br-import-open').click()
            expect(destination).to_have_value('')

        def calls(name):
            return page.evaluate('name => backend.calls.filter(c => c.name === name).map(c => c.p)', name)

        def company_file():
            page.locator('#br-upload-name').fill('Новая выборка')
            page.locator('#br-upload-file').set_input_files({
                'name': 'groups.csv', 'mimeType': 'text/csv',
                'buffer': b'Company,Person,Email\nExample,Alex,person@example.test'
            })

        def prepare():
            expect(prepared).to_be_visible()
            page.locator('#br-prepared-recalculate').click()
            page.locator('#br-prepared-confirm').click()
            expect(final).to_be_visible()
            assert not calls('importSegmentRecords')

        # A complete local file with no destination cannot be staged, even by Enter.
        open_form()
        company_file()
        page.locator('#br-import-file-form').evaluate('form => form.requestSubmit()')
        page.wait_for_function('backend.active === 0')
        assert not calls('uploadSourceBase')
        assert not calls('createSegment')
        expect(prepared).to_be_hidden()

        destination.select_option('existing-segment')
        page.locator('#br-upload-lpr').check()
        page.locator('#br-upload-submit').click()
        prepare()
        plan = calls('previewSegmentRecords')[-1]
        assert plan['segmentId'] == 'existing-segment'
        assert plan['sourceIds'] == ['prepared-source-1']
        assert plan['targetKind'] == 'lpr'
        assert not calls('createSegment')
        assert page.evaluate('backend.dispatches.at(-1).section') == 'lpr'

        # A lost acknowledgement retries the approved plan with the same request ID.
        page.evaluate('backend.failNormalizedAfterCommit = true')
        confirm.click()
        page.wait_for_function("backend.normalizedImports === 1 && backend.active === 0")
        expect(final).to_be_visible()
        confirm.click()
        expect(page.locator('#br-segment-panel')).to_be_hidden()
        writes = calls('importSegmentRecords')
        assert len(writes) == 2 and writes[0] == writes[1]
        assert writes[0]['requestId'] and writes[0]['segmentId'] == plan['segmentId']
        assert page.evaluate('backend.normalizedImports') == 1
        assert page.evaluate('backend.sources.find(s => s.id === "prepared-source-1").segments[0].id') == 'existing-segment'
        expect(page.get_by_role('link', name='Открыть таблицу ЛПР')).to_have_attribute(
            'href', 'https://docs.google.com/spreadsheets/d/existing-segment-lpr/edit')

        # The Segments entry point also offers link mode and a new destination.
        open_form(from_segments=True)
        destination.select_option('new')
        page.locator('#br-import-segment-name').fill('Новый партнёр')
        page.locator('#br-import-segment-category').select_option('partners')
        page.locator('#br-import-mode-link').click()
        page.locator('#br-link-companies').check()
        page.locator('#br-link-name').fill('Выборка компаний')
        page.locator('#br-link-url').fill('https://docs.google.com/spreadsheets/d/source_123456/edit')
        page.locator('#br-link-submit').click()
        prepare()
        created = calls('createSegment')
        assert len(created) == 1 and created[0]['name'] == 'Новый партнёр' and created[0]['category'] == 'partners'
        plan = calls('previewSegmentRecords')[-1]
        assert plan['segmentId'] == 'created-segment-1' and plan['targetKind'] == 'companies'
        assert calls('stagePreparedBaseLink')[-1]['section'] == 'companies'
        confirm.click()
        expect(page.locator('#br-segment-panel')).to_be_hidden()
        assert page.evaluate('backend.normalizedImports') == 1
        assert calls('importSegmentRecords')[0]['segmentId'] == plan['segmentId']
        expect(page.get_by_role('link', name='Открыть таблицу компаний')).to_have_attribute(
            'href', 'https://docs.google.com/spreadsheets/d/created-segment-1-companies/edit')

        # Cancelling the final preview leaves the prepared source without a segment.
        open_form()
        destination.select_option('existing-segment')
        company_file()
        page.locator('#br-upload-submit').click()
        prepare()
        page.locator('#br-segment-close').click()
        expect(page.locator('#br-segment-panel')).to_be_hidden()
        assert not calls('importSegmentRecords') and not calls('createSegment')
        assert page.evaluate('backend.sources.find(s => s.id === "prepared-source-1").segments') == []

        # Cancelling the new-segment form before staging returns to the user's list.
        open_form(from_segments=True)
        destination.select_option('new')
        page.locator('#br-import-segment-name').fill('Отменённый сегмент')
        page.locator('#br-import-cancel').click()
        expect(page.locator('#br-segments-view')).to_be_visible()
        assert not calls('uploadSourceBase') and not calls('createSegment') and not calls('importSegmentRecords')

        # The segment card sets its own destination. Hiding a confirmed preparation
        # keeps the list on screen when the background job finishes.
        page.locator('[data-segment="existing-segment"]').get_by_role('button', name='Загрузить базу').click()
        expect(destination).to_have_value('existing-segment')
        company_file()
        page.locator('#br-upload-submit').click()
        expect(prepared).to_be_visible()
        page.locator('#br-prepared-recalculate').click()
        page.evaluate("backend.processingPrepared = true; backend.holdMethods = ['continuePreparedBase']")
        page.locator('#br-prepared-confirm').click()
        page.wait_for_function("backend.pending.some(c => c.method === 'continuePreparedBase')")
        page.locator('#br-import-cancel').click()
        expect(page.locator('#br-segments-view')).to_be_visible()
        page.evaluate("backend.holdMethods=[];releaseRpc('continuePreparedBase')")
        resume = page.get_by_role('button', name='Продолжить пополнение')
        expect(resume).to_be_visible()
        assert not calls('previewSegmentRecords') and not calls('importSegmentRecords')
        resume.click()
        expect(final).to_be_visible()
        assert not calls('importSegmentRecords')

        # A confirmed multi-step preparation is recovered from the server after a reload.
        open_form()
        destination.select_option('catalog')
        expect(page.locator('#br-upload-status')).to_have_value('collection')
        page.locator('#br-upload-status').select_option('rework')
        destination.select_option('existing-segment')
        expect(page.locator('#br-upload-status')).to_have_value('ready')
        destination.select_option('catalog')
        expect(page.locator('#br-upload-status')).to_have_value('rework')
        destination.select_option('existing-segment')
        company_file()
        page.locator('#br-upload-submit').click()
        expect(prepared).to_be_visible()
        page.locator('#br-prepared-recalculate').click()
        page.evaluate("backend.processingPrepared = true; backend.holdMethods = ['continuePreparedBase']")
        page.locator('#br-prepared-confirm').click()
        page.wait_for_function("backend.pending.some(c => c.method === 'continuePreparedBase')")
        first = calls('confirmPreparedBase')[-1]
        assert first['destination']['segmentId'] == 'existing-segment' and first['destination']['kind'] == 'companies'
        saved = page.evaluate('backend.preparedDrafts')
        page.goto('about:blank')
        page.set_content(HTML.replace(FIXTURE, FIXTURE + '\nbackend.preparedDrafts = ' + json.dumps(saved) + ';'))
        page.locator('[data-resume-draft]').click()
        expect(final).to_be_visible()
        assert calls('continuePreparedBase')[-1]['requestId'] == first['requestId']
        assert not calls('confirmPreparedBase') and not calls('createSegment') and not calls('importSegmentRecords')
        plan = calls('previewSegmentRecords')[-1]
        assert plan['segmentId'] == 'existing-segment' and plan['targetKind'] == 'companies'
        confirm.click()
        expect(page.locator('#br-segment-panel')).to_be_hidden()
        assert page.evaluate('backend.normalizedImports') == 1
        assert not errors, errors
        browser.close()
        print('PASS: explicit upload target, file to existing LPR, link to new partner segment, retry and cancellation')


if __name__ == '__main__':
    main()
