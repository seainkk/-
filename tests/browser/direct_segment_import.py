"""Direct uploads from the registry to segment workbooks, using local RPC fakes."""
import json
import sys

from performance_client import expand_segment_actions
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
            page.locator('#br-import-mode-file').click()
            page.locator('#br-upload-companies').check()
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
        expand_segment_actions(page.locator('[data-segment="existing-segment"]'))
        page.locator('[data-segment="existing-segment"]').get_by_role('button', name='Добавить контакты').click()
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
        # Paste a mixed workbook from the segment card and approve both routes once.
        open_form(from_segments=True)
        page.locator('#br-import-cancel').click()
        expand_segment_actions(page.locator('[data-segment="existing-segment"]'))
        page.locator('[data-segment="existing-segment"]').get_by_role('button', name='Добавить контакты').click()
        expect(destination).to_have_value('existing-segment')
        expect(page.locator('#br-link-auto')).to_be_checked()
        page.evaluate('''backend.preparedSourceSheets = [
            {id:0,name:'Компании',section:'companies',rows:3,columns:17},
            {id:7,name:'ЛПР',section:'lpr',rows:2,columns:25}
        ]''')
        page.locator('#br-link-url').fill('https://docs.google.com/spreadsheets/d/outside_123456/edit')
        page.evaluate('backend.outsideLink = true')
        page.locator('#br-link-submit').click()
        error = page.locator('#br-import-message')
        expect(error).to_contain_text('Таблица находится вне реестра')
        expect(error.get_by_role('link')).to_have_attribute('href', 'https://drive.google.com/drive/folders/source-folder')
        assert not calls('confirmPreparedBase') and not calls('importSegmentRecords')
        page.evaluate('backend.outsideLink = false')
        page.locator('#br-link-url').fill('https://docs.google.com/spreadsheets/d/registry_copy123456/edit')
        page.locator('#br-link-submit').click()
        expect(page.locator('#br-prepared-confirm')).to_be_enabled()
        expect(prepared).to_contain_text('Смешанная книга')
        expect(prepared).to_contain_text('Компании → Компании')
        expect(prepared).to_contain_text('ЛПР → ЛПР')
        expect(page.locator('#br-prepared-recalculate')).to_be_hidden()
        assert calls('previewPreparedBase')[-1]['sourceSheetIds'] == [0, 7]
        assert calls('stagePreparedBaseLink')[-1]['routeMode'] == 'auto'
        assert not calls('stagePreparedBaseLink')[-1]['name']
        assert not calls('importSegmentRecords')
        page.get_by_role('button', name='Сохранить исходник и сравнить').click()
        expect(final).to_be_visible()
        assert not calls('importSegmentRecords')
        confirm.click()
        expect(page.get_by_role('link', name='Открыть таблицу компаний')).to_be_visible()
        expect(page.get_by_role('link', name='Открыть таблицу ЛПР')).to_be_visible()
        assert calls('confirmPreparedBase')[-1]['destination']['kind'] == 'auto'
        assert calls('previewSegmentRecords')[-1]['targetKind'] == 'auto'
        assert len(calls('importSegmentRecords')) == 1
        assert page.evaluate('backend.sources.find(s => s.id === "prepared-source-1").contents') == ['companies', 'lpr']
        # File mode carries automatic routing through live HTML form serialization.
        # An uncertain company match is shown for review before writing.
        expand_segment_actions(page.locator('[data-segment="existing-segment"]'))
        page.locator('[data-segment="existing-segment"]').get_by_role('button', name='Добавить контакты').click()
        page.locator('#br-import-mode-file').click()
        expect(page.locator('#br-upload-auto')).to_be_checked()
        page.evaluate('backend.requireSegmentReview = true')
        page.locator('#br-upload-file').set_input_files({
            'name': 'Mixed.xlsx',
            'mimeType': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'buffer': b'local mock workbook',
        })
        page.locator('#br-upload-submit').click()
        expect(page.locator('#br-prepared-confirm')).to_be_enabled()
        assert calls('uploadSourceBase')[-1]['routeMode'] == 'auto'
        assert calls('uploadSourceBase')[-1]['section'] == 'companies'
        page.locator('#br-prepared-confirm').click()
        expect(final).to_be_visible()
        expect(final).to_contain_text('Спорная компания')
        assert len(calls('importSegmentRecords')) == 1
        confirm.click()
        expect(page.locator('#br-segment-panel')).to_be_hidden()
        assert len(calls('importSegmentRecords')) == 2
        # Reusing the already registered mixed source keeps its sheet routes.
        page.locator('#br-view-sources').click()
        page.get_by_role('button', name='Общий каталог').click()
        page.locator('[data-add-source="prepared-source-1"]').click()
        page.locator('#br-segment-target').select_option('existing-segment')
        page.locator('#br-segment-submit').click()
        expect(final).to_be_visible()
        plan = calls('previewSegmentRecords')[-1]
        assert plan['targetKind'] == 'auto' and plan['sourceIds'] == ['prepared-source-1']
        assert len(calls('confirmPreparedBase')) == 2  # no new source copy
        assert len(calls('importSegmentRecords')) == 2  # preview is read-only
        confirm.click()
        expect(page.locator('#br-segment-panel')).to_be_hidden()
        assert len(calls('importSegmentRecords')) == 3
        open_form()
        destination.select_option('existing-segment')
        page.locator('#br-import-mode-paste').click()
        page.locator('#br-upload-lpr').check()
        page.locator('#br-upload-paste').fill('ФИО\tЛичная почта\nИрина\tperson@example.test')
        page.locator('#br-upload-submit').click()
        expect(prepared).to_be_visible()
        assert calls('stagePreparedRows')[-1]['section'] == 'lpr'
        assert calls('stagePreparedRows')[-1]['text'].endswith('person@example.test')
        assert not calls('confirmPreparedBase') and not calls('importSegmentRecords')
        assert not errors, errors
        browser.close()
        print('PASS: manual routes, mixed link/file imports, single approval, review conflicts, folder scope, retries and cancellation')


if __name__ == '__main__':
    main()
