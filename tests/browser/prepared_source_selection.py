"""Explicit source-sheet selection using local RPCs; no Google/user files."""
import sys
sys.dont_write_bytecode = True

from playwright.sync_api import expect, sync_playwright
from prepared_registry_client import FIXTURE, GRID_STUB, HTML


def main():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
        page = browser.new_page(viewport={'width': 1440, 'height': 1000})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))

        def reset(boot=''):
            html = HTML.replace('<script>' + FIXTURE + GRID_STUB + '</script>',
                                '<script>' + FIXTURE + GRID_STUB + boot + '</script>')
            page.goto('about:blank')
            page.set_content(html)
            page.wait_for_selector('[data-source-id="source-companies"]')
            idle()

        def idle():
            page.wait_for_function('backend.active===0')

        def calls(method):
            return page.evaluate('(method)=>backend.calls.filter(call=>call.name===method)', method)

        def held(method):
            page.wait_for_function('(method)=>backend.pending.some(call=>call.method===method)', arg=method)

        def stage():
            page.locator('#br-import-open').click()
            page.locator('#br-import-destination').select_option('catalog')
            page.locator('#br-import-mode-link').click()
            page.locator('#br-link-name').fill('Выбранные исходные листы')
            page.locator('#br-link-url').fill('https://docs.google.com/spreadsheets/d/source_123456/edit')
            page.locator('#br-link-submit').click()
            page.wait_for_selector('#br-prepared-preview:not([hidden])')
            page.wait_for_selector('[data-prepared-source]')
            idle()

        def chosen():
            return page.locator('[data-prepared-source]:checked').evaluate_all(
                'nodes=>nodes.map(node=>Number(node.dataset.preparedSource)).sort((a,b)=>a-b)')

        def recalculate():
            page.locator('#br-prepared-recalculate').click()
            idle()

        # A multi-sheet stage is cheap metadata only. Selection can be changed
        # before the first full workbook read, and starts with every source.
        reset()
        stage()
        assert chosen() == [0, 7]
        assert not calls('previewPreparedBase')
        expect(page.locator('#br-prepared-confirm')).to_be_disabled()
        page.locator('#br-prepared-sheet').select_option('7')
        idle()
        assert not calls('previewPreparedBase'), 'Choosing a sample cannot start the first full read'
        page.locator('#br-prepared-sheet').select_option('0')
        idle()
        assert not calls('previewPreparedBase')
        page.locator('[data-prepared-source="7"]').uncheck()
        idle()
        assert chosen() == [0]
        assert not calls('previewPreparedBase'), 'Checklist changes require explicit recalculation'
        assert page.locator('#br-prepared-sheet option').evaluate_all('nodes=>nodes.map(node=>node.value)') == ['0']

        page.evaluate("backend.holdMethods=['previewPreparedBase']")
        page.locator('#br-prepared-recalculate').click()
        held('previewPreparedBase')
        for control in page.locator('[data-prepared-source]').all():
            expect(control).to_be_disabled()
        expect(page.locator('#br-prepared-confirm')).to_be_disabled()
        page.evaluate("backend.holdMethods=[];releaseRpc('previewPreparedBase')")
        expect(page.locator('#br-prepared-confirm')).to_be_enabled()
        idle()
        assert calls('previewPreparedBase')[-1]['p']['sourceSheetIds'] == [0]
        expect(page.locator('#br-prepared-source-summary')).to_contain_text('3')
        assert page.locator('#br-prepared-tabs button').count() == 3
        assert page.evaluate('backend.importCount') == 0
        assert not calls('confirmPreparedBase')

        # Removing the last source invalidates the displayed snapshot. Empty
        # selections cannot request a read or create a final workbook.
        before = len(calls('previewPreparedBase'))
        page.locator('[data-prepared-source="0"]').uncheck()
        expect(page.locator('#br-prepared-confirm')).to_be_disabled()
        expect(page.locator('#br-prepared-recalculate')).to_be_disabled()
        assert page.locator('#br-prepared-sheet option').count() == 0
        expect(page.locator('#br-prepared-source-summary')).to_contain_text('лист')
        assert len(calls('previewPreparedBase')) == before
        page.locator('[data-prepared-source="7"]').check()
        assert page.locator('#br-prepared-sheet').input_value() == '7'
        recalculate()
        assert calls('previewPreparedBase')[-1]['p']['sheetId'] == 7
        assert calls('previewPreparedBase')[-1]['p']['sourceSheetIds'] == [7]

        # The sample dropdown includes only selected sources. Changing sample
        # retains the current chosen set and keeps its established auto-preview.
        page.locator('[data-prepared-source="0"]').check()
        expect(page.locator('#br-prepared-confirm')).to_be_disabled()
        recalculate()
        before = len(calls('previewPreparedBase'))
        page.locator('#br-prepared-sheet').select_option('0')
        expect(page.locator('#br-prepared-confirm')).to_be_enabled()
        idle()
        assert len(calls('previewPreparedBase')) == before + 1
        assert calls('previewPreparedBase')[-1]['p']['sourceSheetIds'] == [0, 7]

        # A response for a different selected set cannot authorize creation,
        # even when its sheetId and token look otherwise usable.
        reset("const normalSelectionPreview=api.previewPreparedBase;api.previewPreparedBase=p=>{const result=normalSelectionPreview(p);result.sourceSheetIds=[7];return result;};")
        stage()
        recalculate()
        expect(page.locator('#br-prepared-confirm')).to_be_disabled()
        assert not calls('confirmPreparedBase')
        assert page.evaluate('backend.importCount') == 0

        # Unknown creation results retain the approved token and UUID, and all
        # selection controls remain frozen until the same operation is resumed.
        reset()
        stage()
        page.locator('[data-prepared-source="7"]').uncheck()
        recalculate()
        page.evaluate('backend.failPreparedAfterCommit=true')
        page.locator('#br-prepared-confirm').click()
        page.wait_for_function("document.getElementById('br-prepared-health').textContent.includes('Ответ потерян')")
        idle()
        first = calls('confirmPreparedBase')[-1]['p']
        assert sorted(first) == ['draftId', 'previewToken', 'requestId', 'sheetId']
        for control in page.locator('[data-prepared-source]').all():
            expect(control).to_be_disabled()
        expect(page.locator('#br-prepared-recalculate')).to_be_hidden()
        page.locator('#br-prepared-confirm').click()
        page.wait_for_selector('#br-import-panel', state='hidden')
        idle()
        assert calls('confirmPreparedBase')[-1]['p'] == first
        assert page.evaluate('backend.importCount') == 1
        assert page.evaluate('backend.worksheets["prepared-source-1"].length') == 3

        # A single-sheet import retains its fast automatic initial preview.
        reset("backend.preparedSourceSheets=[{id:7,name:'Один исходный лист',rows:3,columns:4}];")
        stage()
        expect(page.locator('#br-prepared-confirm')).to_be_enabled()
        assert len(calls('previewPreparedBase')) == 1
        assert calls('previewPreparedBase')[-1]['p']['sourceSheetIds'] == [7]

        # Source names render as text, and revocation scrubs both metadata and
        # preview contents before a delayed result can become visible.
        reset("backend.preparedSourceSheets=[{id:0,name:'<img src=x onerror=window.bad=1>',rows:3,columns:4},{id:7,name:'ЛПР',rows:2,columns:4}];")
        stage()
        assert page.locator('#br-prepared-sources img').count() == 0
        assert page.evaluate('window.bad') is None
        page.evaluate("backend.holdMethods=['previewPreparedBase']")
        page.locator('#br-prepared-recalculate').click()
        held('previewPreparedBase')
        page.evaluate("backend.revoked=true;releaseRpc('previewPreparedBase')")
        page.wait_for_selector('#bases-registry-app[data-access="locked"]')
        idle()
        assert page.locator('[data-prepared-source]').count() == 0
        assert page.locator('#br-prepared-source-summary').inner_text() == ''
        assert page.locator('#br-prepared-table').inner_text() == ''

        reset("const normalSelectionSources=api.getSourceBases;api.getSourceBases=()=>({...normalSelectionSources(),canEdit:false});")
        expect(page.locator('#br-import-open')).to_be_disabled()
        assert not calls('stagePreparedBaseLink')
        assert not calls('previewPreparedBase')
        assert not calls('confirmPreparedBase')
        assert not errors, errors
        browser.close()
        print('PASS: source checklist, explicit reads, selected samples, empty/stale selection, exact confirm retry, single-sheet compatibility and revocation.')


if __name__ == '__main__':
    main()
