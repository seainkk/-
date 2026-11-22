"""Google-Sheets-style grid checks with local RPCs only.

Run: python tests/browser/grid_client.py
Requires Python Playwright and Chromium. Does not access Google or user data.
"""
from pathlib import Path
import sys
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
HTML = (
    '<!doctype html><html lang="ru"><head><meta charset="utf-8">'
    '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + (ROOT / 'src/Styles.html').read_text(encoding='utf-8')
    + (ROOT / 'src/GridStyles.html').read_text(encoding='utf-8')
    + '</head><body><main id="bases-registry-app">'
    '<div hidden><h1 id="registry-style-title">Реестр баз</h1>'
    '<input id="registry-style-input" aria-label="Проверка стилей реестра"></div>'
    + (ROOT / 'src/GridPanel.html').read_text(encoding='utf-8')
    + '</main><script>' + Path(__file__).with_name('grid-fixture.js').read_text(encoding='utf-8')
    + '</script>' + (ROOT / 'src/GridClient.html').read_text(encoding='utf-8') + '</body></html>'
)


def main():
    with sync_playwright() as p:
        launch = {'channel':'chrome'} if sys.platform == 'win32' else {'executable_path':'/usr/bin/chromium'}
        browser = p.chromium.launch(**launch, headless=True, args=['--no-sandbox'])
        page = browser.new_page(viewport={'width': 1440, 'height': 1000})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))

        def reset(rows=240, omit_initial=False, hold_workspace=False):
            page.goto('about:blank')
            page.set_content(HTML)
            page.evaluate('options=>{gridBackend.sheets[0].rowCount=options.rows;gridBackend.omitInitialRange=options.omit_initial;gridBackend.holdMethods=options.hold_workspace?["getContactWorkspace"]:[];void openTestGrid();}',
                          {'rows': rows, 'omit_initial': omit_initial, 'hold_workspace': hold_workspace})
            page.wait_for_selector('#rg-cell-2-1')
            page.wait_for_function('gridBackend.active===0')

        def idle():
            page.wait_for_function("gridBackend.active===0 && !RegistryGrid.hasPending()")

        def edit(row, col, value, enter=True):
            page.locator(f'#rg-cell-{row}-{col}').dblclick()
            page.locator('#rg-grid-editor').fill(value)
            if enter:
                page.locator('#rg-grid-editor').press('Enter')

        def held(method):
            page.wait_for_function('(method)=>gridBackend.pending.some(item=>item.method===method)', arg=method)

        def release(method):
            page.evaluate('(method)=>releaseGridRpc(method)', method)

        def integrated_styles(width):
            # Real Index.html loads global Styles before GridStyles and nests
            # the panel in the app. The isolated editor used to miss collisions.
            actual = page.evaluate('''()=>{
                const style=id=>getComputedStyle(document.getElementById(id));
                const title=style('rg-grid-title');
                const fields=['rg-grid-address','rg-grid-formula'].map(id=>{
                    const node=document.getElementById(id), css=style(id);
                    return {height:node.getBoundingClientRect().height,
                        radius:css.borderRadius,minHeight:css.minHeight,fontSize:css.fontSize};
                });
                return {fontSize:title.fontSize,fontWeight:title.fontWeight,
                    letterSpacing:title.letterSpacing,fields,
                    formulaBar:document.querySelector('.rg-grid-formula-bar').getBoundingClientRect().height,
                    registryTitle:style('registry-style-title').fontSize,
                    registryRadius:style('registry-style-input').borderRadius,
                    registryMinHeight:style('registry-style-input').minHeight};
            }''')
            assert actual['fontSize'] == ('15px' if width <= 600 else '18px'), actual
            assert actual['fontWeight'] == '400', actual
            assert actual['letterSpacing'] == 'normal', actual
            assert actual['formulaBar'] == 33, actual
            for field in actual['fields']:
                assert field == {'height': 32, 'radius': '0px', 'minHeight': '0px', 'fontSize': '13px'}, actual
            # Overrides stay inside the editor; registry inputs keep their pills.
            assert actual['registryTitle'] == ('32px' if width <= 640 else '38px'), actual
            assert actual['registryRadius'] == '100px', actual
            assert actual['registryMinHeight'] == '46px', actual

        # Initial cells arrive with metadata in one request. Optional contact
        # workspace metadata cannot sit ahead of the user's first saved edit.
        reset(hold_workspace=True)
        initial = page.evaluate('gridBackend.calls')
        assert [call['method'] for call in initial] == ['getGridWorkbook']
        assert initial[0]['payload']['includeInitialRange'] is True
        edit(2, 1, 'Сохранить без ожидания контактов')
        page.wait_for_function("gridBackend.sheets[0].cells.get('2:1').input==='Сохранить без ожидания контактов'")
        assert page.evaluate("gridBackend.sheets[0].cells.get('2:1').input") == 'Сохранить без ожидания контактов'
        assert page.evaluate("gridBackend.calls.filter(call=>call.method==='saveGridRange').length") == 1
        assert not page.evaluate("gridBackend.calls.some(call=>['getPromouserSettings','getValidationState','getColdyValidationState'].includes(call.method))")
        assert page.evaluate("(()=>{const saved=gridBackend.calls.findIndex(call=>call.method==='saveGridRange'),workspace=gridBackend.calls.findIndex(call=>call.method==='getContactWorkspace');return workspace<0||saved<workspace;})()")
        page.locator('#rg-grid-close').click()
        assert page.locator('#rg-grid-panel').is_hidden()

        # Older deployments without the optional bundled DTO still make exactly
        # one initial range request and retain editable cells/version hashes.
        reset(omit_initial=True)
        opening = page.evaluate('gridBackend.calls')
        assert [call['method'] for call in opening] == ['getGridWorkbook', 'getGridRange']
        assert opening[0]['payload']['includeInitialRange'] is True
        assert page.locator('#rg-cell-2-1').inner_text() == 'Альфа'

        # A legacy contact sheet paints promptly, then the optional repair
        # refreshes its metadata and cells without calling any validation.
        page.goto('about:blank')
        page.set_content(HTML)
        page.evaluate("""() => {
            const email = gridBackend.sheets.splice(1, 1)[0];
            email.columnCount = 4;
            gridBackend.sheets.unshift(email);
            gridBackend.mailingStatusPending = true;
            gridBackend.holdMethods = ['getContactWorkspace'];
            void openTestGrid();
        }""")
        held('getContactWorkspace')
        assert page.locator('#rg-cell-2-1').inner_text() == 'Альфа'
        assert page.locator('#rg-cell-1-5').count() == 0
        opening = page.evaluate('gridBackend.calls')
        assert [call['method'] for call in opening] == ['getGridWorkbook', 'getContactWorkspace']
        assert opening[1]['payload'] == {'id': 'grid_file_1234567890', 'prepareMailingStatus': True}
        release('getContactWorkspace')
        page.wait_for_selector('#rg-cell-1-5')
        idle()
        assert page.locator('#rg-cell-1-5').inner_text() == 'Статус рассылки'
        assert page.locator('#rg-cell-2-5').inner_text() == 'новый'
        methods = page.evaluate('gridBackend.calls.map(call=>call.method)')
        assert methods[:3] == ['getGridWorkbook', 'getContactWorkspace', 'getGridWorkbook']
        assert methods[3:] in ([], ['getGridRange'])

        page.evaluate("""() => {
            RegistryGrid.lock();
            gridBackend.calls.length = 0;
            gridBackend.holdMethods = [];
            gridBackend.canEdit = false;
            gridBackend.mailingStatusPending = true;
            void openTestGrid();
        }""")
        page.wait_for_selector('#rg-grid-readonly:not([hidden])')
        idle()
        assert page.evaluate('gridBackend.calls.map(call=>call.method)') == ['getGridWorkbook']

        # Revocation while the bundled read is held cannot restore its nested
        # cells or issue a later fallback read after the grid has been locked.
        page.goto('about:blank')
        page.set_content(HTML)
        page.evaluate("gridBackend.holdMethods=['getGridWorkbook'];void openTestGrid()")
        held('getGridWorkbook')
        page.evaluate('RegistryGrid.lock()')
        release('getGridWorkbook')
        page.wait_for_function('gridBackend.active===0')
        assert page.locator('#rg-grid-panel').is_hidden()
        assert page.locator('#rg-grid-body').inner_text() == ''
        assert page.evaluate('gridBackend.calls.length') == 1

        # Closing a drawer stops its remaining optional reads. An old settings
        # response cannot reopen it or start provider work after closing.
        reset()
        page.evaluate("gridBackend.holdMethods=['getPromouserSettings']")
        page.locator('#rg-grid-validation-open').click()
        held('getPromouserSettings')
        page.locator('#rg-grid-validation-close').click()
        release('getPromouserSettings')
        idle()
        methods = page.evaluate('gridBackend.calls.map(call=>call.method)')
        assert methods == ['getGridWorkbook', 'getPromouserSettings']
        assert page.locator('#rg-grid-validation').is_hidden()
        assert not page.evaluate("gridBackend.calls.some(call=>['advanceWorkbookValidation','payValidationOrder','advanceColdyValidation','startPhoneValidation','startColdyValidation'].includes(call.method))")

        # A response from a closed opening cannot unlock the provider form for
        # a newer opening whose own settings request is still held.
        reset()
        page.evaluate("gridBackend.holdMethods=['getPromouserSettings']")
        page.locator('#rg-grid-validation-open').click()
        held('getPromouserSettings')
        page.locator('#rg-grid-validation-close').click()
        page.locator('#rg-grid-validation-open').click()
        release('getPromouserSettings')
        held('getPromouserSettings')
        assert page.locator('#rg-grid-provider-form').evaluate('form=>form.inert')
        page.evaluate('gridBackend.holdMethods=[]')
        release('getPromouserSettings')
        idle()
        assert not page.locator('#rg-grid-provider-form').evaluate('form=>form.inert')

        # Rapid navigation keeps one in-flight read and the latest queued
        # destination. Intermediate destinations never consume server requests.
        reset()
        page.evaluate("gridBackend.holdMethods=['getGridRange']")
        page.locator('#rg-grid-address').fill('A130')
        page.locator('#rg-grid-address').press('Enter')
        held('getGridRange')
        page.evaluate("""()=>{
          const address=document.getElementById('rg-grid-address');
          for(const value of ['A180','A220']){
            address.value=value;
            address.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
          }
        }""")
        page.wait_for_timeout(120)
        assert page.evaluate("gridBackend.calls.filter(call=>call.method==='getGridRange').length") == 1
        release('getGridRange')
        held('getGridRange')
        assert page.evaluate("gridBackend.calls.filter(call=>call.method==='getGridRange').length") == 2
        page.evaluate('gridBackend.holdMethods=[]')
        release('getGridRange')
        idle()
        assert page.locator('#rg-grid-address').input_value() == 'A220'
        ranges_before = page.evaluate("gridBackend.calls.filter(call=>call.method==='getGridRange').length")
        page.locator('#rg-grid-address').fill('A1')
        page.locator('#rg-grid-address').press('Enter')
        idle()
        page.wait_for_timeout(100)
        assert page.evaluate("gridBackend.calls.filter(call=>call.method==='getGridRange').length") == ranges_before
        assert page.locator('#rg-cell-2-1').inner_text() == 'Альфа'

        reset()
        integrated_styles(1440)
        assert page.locator('#rg-grid-title').inner_text() == 'Кухни — рабочая база'
        assert page.locator('#rg-grid-native').get_attribute('href') == 'https://docs.google.com/spreadsheets/d/grid_file_1234567890/edit#gid=0'
        assert page.locator('#rg-grid-head th[data-column="1"]').inner_text() == 'A'
        assert page.locator('#rg-grid-head th[data-column="27"]').inner_text() == 'AA'
        assert page.locator('#rg-cell-3-1').inner_text() == '<img src=x onerror=alert(1)>'
        assert page.locator('#rg-grid-body img').count() == 0
        assert page.locator('#rg-cell-3-4').inner_text() == '2'

        # Typing/Enter autosaves without a separate Save action.
        page.locator('#rg-cell-2-1').click()
        page.locator('#rg-grid-viewport').press('N')
        page.locator('#rg-grid-editor').fill('Новая компания')
        page.locator('#rg-grid-editor').press('Enter')
        idle()
        assert page.evaluate("gridBackend.sheets[0].cells.get('2:1').input") == 'Новая компания'
        assert 'сохранены' in page.locator('#rg-grid-status').inner_text()
        page.locator('#rg-cell-2-4').click()
        page.locator('#rg-grid-formula').fill('=1+1')
        page.locator('#rg-grid-formula').press('Enter')
        idle()
        assert page.locator('#rg-cell-2-4').inner_text() == '2'
        assert page.locator('#rg-grid-formula').input_value() == '=1+1'

        # A newer local value survives the earlier server acknowledgement.
        reset()
        page.evaluate("gridBackend.holdMethods=['saveGridRange']")
        edit(2, 1, 'Первая версия')
        held('saveGridRange')
        edit(2, 1, 'Вторая версия')
        assert page.locator('#rg-cell-2-1').inner_text() == 'Вторая версия'
        release('saveGridRange')
        held('saveGridRange')
        assert page.locator('#rg-cell-2-1').inner_text() == 'Вторая версия'
        calls = page.evaluate("gridBackend.calls.filter(item=>item.method==='saveGridRange')")
        assert len(calls) == 2
        assert calls[0]['payload']['expected'] == [['v1']]
        assert calls[1]['payload']['expected'] == [['v2']]
        release('saveGridRange')
        idle()
        assert page.evaluate("gridBackend.sheets[0].cells.get('2:1').input") == 'Вторая версия'
        assert page.evaluate('gridBackend.maxActive') == 1

        # A fill-missing read queued behind a write keeps the newer acknowledged
        # cache. It must not restore a version captured before that write.
        reset()
        page.evaluate("gridBackend.holdMethods=['saveGridRange']")
        edit(2, 1, 'Сохранённое значение')
        held('saveGridRange')
        page.locator('#rg-grid-head th[data-column="1"]').click()
        page.locator('#rg-grid-copy').click()
        release('saveGridRange')
        page.wait_for_function('copiedGridText!==null')
        assert page.evaluate('copiedGridText.split("\\n")[1]') == 'Сохранённое значение'
        page.evaluate('gridBackend.holdMethods=[]')
        edit(2, 1, 'Следующая версия')
        idle()
        assert page.evaluate("gridBackend.sheets[0].cells.get('2:1').input") == 'Следующая версия'
        assert page.evaluate("gridBackend.calls.filter(item=>item.method==='saveGridRange').at(-1).payload.expected[0][0]") == 'v2'

        # A tall paste becomes pending immediately, fetches missing versions and
        # saves as one bounded rectangle. Closing waits rather than dropping it.
        reset(1500)
        page.locator('#rg-cell-4-1').click()
        text = '\n'.join(f'contact-{index}@example.test' for index in range(1000))
        page.evaluate("gridBackend.holdMethods=['getGridRange','saveGridRange']")
        page.locator('#rg-grid-viewport').evaluate("(node,text)=>{const data=new DataTransfer();data.setData('text/plain',text);node.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));}", text)
        assert page.evaluate('RegistryGrid.hasPending()')
        held('getGridRange')
        page.locator('#rg-grid-close').click()
        assert page.locator('#rg-grid-panel').is_visible()
        release('getGridRange')
        held('saveGridRange')
        assert len(page.evaluate("gridBackend.calls.filter(item=>item.method==='saveGridRange').at(-1).payload.values")) == 1000
        release('saveGridRange')
        page.wait_for_selector('#rg-grid-panel[hidden]', state='attached')
        assert page.evaluate("gridBackend.sheets[0].cells.get('1003:1').input") == 'contact-999@example.test'
        assert page.evaluate('gridBackend.maxActive') == 1

        # Loading the unseen part of a paste cannot refresh an old version of a
        # visible cell and silently overwrite a colleague's intervening change.
        reset(1500)
        page.locator('#rg-cell-4-1').click()
        page.evaluate("gridServerEdit(0,4,1,'Коллега')")
        page.locator('#rg-grid-viewport').evaluate("(node,text)=>{const data=new DataTransfer();data.setData('text/plain',text);node.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));}", text)
        page.wait_for_selector('#rg-grid-error:not([hidden])')
        assert 'Конфликт' in page.locator('#rg-grid-status').inner_text()
        assert page.evaluate("gridBackend.sheets[0].cells.get('4:1').input") == 'Коллега'
        assert page.locator('#rg-cell-4-1').inner_text() == 'contact-0@example.test'
        page.locator('#rg-grid-copy-draft').click()
        page.wait_for_function('(text)=>copiedGridText===text', arg=text)

        # A read failure during a queued large paste keeps the paste locally.
        reset(1500)
        page.locator('#rg-cell-4-1').click()
        page.evaluate("gridBackend.failures.getGridRange=['GRID_NETWORK']")
        page.locator('#rg-grid-viewport').evaluate("(node,text)=>{const data=new DataTransfer();data.setData('text/plain',text);node.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));}", text)
        page.wait_for_selector('#rg-grid-error:not([hidden])')
        assert page.evaluate('RegistryGrid.hasPending()')
        page.locator('#rg-grid-copy-draft').click()
        page.wait_for_function('(text)=>copiedGridText===text', arg=text)
        page.locator('#rg-grid-retry').click()
        idle()
        assert page.evaluate("gridBackend.sheets[0].cells.get('1003:1').input") == 'contact-999@example.test'

        # TSV pastes remain rectangles, preserve plain text and can be undone.
        reset()
        page.locator('#rg-cell-4-1').click()
        page.locator('#rg-grid-viewport').evaluate("(node,text)=>{const data=new DataTransfer();data.setData('text/plain',text);node.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));}", 'A\tB\nC\t<img src=x onerror=alert(1)>')
        idle()
        assert page.evaluate("gridBackend.sheets[0].cells.get('4:1').input") == 'A'
        assert page.locator('#rg-cell-5-2').inner_text() == '<img src=x onerror=alert(1)>'
        assert page.locator('#rg-grid-body img').count() == 0
        page.locator('#rg-grid-copy').click()
        page.wait_for_function('copiedGridText!==null')
        assert page.evaluate('copiedGridText') == 'A\tB\nC\t<img src=x onerror=alert(1)>'
        page.locator('#rg-grid-undo').click()
        idle()
        assert page.evaluate("gridBackend.sheets[0].cells.get('4:1').input") == ''
        page.locator('#rg-grid-redo').click()
        idle()
        assert page.evaluate("gridBackend.sheets[0].cells.get('4:1').input") == 'A'

        # A local edit is committed before a programmatic sheet switch (no blur).
        reset()
        edit(2, 1, 'Сохранить перед сменой', enter=False)
        page.locator('[data-sheet-id="1"]').evaluate('node=>node.click()')
        page.wait_for_function("document.querySelector('[data-sheet-id=\"1\"]').getAttribute('aria-selected')==='true'")
        idle()
        assert page.evaluate("gridBackend.sheets[0].cells.get('2:1').input") == 'Сохранить перед сменой'
        assert page.locator('#rg-grid-native').get_attribute('href').endswith('#gid=1')
        page.locator('#rg-cell-2-2').click()
        page.locator('#rg-grid-formula').fill('formula bar edit')
        page.locator('[data-sheet-id="2"]').evaluate('node=>node.click()')
        page.wait_for_function("document.querySelector('[data-sheet-id=\"2\"]').getAttribute('aria-selected')==='true'")
        idle()
        assert page.evaluate("gridBackend.sheets[1].cells.get('2:2').input") == 'formula bar edit'

        # Failed and uncertain writes keep draft and retry the exact request ID.
        reset()
        page.evaluate("gridBackend.failAfterSave=true")
        edit(2, 1, 'Не потерять')
        page.wait_for_selector('#rg-grid-error:not([hidden])')
        assert page.locator('#rg-cell-2-1').inner_text() == 'Не потерять'
        assert page.evaluate('RegistryGrid.hasPending()')
        original_id = page.evaluate("gridBackend.calls.find(item=>item.method==='saveGridRange').payload.requestId")
        page.locator('#rg-grid-retry').click()
        idle()
        ids = page.evaluate("gridBackend.calls.filter(item=>item.method==='saveGridRange').map(item=>item.payload.requestId)")
        assert ids == [original_id, original_id]
        assert page.evaluate("gridBackend.sheets[0].cells.get('2:1').revision") == 2

        # Recovery of a lost response must not let a later queued edit overwrite
        # an external change made after the first write actually succeeded.
        reset()
        page.evaluate("gridBackend.holdMethods=['saveGridRange'];gridBackend.failAfterSave=true")
        edit(2, 1, 'Первая правка')
        held('saveGridRange')
        edit(2, 1, 'Поздняя локальная правка')
        release('saveGridRange')
        page.wait_for_selector('#rg-grid-error:not([hidden])')
        page.evaluate("gridBackend.holdMethods=[];gridServerEdit(0,2,1,'Коллега после записи')")
        page.locator('#rg-grid-retry').click()
        page.wait_for_function("document.getElementById('rg-grid-status').textContent.includes('Конфликт')")
        assert page.evaluate("gridBackend.sheets[0].cells.get('2:1').input") == 'Коллега после записи'
        assert page.locator('#rg-cell-2-1').inner_text() == 'Поздняя локальная правка'
        assert len(page.evaluate("gridBackend.calls.filter(item=>item.method==='saveGridRange')")) == 2

        # An external edit causes a conflict and never silently overwrites it.
        reset()
        page.evaluate("gridServerEdit(0,2,1,'Правка коллеги')")
        edit(2, 1, 'Моя правка')
        page.wait_for_selector('#rg-grid-error:not([hidden])')
        assert 'Конфликт' in page.locator('#rg-grid-status').inner_text()
        assert page.locator('#rg-cell-2-1').inner_text() == 'Моя правка'
        assert page.evaluate("gridBackend.sheets[0].cells.get('2:1').input") == 'Правка коллеги'
        assert page.locator('#rg-grid-retry').is_hidden()
        page.locator('#rg-grid-close').click()
        assert page.locator('#rg-grid-panel').is_visible()
        page.locator('#rg-grid-copy-draft').click()
        page.wait_for_function("copiedGridText==='Моя правка'")
        page.locator('#rg-grid-discard').click()
        idle()
        assert page.locator('#rg-cell-2-1').inner_text() == 'Правка коллеги'
        page.locator('#rg-grid-close').click()
        assert page.locator('#rg-grid-panel').is_hidden()

        # Keyboard navigation and window loading can reach cells off screen.
        reset()
        page.locator('#rg-grid-address').fill('BA150')
        page.locator('#rg-grid-address').press('Enter')
        page.wait_for_selector('#rg-cell-150-53')
        page.wait_for_function('gridBackend.active===0')
        assert page.locator('#rg-grid-address').input_value() == 'BA150'
        page.locator('#rg-grid-viewport').press('ArrowRight')
        assert page.locator('#rg-grid-address').input_value() == 'BB150'
        page.locator('#rg-grid-add-rows').click()
        page.wait_for_function('gridBackend.sheets[0].rowCount===340 && gridBackend.active===0')
        page.locator('#rg-grid-add-columns').click()
        page.wait_for_function('gridBackend.sheets[0].columnCount===81 && gridBackend.active===0')

        # Revocation removes local data and pending later writes; late replies ignored.
        reset()
        page.evaluate("gridBackend.holdMethods=['saveGridRange']")
        edit(2, 1, 'Первая')
        held('saveGridRange')
        edit(2, 1, 'Локальная вторая')
        page.evaluate('RegistryGrid.lock()')
        assert page.locator('#rg-grid-panel').is_hidden()
        assert page.locator('#rg-grid-body').inner_text() == ''
        release('saveGridRange')
        page.wait_for_function('gridBackend.active===0')
        assert len(page.evaluate("gridBackend.calls.filter(item=>item.method==='saveGridRange')")) == 1
        assert page.locator('#rg-grid-body').inner_text() == ''

        # Reload must not claim the old DOM is saved while metadata or fresh cells are pending.
        reset()
        page.evaluate("gridServerEdit(0,2,1,'Свежие данные из Google');gridBackend.holdMethods=['getGridWorkbook','getGridRange']")
        page.locator('#rg-grid-reload').click()
        held('getGridWorkbook')
        assert page.locator('#rg-grid-status').get_attribute('data-state') == 'loading'
        assert 'Загружаем' in page.locator('#rg-grid-status').inner_text()
        assert page.locator('#rg-grid-formula').is_disabled()
        assert page.locator('#rg-cell-2-1').inner_text() != 'Свежие данные из Google'
        release('getGridWorkbook')
        held('getGridRange')
        assert page.locator('#rg-grid-status').get_attribute('data-state') == 'loading'
        assert page.locator('#rg-grid-reload').is_disabled()
        release('getGridRange')
        page.wait_for_function("document.getElementById('rg-grid-status').dataset.state==='saved'")
        assert page.locator('#rg-cell-2-1').inner_text() == 'Свежие данные из Google'
        assert page.locator('#rg-grid-formula').is_enabled()

        # A failed read without any edits never traps the user in the editor.
        reset()
        page.evaluate("gridBackend.failures.getGridRange=['GRID_NETWORK']")
        page.locator('#rg-grid-reload').click()
        page.wait_for_selector('#rg-grid-error:not([hidden])')
        assert not page.evaluate('RegistryGrid.hasPending()')
        page.locator('#rg-grid-close').click()
        assert page.locator('#rg-grid-panel').is_hidden()

        reset()
        page.evaluate("gridServerEdit(0,3,1,'Мебель Бета')")
        page.locator('#rg-grid-reload').click()
        page.wait_for_function('gridBackend.active===0')
        page.screenshot(path='/workspace/work/grid-editor-desktop.png')
        for width in [1440, 360, 320]:
            page.set_viewport_size({'width': width, 'height': 900})
            integrated_styles(width)
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth'), ('page overflow', width)
            assert page.locator('#rg-grid-panel').evaluate('node=>node.scrollWidth<=node.clientWidth'), ('panel overflow', width)
            if width == 320:
                page.screenshot(path='/workspace/work/grid-editor-mobile.png')
        page.set_viewport_size({'width': 1440, 'height': 1000})
        page.evaluate("RegistryGrid.lock();gridBackend.canEdit=false;void openTestGrid()")
        page.wait_for_selector('#rg-cell-2-1')
        assert page.locator('#rg-grid-readonly').is_visible()
        page.locator('#rg-cell-2-1').dblclick()
        assert page.locator('#rg-grid-editor').is_hidden()
        assert page.locator('#rg-grid-add-rows').is_disabled()
        assert not errors, errors
        print('PASS: Grid autosave, TSV, keyboard, same-cell queue, conflict, retry, append, lock and responsive checks; max RPC concurrency 1.')
        browser.close()


if __name__ == '__main__':
    main()
