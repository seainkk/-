"""Read-only contact-preview browser checks with local fake RPCs.

Run: python tests/browser/contact_preview_client.py
Requires Playwright Python and Chromium. No live Google data is read or changed.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = Path(__file__).with_name('performance-fixture.js').read_text()
HTML = (ROOT / 'src/Index.html').read_text().replace("<?!= include_('Styles'); ?>", (ROOT / 'src/Styles.html').read_text()).replace("<?!= include_('Client'); ?>", '<script>' + FIXTURE + '</script>' + (ROOT / 'src/Client.html').read_text())


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
        page = browser.new_page(viewport={'width': 1440, 'height': 1100})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))

        def reset():
            page.goto('about:blank')
            page.set_content(HTML)
            page.wait_for_selector('[data-preview-source="source-companies"]')
            page.wait_for_function('backend.active===0')

        def held(method='previewSourceBaseContacts'):
            page.wait_for_function('(method)=>backend.pending.some(item=>item.method===method)', arg=method)

        def release(method='previewSourceBaseContacts'):
            page.evaluate('(method)=>releaseRpc(method)', method)

        def idle():
            page.wait_for_function('backend.active===0')

        reset()
        assert page.locator('[data-preview-source="source-csv"]').count() == 0
        assert page.locator('[data-preview-source="source-draft"]').is_enabled()
        page.locator('[data-preview-source="source-companies"]').click()
        page.wait_for_selector('#br-contact-preview-result:not([hidden])')
        assert page.locator('#br-contact-preview-metrics dd').all_text_contents() == ['10', '8', '9', '6', '1', '1']
        assert 'Без данных о компании в исходнике: 0' in page.locator('#br-contact-preview-coverage').inner_text()
        assert page.locator('#br-contact-preview-conflict-list li').count() == 2
        assert 'Всего контактов для ручной проверки: 2' in page.locator('#br-contact-preview-conflicts-note').inner_text()
        assert page.locator('#br-contact-preview-conflict-list a').first.get_attribute('href') == 'https://docs.google.com/spreadsheets/d/source-companies/edit#gid=0&range=A2'
        page.locator('#br-contact-preview-columns summary').click()
        assert 'ИНН' in page.locator('#br-contact-preview-sheet-list').inner_text()
        assert 'Email' in page.locator('#br-contact-preview-sheet-list').inner_text()
        assert page.locator('#br-contact-preview-target-rows td').all_text_contents() == ['—'] * 9
        assert 'количество новых контактов пока не определено' in page.locator('#br-contact-preview-scope').inner_text()
        page.evaluate("""()=>{const item={state:'ready',target:{state:'ready',id:'center_123456',name:'Кухни — Центр баз',url:'javascript:alert(1)'},scannedRows:12,totalSheets:1,companies:{unique:10,unresolvedRows:0,existingInTarget:2,newUnique:8},emails:{occurrences:12,unique:8,multiCompany:1,unresolved:0,existingInTarget:3,newUnique:5,newUnambiguous:4},phones:{occurrences:15,unique:9,mobiles:6,multiCompany:1,unresolved:0,existingInTarget:1,newUnique:8,newUnambiguous:7},sheets:[],warnings:[],conflicts:{total:1,truncated:false,items:[{type:'email',value:'shared@example.test',companies:[{key:'one',label:'Компания 1'},{key:'two',label:'Компания 2'}],sources:[{fileId:'center_123456',sheetId:101,sheetName:'Email',row:3}]}]}};backend.contactPreviewResults={'source-companies':item};}""")
        page.locator('#br-contact-preview-refresh').click()
        page.wait_for_function("document.getElementById('br-contact-preview-target-label').textContent.includes('Кухни — Центр баз')")
        assert page.locator('#br-contact-preview-target-rows td').all_text_contents() == ['2', '8', '—', '3', '5', '4', '1', '8', '7']
        assert page.locator('#br-contact-preview-target-label a').get_attribute('href') == 'https://docs.google.com/spreadsheets/d/center_123456/edit'
        assert page.locator('#br-contact-preview-conflict-list a').first.get_attribute('href') == 'https://docs.google.com/spreadsheets/d/center_123456/edit#gid=101&range=A3'
        assert 'Контакты ещё не перенесены' in page.locator('#br-contact-preview-scope').inner_text()
        page.evaluate("""()=>{const item=backend.contactPreviewResults['source-companies'];item.emails.multiCompanyCombined=2;item.emails.unresolvedCombined=1;item.phones.multiCompanyCombined=1;item.phones.unresolvedCombined=0;item.conflicts.totalCombined=3;item.conflicts.items[0].reason='multiple_companies';item.conflicts.items.push({type:'email',value:'second@example.test',reason:'multiple_companies',companies:[{key:'one',label:'Компания 1'},{key:'two',label:'Компания 2'}],sources:[]},{type:'email',value:'unknown@example.test',reason:'unknown_owner',companies:[],sources:[]});}""")
        page.locator('#br-contact-preview-refresh').click()
        page.wait_for_function("document.querySelectorAll('#br-contact-preview-metrics dd')[4].textContent==='2'")
        assert page.locator('#br-contact-preview-conflicts-title').inner_text() == 'Требуют ручной проверки'
        assert page.locator('.br-contact-preview-conflict-reason').all_text_contents() == ['У нескольких компаний', 'У нескольких компаний', 'Не определена компания']
        assert 'Всего контактов для ручной проверки: 3' in page.locator('#br-contact-preview-conflicts-note').inner_text()
        assert 'с учётом Центра баз: email — 1, телефонов — 0' in page.locator('#br-contact-preview-coverage').inner_text()

        # More than one page, hostile labels and incomplete coverage remain explicit.
        page.evaluate("""()=>{const current={state:'partial',scannedRows:50,totalSheets:2,companies:{unique:7,unresolvedRows:3},emails:{occurrences:60,unique:45,multiCompany:45,unresolved:2},phones:{occurrences:0,unique:0,mobiles:0,multiCompany:0,unresolved:0},sheets:[{id:0,name:'<img src=x onerror=alert(1)>',rowsScanned:50,companyColumns:[{label:'ИНН'}],emailColumns:[{label:'Почты'}],phoneColumns:[],reason:'Нужна проверка'}],warnings:['Достигнут лимит чтения'],conflicts:{total:48,truncated:true,items:Array.from({length:45},(_,i)=>({type:'email',value:'<img src=x onerror=alert(1)> '+i,companies:[{key:'one',label:'<script>alert(1)</script>'},{key:'two',label:'Компания 2'}],sources:[{sheetId:0,sheetName:'<b>Исходник</b>',row:i+2,url:'javascript:alert(1)'}]}))}};backend.contactPreviewResults={'source-companies':current};}""")
        page.locator('#br-contact-preview-refresh').click()
        page.wait_for_function("document.getElementById('br-contact-preview-health').textContent.includes('Анализ неполный')")
        assert 'Без данных о компании в исходнике: 3' in page.locator('#br-contact-preview-coverage').inner_text()
        assert page.locator('#br-contact-preview-conflict-list li').count() == 20
        assert page.locator('#br-contact-preview img').count() == 0
        assert page.locator('#br-contact-preview script').count() == 0
        assert page.locator('#br-contact-preview-conflict-list strong').first.inner_text().endswith(' 0')
        page.locator('#br-contact-preview-next').click()
        assert page.locator('#br-contact-preview-conflict-list strong').first.inner_text().endswith(' 20')
        page.locator('#br-contact-preview-next').click()
        assert page.locator('#br-contact-preview-conflict-list li').count() == 5
        assert page.locator('#br-contact-preview-next').is_disabled()
        assert 'Часть сведений о спорных связях показана не полностью' in page.locator('#br-contact-preview-conflicts-note').inner_text()
        for width in [1440, 360, 320]:
            page.set_viewport_size({'width': width, 'height': 1100})
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth'), ('overflow', width)
        page.set_viewport_size({'width': 1440, 'height': 1100})

        # Closing A and requesting B during A's read must never revive A or overlap RPCs.
        reset()
        page.evaluate("backend.holdMethods=['previewSourceBaseContacts']")
        page.locator('[data-preview-source="source-companies"]').click()
        held()
        page.locator('#br-contact-preview-close').click()
        page.locator('#br-section-lpr').click()
        page.locator('[data-preview-source="source-lpr"]').click()
        assert 'Готовая база ЛПР' in page.locator('#br-contact-preview-title').inner_text()
        assert page.locator('#br-contact-preview-result').is_hidden()
        assert len(page.evaluate("backend.calls.filter(item=>item.name==='previewSourceBaseContacts')")) == 1
        release()
        held()
        assert page.locator('#br-contact-preview-result').is_hidden()
        assert page.evaluate("backend.calls.filter(item=>item.name==='previewSourceBaseContacts').at(-1).p.id") == 'source-lpr'
        page.locator('#br-view-retarget').click()
        page.evaluate('backend.holdMethods=[]')
        release()
        idle()
        page.locator('#br-view-sources').click()
        assert 'Готовая база ЛПР' in page.locator('#br-contact-preview-title').inner_text()
        assert page.locator('#br-contact-preview-result').is_visible()
        assert page.evaluate('backend.maxActive') == 1

        # A prepared import is acknowledged before catalog refresh; optional later analysis stays separate.
        reset()
        page.locator('#br-import-open').click()
        page.locator('#br-import-mode-link').click()
        page.locator('#br-link-name').fill('Новая база')
        page.locator('#br-link-url').fill('https://docs.google.com/spreadsheets/d/source_123456/edit')
        page.evaluate("backend.holdMethods=['stagePreparedBaseLink'];backend.failContactPreview=true")
        page.locator('#br-link-submit').click()
        held('stagePreparedBaseLink')
        assert len(page.evaluate("backend.calls.filter(item=>item.name==='previewSourceBaseContacts')")) == 0
        release('stagePreparedBaseLink')
        page.wait_for_function("document.querySelectorAll('#br-prepared-tabs button').length===3")
        idle()
        page.evaluate("backend.holdMethods=['getSourceBases','previewSourceBaseContacts']")
        page.locator('#br-prepared-confirm').click()
        page.wait_for_selector('#br-import-panel', state='hidden')
        assert 'Таблица создана' in page.locator('#br-notice').inner_text()
        assert page.locator('[data-source-id="prepared-source-1"]').is_visible()
        held('getSourceBases')
        page.locator('[data-preview-source="prepared-source-1"]').click()
        release('getSourceBases')
        held()
        assert 'Таблица создана' in page.locator('#br-notice').inner_text()
        page.locator('#br-import-open').click()
        page.locator('#br-link-name').fill('Следующая база')
        assert page.locator('#br-link-name').is_enabled()
        page.evaluate('backend.holdMethods=[]')
        release()
        page.wait_for_function("document.getElementById('br-contact-preview-health').textContent.includes('Подсчёт временно недоступен')")
        assert 'Таблица создана' in page.locator('#br-notice').inner_text()
        assert page.locator('#br-import-message').is_hidden()
        page.locator('#br-import-cancel').click()
        idle()
        page.locator('#br-contact-preview-refresh').click()
        page.wait_for_selector('#br-contact-preview-result:not([hidden])')
        assert page.evaluate('backend.maxActive') == 1

        # Revoking the key while a private preview is pending clears both data and deferred work.
        page.evaluate("backend.holdMethods=['previewSourceBaseContacts']")
        page.locator('#br-contact-preview-refresh').click()
        held()
        page.evaluate('backend.revoked=true')
        release()
        page.wait_for_function("document.getElementById('bases-registry-app').dataset.access==='locked'")
        assert page.locator('#br-contact-preview').is_hidden()
        assert page.locator('#br-contact-preview-conflict-list').inner_text() == ''
        assert page.locator('#br-contact-preview-metrics').inner_text() == ''
        assert page.locator('#br-contact-preview-title').inner_text() == 'Состав базы'
        calls = page.evaluate('backend.calls.length')
        page.evaluate('tick(120000)')
        page.wait_for_timeout(400)
        assert page.evaluate('backend.calls.length') == calls
        assert not errors, errors
        browser.close()
        print('PASS: explicit prepared import and optional contact preview, separate acknowledgement/failure, sequential reads, stale result cancellation, metrics/columns/conflicts/paging, safe native links, mobile layout and revoked access')


if __name__ == '__main__':
    main()
