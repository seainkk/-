"""Normalized segment and computer-file replenishment. Local fakes only."""
import sys
sys.dont_write_bytecode = True
from playwright.sync_api import sync_playwright
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
        assert page.evaluate('backend.maxActive')==1
        assert not errors,errors
        print('PASS: ready-only automatic segment preview, explicit confirmation, LPR-without-contacts preview, computer file→Ready Registry→same segment, serialized RPC.')
        browser.close()


if __name__=='__main__':
    main()
