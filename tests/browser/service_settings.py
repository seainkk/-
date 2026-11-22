"""Service settings are scoped to an open dialog. No provider or Google traffic."""
import sys
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
from project_client import integrated_html


def main():
    with sync_playwright() as runtime:
        launch={'channel':'chrome'} if sys.platform=='win32' else {'executable_path':'/usr/bin/chromium'}
        browser=runtime.chromium.launch(**launch,headless=True,args=['--no-sandbox'])
        page=browser.new_page(viewport={'width':360,'height':820})
        errors=[]
        page.on('pageerror',lambda error:errors.append(str(error)))
        fixture="""
const began=new Date().valueOf();Date.now=()=>testClock.now+new Date().valueOf()-began;
api.getServiceLimits=async({provider,connectionOnly})=>{
  if(connectionOnly)return {provider,configured:true,active:true,checkedAt:'2026-11-22T06:30:00Z',items:[],message:''};
  if(provider==='coldy'&&window.waitColdy)await new Promise(done=>window.resumeColdy=done);
  if(provider==='coldy'&&window.coldyState==='failing')throw Error('Ошибка чтения');
  if(provider==='coldy'&&window.coldyState==='waiting')return {provider,configured:true,active:null,pending:true,items:[],message:'Проверено 20 из 38',retryAfterMs:0};
  if(provider==='coldy'&&window.coldyState==='limited')return {provider,configured:true,active:null,pending:true,items:[],message:'Ограничение запросов',retryAfterMs:120000};
  return {provider,configured:true,active:provider==='promouser'?null:true,checkedAt:'2026-11-22T06:30:00Z',
    items:[{label:'Доступно',value:provider==='promouser'?null:0,unit:'кредитов'},{label:'Лимит',value:5.75,unit:'USD'},{label:'Остаток',value:0.00000001,unit:'USD'}],message:''};
};
window.copies=[];
Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async url=>{copies.push(url);}}});
"""
        grid=Path(__file__).with_name('grid-fixture.js').read_text(encoding='utf-8')
        fixture=grid+fixture+"""
for(const method of ['getGridWorkbook','getGridRange','saveGridRange','getContactWorkspace','getValidationState','getColdyValidationState'])
  api[method]=p=>fakeGridRpc(method,p);
"""
        page.set_content(integrated_html().replace('api.getColdySettings=',fixture+'api.getColdySettings=',1))
        page.wait_for_function('backend.active===0&&backend.sourceGets>0')
        def calls(provider):
            return page.evaluate("(s)=>backend.calls.filter(c=>c.name==='getServiceLimits'&&c.p.provider===s).length",provider)
        def idle():
            page.wait_for_function('backend.active===0')
        initial=page.locator('header.br-header')
        for rid in ['br-provider-open','br-coldy-open','br-share-copy']:
            assert not initial.locator('#'+rid).count()
        assert calls('promouser')==calls('coldy')==0
        page.evaluate("waitColdy=true")
        initial.get_by_role('button',name='Настройки').click()
        modal=page.get_by_role('dialog',name='Настройки',exact=True)
        expect(modal).to_be_visible()
        expect(modal.locator('#br-settings-promouser-status')).to_contain_text('не подтверждено')
        expect(modal.locator('#br-settings-promouser-limits')).to_contain_text('Нет данных')
        expect(modal.locator('#br-settings-promouser-limits')).to_contain_text('5,75 USD')
        expect(modal.locator('#br-settings-promouser-limits')).to_contain_text('0,00000001 USD')
        expect(modal.locator('#br-settings-coldy-status')).to_have_text('Подключение активно')
        expect(modal.locator('#br-settings-coldy-note')).to_contain_text('Обновляем дневные лимиты')
        page.wait_for_function("typeof resumeColdy==='function'")
        page.evaluate("waitColdy=false;resumeColdy()")
        expect(modal.locator('#br-settings-coldy-status')).to_have_text('Подключение активно')
        expect(modal.locator('#br-settings-coldy-limits')).to_contain_text('0 кредитов')
        expect(modal.locator('#br-settings-coldy-note')).to_contain_text('МСК')
        modal.get_by_role('button',name='Скопировать закрытую ссылку').click()
        expect(modal.locator('#br-settings-copy-status')).to_have_text('Закрытая ссылка скопирована.')
        assert page.evaluate("copies[0]==='https://seainkk.github.io/-/#access_key='+MOCK_KEY")
        page.evaluate("""Object.defineProperty(navigator,'clipboard',{value:null});document.execCommand=op=>{if(op==='copy'){copies.push(document.activeElement.value);return true;}return false;};""")
        modal.locator('#br-share-copy').click()
        assert page.evaluate("copies.length===2&&copies[0]===copies[1]&&!document.body.innerText.includes(MOCK_KEY)")
        assert not modal.locator('textarea').count()
        page.evaluate("coldyState='waiting';tick(61000)")
        expect(modal.locator('#br-settings-coldy-note')).to_contain_text('20 из 38')
        before=calls('promouser')
        page.evaluate("coldyState='ready'")
        expect(modal.locator('#br-settings-coldy-status')).to_have_text('Подключение активно',timeout=6500)
        assert calls('promouser')==before
        page.evaluate("coldyState='limited';tick(61000)")
        expect(modal.locator('#br-settings-coldy-note')).to_contain_text('Ограничение')
        checks=calls('coldy')
        page.evaluate("tick(61000)")
        idle()
        assert calls('coldy')==checks
        page.evaluate("testClock.hidden=true;document.dispatchEvent(new Event('visibilitychange'));tick(120000)")
        assert calls('coldy')==checks
        page.evaluate("coldyState='failing';testClock.hidden=false;document.dispatchEvent(new Event('visibilitychange'))")
        expect(modal.locator('#br-settings-coldy-status')).to_contain_text('не подтверждено')
        assert not modal.locator('#br-settings-coldy-limits dd').count()
        modal.locator('#br-coldy-open').click()
        expect(page.get_by_role('dialog',name='Подключение Coldy')).to_be_visible()
        page.keyboard.press('Escape')
        expect(modal).to_be_visible()
        modal.locator('#br-settings-close').click()
        idle()
        checks=calls('coldy')
        page.evaluate("tick(120000)")
        idle()
        assert calls('coldy')==checks
        # The complete registry delegates from a workbook to the single service settings panel.
        page.locator('[data-grid-source="source-companies"]').first.click()
        expect(page.locator('#rg-cell-2-1')).to_be_visible()
        page.locator('#rg-grid-tabs [data-sheet-id="1"]').click()
        expect(page.locator('#rg-grid-tabs [data-sheet-id="1"]')).to_have_attribute('aria-selected','true')
        page.locator('#rg-cell-2-2').dblclick()
        page.locator('#rg-grid-editor').fill('Изменение в таблице')
        page.locator('#rg-grid-editor').press('Enter')
        page.wait_for_function("!RegistryGrid.hasPending()&&backend.active===0")
        cell_address=page.locator('#rg-grid-address').input_value()
        page.locator('#rg-grid-validation-open').click()
        global_settings=page.locator('#rg-grid-service-settings')
        expect(global_settings).to_be_enabled()
        expect(page.locator('#rg-grid-provider-settings')).to_be_hidden()
        assert not page.evaluate("backend.calls.some(c=>c.name==='getPromouserSettings')")
        global_settings.click()
        modal.locator('#br-provider-open').click()
        expect(page.locator('#br-provider-save')).to_be_enabled()
        page.locator('#br-provider-save').click()
        idle()
        page.locator('#br-provider-close').click()
        modal.locator('#br-settings-close').click()
        expect(global_settings).to_be_focused()
        expect(page.locator('#rg-grid-validation')).to_be_visible()
        page.locator('#rg-grid-validation-close').click()
        expect(page.locator('#rg-grid-tabs [data-sheet-id="1"]')).to_have_attribute('aria-selected','true')
        expect(page.locator('#rg-cell-2-2')).to_have_text('Изменение в таблице')
        expect(page.locator('#rg-grid-address')).to_have_value(cell_address)
        page.locator('#rg-grid-close').click()
        expect(page.locator('#rg-grid-panel')).to_be_hidden()
        page.evaluate("backend.revoked=true")
        initial.get_by_role('button',name='Настройки').click()
        expect(page.locator('#bases-registry-app')).to_have_attribute('data-access','locked')
        expect(modal).to_be_hidden()
        assert not page.locator('#br-settings-dialog dd').count()
        assert not page.evaluate("backend.calls.some(c=>/^(start|pay|advance)/.test(c.name))")
        assert not errors,errors
        browser.close()
        print('PASS: settings access, independent live balances, cooldowns, copy paths, dialogs and revocation.')


if __name__=='__main__':
    main()
