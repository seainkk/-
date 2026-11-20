"""Normalized segment and computer-file replenishment. Local fakes only."""
import sys
sys.dont_write_bytecode = True
from playwright.sync_api import expect, sync_playwright
from performance_client import HTML


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
        page = browser.new_page(viewport={'width': 1440, 'height': 1100})
        errors=[]
        page.on('pageerror',lambda error:errors.append(str(error)))
        page.set_content(HTML)
        page.wait_for_selector('[data-source-id="source-companies"]')
        page.wait_for_function('backend.active===0')
        page.evaluate("backend.segments.push(makeSegment('web-studios','Веб-студии','no_contacts','partners'))")
        page.locator('#br-view-segments').click()
        page.wait_for_selector('[data-segment="existing-segment"]')
        page.wait_for_function('backend.active===0')
        page.locator('[data-segment="existing-segment"] button').filter(has_text='Пополнить базы').click()
        assert page.locator('#br-segment-editor-title').inner_text()=='Пополнить базы сегмента'
        assert page.locator('[data-choose-source="source-draft"]').count()==0
        page.locator('[data-choose-source="source-mixed"]').check()
        assert page.locator('#br-segment-source-options select').count()==0
        page.locator('#br-segment-submit').click()
        page.wait_for_selector('#br-segment-normalized-preview:not([hidden])')
        assert page.evaluate('backend.normalizedImports')==0
        assert page.locator('#br-segment-submit').inner_text()=='Подтвердить пополнение'
        assert 'ЛПР без контактов' in page.locator('#br-segment-preview-counts').inner_text()
        assert 'Спорная компания' in page.locator('#br-segment-preview-review').inner_text()
        assert page.evaluate("backend.calls.filter(c=>c.name==='previewSegmentRecords').at(-1).p.sourceIds")==['source-mixed']
        page.locator('#br-segment-submit').click()
        page.wait_for_selector('#br-segment-panel',state='hidden')
        page.wait_for_function('backend.active===0')
        assert page.evaluate('backend.normalizedImports')==1
        assert page.evaluate('backend.segmentCount')==0

        # A computer file is first a reviewed Ready Registry source. Its receipt
        # returns to the same segment, then asks for normalization confirmation.
        page.locator('[data-segment="existing-segment"] button').filter(has_text='Пополнить базы').click()
        page.locator('#br-segment-upload').click()
        assert page.locator('#br-import-panel').is_visible()
        assert page.locator('#br-upload-status').input_value()=='ready'
        page.locator('#br-upload-name').fill('Новая смешанная база')
        page.locator('#br-upload-file').set_input_files({'name':'new-companies.csv','mimeType':'text/csv','buffer':b'Company,Email\nTest,new@example.test'})
        page.locator('#br-upload-submit').click()
        page.wait_for_selector('#br-prepared-preview:not([hidden])')
        page.wait_for_function('backend.active===0')
        page.locator('#br-prepared-recalculate').click()
        page.wait_for_function("!document.getElementById('br-prepared-confirm').disabled")
        assert 'Статус: Готова' in page.locator('#br-prepared-identity-note').inner_text()
        assert page.evaluate('backend.normalizedImports')==1
        page.locator('#br-prepared-confirm').click()
        page.wait_for_selector('#br-segment-panel:not([hidden])')
        page.wait_for_function('backend.active===0')
        assert page.locator('[data-choose-source="prepared-source-1"]').is_checked()
        assert page.locator('#br-segment-name').input_value()=='Существующий сегмент'
        assert page.evaluate('backend.sources.find(s=>s.id==="prepared-source-1").status')=='ready'
        assert page.evaluate('backend.normalizedImports')==1
        assert page.evaluate('backend.dispatches.at(-1).keyDisabled') is False
        assert page.evaluate('backend.dispatches.at(-1).disabledFieldsets')==0
        page.locator('#br-segment-submit').click()
        page.wait_for_selector('#br-segment-normalized-preview:not([hidden])')
        page.locator('#br-segment-submit').click()
        page.wait_for_selector('#br-segment-panel',state='hidden')
        page.wait_for_function('backend.active===0')
        assert page.evaluate('backend.normalizedImports')==2
        assert page.evaluate('backend.segmentCount')==0

        # Categories filter the cached list and drive segment metadata only.
        partners = page.locator('#br-segment-category-partners')
        clients = page.locator('#br-segment-category-clients')
        category = page.locator('#br-segment-category')
        segment_rows = page.locator('#br-segments-rows [data-segment]')
        expect(clients).to_have_attribute('aria-pressed', 'true')
        expect(segment_rows).to_have_count(2)
        expect(page.locator('[data-segment="web-studios"]')).to_be_hidden()

        dashboard_gets = page.evaluate('backend.dashboardGets')
        partners.click()
        expect(partners).to_have_attribute('aria-pressed', 'true')
        expect(segment_rows).to_have_count(1)
        expect(page.locator('[data-segment="web-studios"]')).to_contain_text('Веб-студии')
        expect(page.locator('[data-segment="existing-segment"]')).to_be_hidden()
        assert page.evaluate('backend.dashboardGets') == dashboard_gets

        page.locator('#br-add-segment').click()
        expect(category).to_have_value('partners')
        page.locator('#br-segment-name').fill('Новый партнёрский сегмент')
        page.locator('#br-segment-submit').click()
        expect(page.locator('#br-segment-panel')).to_be_hidden()
        created = page.locator('[data-segment="created-segment-1"]')
        expect(created).to_be_visible()
        assert page.evaluate("backend.calls.find(c=>c.name==='createSegment').p.category") == 'partners'

        edit = created.get_by_role('button', name='Редактировать сегмент')
        edit.click()
        expect(category).to_have_value('partners')
        category.select_option('clients')
        calls_before_move = page.evaluate('backend.calls.length')
        page.locator('#br-segment-submit').click()
        expect(page.locator('#br-segment-panel')).to_be_hidden()
        page.wait_for_function('backend.active === 0')
        assert page.evaluate("""
            start => backend.calls.slice(start).every(call =>
                ['updateSegment', 'getSegmentsDashboard'].includes(call.name))
        """, calls_before_move), 'Recategorizing a segment must not access its workbooks'
        assert page.evaluate("""
            (() => {
                const {p} = backend.calls.find(c => c.name === 'updateSegment');
                return p.category === 'clients' && p.expectedCategory === 'partners' &&
                    !('name' in p) && (p.loads ?? []).length === 0;
            })()
        """)
        partners.click()
        expect(created).to_be_hidden()
        clients.click()
        expect(created).to_be_visible()

        edit.click()
        expect(category).to_have_value('clients')
        page.locator('#br-segment-name').fill('Переименованный клиентский сегмент')
        page.locator('#br-segment-submit').click()
        expect(page.locator('#br-segment-panel')).to_be_hidden()
        expect(created).to_contain_text('Переименованный клиентский сегмент')
        assert page.evaluate("""
            (() => {
                const {p} = backend.calls.filter(c => c.name === 'updateSegment').at(-1);
                return !('category' in p) && !('expectedCategory' in p);
            })()
        """), 'Renaming must not overwrite category'

        partners.click()
        page.locator('#br-add-segment').click()
        page.locator('#br-segment-name').fill('Клиентский сегмент с новым файлом')
        category.select_option('clients')
        page.locator('#br-segment-upload').click()
        page.locator('#br-upload-name').fill('Исходник для нового сегмента')
        page.locator('#br-upload-file').set_input_files({
            'name': 'client-companies.csv', 'mimeType': 'text/csv',
            'buffer': b'Company,Email\nTest,client@example.test'
        })
        page.locator('#br-upload-submit').click()
        expect(page.locator('#br-prepared-preview')).to_be_visible()
        page.locator('#br-prepared-recalculate').click()
        page.locator('#br-prepared-confirm').click()
        expect(page.locator('#br-segment-panel')).to_be_visible()
        expect(page.locator('#br-segment-name')).to_have_value('Клиентский сегмент с новым файлом')
        expect(category).to_have_value('clients')
        expect(page.locator('[data-choose-source="prepared-source-2"]')).to_be_checked()
        page.locator('#br-segment-close').click()

        assert page.evaluate('backend.maxActiveReads <= 2 && backend.maxActiveWrites <= 1')
        assert not errors,errors
        print('PASS: segment categories, metadata-only moves, ready-only preview, explicit replenishment confirmation and computer-file import.')
        browser.close()


if __name__=='__main__':
    main()
