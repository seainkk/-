"""Visible-only registry revision checks, segment reads and live grid cells, without external services."""
from pathlib import Path
import sys

from performance_client import expand_segment_actions
from playwright.sync_api import expect, sync_playwright
from project_client import integrated_html


def main():
    grid = Path(__file__).with_name('grid-fixture.js').read_text(encoding='utf-8')
    fixture = grid + """
const fullCatalog=api.getSourceBases;
const bootstrapCatalog=api.getAppBootstrap;
api.getAppBootstrap=payload=>({...bootstrapCatalog(),catalogPreview:payload?.includeSourcePreview?{
  checkedAt:Date.now(),items:[{name:'Быстрый список',contents:['companies'],distribution:'unassigned'},{name:'Тип ещё не указан',contents:[]}]
}:null});
backend.holdMethods=['getSourceBases'];
backend.revision='v1';
api.getSourceBases=()=>({...fullCatalog(),revision:backend.revision});
api.getSourceBasesRevision=()=>({revision:backend.revision});
for(const method of ['getGridWorkbook','getGridRange','saveGridRange','getContactWorkspace'])
  api[method]=payload=>fakeGridRpc(method,payload);
"""
    with sync_playwright() as runtime:
        launch={'channel':'chrome'} if sys.platform=='win32' else {'executable_path':'/usr/bin/chromium'}
        browser=runtime.chromium.launch(**launch,headless=True,args=['--no-sandbox'])
        page=browser.new_page(viewport={'width':1280,'height':800})
        errors=[]
        page.on('pageerror',lambda error:errors.append(str(error)))
        page.set_content(integrated_html().replace('api.getColdySettings=',fixture+'api.getColdySettings=',1))
        titles=page.locator('#br-sources-items h2')
        expect(titles).to_have_text(['Быстрый список','Тип ещё не указан'])
        expect(page.locator('#br-sources-health')).to_contain_text('в фоне')
        expect(page.locator('#br-sources-items a, #br-sources-items button')).to_have_count(0)
        expect(page.locator('#br-source-project-filter')).to_be_enabled()
        page.locator('#br-source-project-filter').select_option('numshield')
        expect(page.locator('#br-source-filters-note')).to_contain_text('Уточняем результат')
        page.locator('#br-source-project-filter').select_option('')
        page.locator('#br-source-search').fill('Быстрый')
        expect(titles).to_have_text(['Быстрый список'])
        page.locator('#br-source-search').fill('')
        expect(titles).to_have_text(['Быстрый список','Тип ещё не указан'])
        expect(page.locator('#br-source-contents-filter')).to_be_enabled()
        assert not page.evaluate("backend.calls.some(c=>/Coldy|ServiceLimits/i.test(c.name))")
        page.evaluate("backend.failSource=true;backend.holdMethods=[];releaseRpc('getSourceBases')")
        expect(page.locator('#br-sources-health')).to_contain_text('Показаны последние данные')
        expect(titles).to_have_text(['Быстрый список','Тип ещё не указан'])
        page.wait_for_function('backend.active===0')
        page.locator('#br-refresh').click()
        source=page.locator('[data-source-id="source-companies"]')
        expect(source).to_be_visible()
        header=page.locator('header.br-header')
        bases=header.get_by_role('button',name='Общий каталог',exact=True)
        expect(bases).to_have_attribute('aria-pressed','true')
        expect(bases).to_have_attribute('aria-controls','br-sources-view')
        expect(header).not_to_contain_text('Реестр баз')
        expect(page.get_by_role('region',name='Общий каталог')).to_be_visible()
        expect(page.get_by_role('heading',name='Общий каталог',level=1)).to_be_visible()
        page.wait_for_function('backend.active===0')

        def calls(method):
            return page.evaluate('(method)=>backend.calls.filter(c=>c.name===method).length',method)

        def tick(ms):
            page.evaluate('ms=>tick(ms)',ms)
            page.wait_for_function('backend.active===0')

        assert calls('getSourceBases')==2
        expect(page.locator('#br-source-project-filter')).to_be_enabled()
        expect(page.get_by_role('heading',name='Быстрый список')).to_have_count(0)
        # A colleague can return after 30s and continue with the same cards while Drive verifies its version.
        page.locator('#br-view-retarget').click()
        tick(31000)
        page.evaluate("backend.holdMethods=['getSourceBasesRevision']")
        bases.click()
        page.wait_for_function("backend.pending.some(p=>p.method==='getSourceBasesRevision')")
        expect(source).to_be_visible()
        expect(source.locator('[data-grid-source]')).to_be_enabled()
        assert calls('getSourceBases')==2
        page.evaluate("backend.holdMethods=[];releaseRpc('getSourceBasesRevision')")
        page.wait_for_function('backend.active===0')
        assert calls('getSourceBasesRevision')==1 and calls('getSourceBases')==2
        page.evaluate("backend.sources[0].name='Новое название';backend.revision='v2'")
        tick(31000)
        expect(source.locator('h2')).to_have_text('Новое название')
        assert calls('getSourceBases')==3
        tick(121000)
        assert calls('getSourceBases')==4
        page.locator('#br-refresh').click()
        page.wait_for_function('backend.active===0')
        assert calls('getSourceBases')==5
        # A stale reply cannot refresh this project after switching to another screen.
        page.evaluate("backend.holdAfterMethods=['getSourceBasesRevision'];backend.revision='v3';tick(31000)")
        page.wait_for_function("backend.pending.some(p=>p.method==='getSourceBasesRevision')")
        page.locator('#br-view-segments').click()
        page.evaluate("backend.holdAfterMethods=[];releaseRpc('getSourceBasesRevision')")
        segment=page.locator('[data-segment="existing-segment"]')
        expect(segment).to_be_visible()
        expect(bases).to_have_attribute('aria-pressed','false')
        page.wait_for_function('backend.dashboardFullGets>0&&backend.active===0')
        assert calls('getSourceBases')==5
        page.evaluate("backend.segments[0].name='Сегмент после изменения'")
        tick(61000)
        expect(segment.locator('.br-segment-row-name')).to_have_text('Сегмент после изменения')
        before=calls('getSegmentsDashboard')
        page.evaluate("testClock.hidden=true;document.dispatchEvent(new Event('visibilitychange'));tick(121000)")
        assert calls('getSegmentsDashboard')==before
        page.evaluate("testClock.hidden=false;document.dispatchEvent(new Event('visibilitychange'))")
        page.wait_for_function('backend.active===0')

        expand_segment_actions(segment)
        segment.locator('[data-grid-source]').first.click()
        expect(page.locator('#rg-cell-2-1')).to_have_text('Альфа')
        page.locator('#rg-grid-tabs [data-sheet-id="1"]').click()
        expect(page.locator('#rg-grid-tabs [data-sheet-id="1"]')).to_have_attribute('aria-selected','true')
        page.wait_for_function('backend.active===0')
        before=calls('getSegmentsDashboard')
        page.evaluate("gridServerEdit(1,2,2,'в рассылке')")
        tick(31000)
        expect(page.locator('#rg-cell-2-2')).to_have_text('в рассылке')
        assert calls('getSegmentsDashboard')==before
        payload=page.evaluate("backend.calls.filter(c=>c.name==='getGridRange').at(-1).p")
        assert payload['sheetId']==1 and payload['rowCount']*payload['columnCount']<1000
        page.evaluate("backend.holdAfterMethods=['getGridRange'];gridServerEdit(1,2,2,'фильтр');tick(31000)")
        page.wait_for_function("backend.pending.some(p=>p.method==='getGridRange')")
        page.locator('#rg-cell-2-2').dblclick()
        page.locator('#rg-grid-editor').fill('Черновик')
        page.evaluate("backend.holdAfterMethods=[];releaseRpc('getGridRange')")
        page.wait_for_function('backend.active===0')
        expect(page.locator('#rg-grid-editor')).to_have_value('Черновик')
        expect(page.locator('#rg-cell-2-2')).to_have_text('в рассылке')
        before=calls('getGridRange')
        tick(61000)
        assert calls('getGridRange')==before
        page.locator('#rg-grid-editor').press('Escape')
        page.evaluate("testClock.hidden=true;document.dispatchEvent(new Event('visibilitychange'));tick(121000)")
        assert calls('getGridRange')==before
        page.evaluate("testClock.hidden=false;document.dispatchEvent(new Event('visibilitychange'))")
        expect(page.locator('#rg-cell-2-2')).to_have_text('фильтр')
        assert page.evaluate('gridBackend.syncRuns===0&&gridBackend.validationRuns===0')
        assert not calls('saveGridRange')
        page.evaluate("gridBackend.failures.getGridRange=['OUTSIDE_PROJECT']")
        tick(31000)
        expect(page.locator('#rg-grid-panel')).to_be_hidden()
        assert page.locator('#rg-grid-body td').count()==0
        assert not errors, errors
        browser.close()
        print('PASS: visible registry revision, full reconciliation, segment changes and edit-safe live grid cells.')


if __name__=='__main__':
    main()
