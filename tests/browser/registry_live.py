"""Visible-only registry revision checks, segment reads and live grid cells, without external services."""
from pathlib import Path
import sys

from playwright.sync_api import expect, sync_playwright
from project_client import integrated_html


def main():
    grid = Path(__file__).with_name('grid-fixture.js').read_text(encoding='utf-8')
    fixture = grid + """
const fullCatalog=api.getSourceBases;
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
        source=page.locator('[data-source-id="source-companies"]')
        expect(source).to_be_visible()
        header=page.locator('header.br-header')
        bases=header.get_by_role('button',name='Базы',exact=True)
        expect(bases).to_have_attribute('aria-pressed','true')
        expect(bases).to_have_attribute('aria-controls','br-sources-view')
        expect(header).not_to_contain_text('Реестр баз')
        expect(page.get_by_role('region',name='Исходные базы и выборки')).to_be_visible()
        expect(page.get_by_role('heading',name='Исходные базы и выборки',level=1)).to_be_visible()
        page.wait_for_function('backend.active===0')

        def calls(method):
            return page.evaluate('(method)=>backend.calls.filter(c=>c.name===method).length',method)

        def tick(ms):
            page.evaluate('ms=>tick(ms)',ms)
            page.wait_for_function('backend.active===0')

        assert calls('getSourceBases')==1
        tick(31000)
        assert calls('getSourceBasesRevision')==1 and calls('getSourceBases')==1
        page.evaluate("backend.sources[0].name='Новое название';backend.revision='v2'")
        tick(31000)
        expect(source.locator('h2')).to_have_text('Новое название')
        assert calls('getSourceBases')==2
        tick(121000)
        assert calls('getSourceBases')==3
        page.locator('#br-refresh').click()
        page.wait_for_function('backend.active===0')
        assert calls('getSourceBases')==4
        # A stale reply cannot refresh this project after switching to another screen.
        page.evaluate("backend.holdAfterMethods=['getSourceBasesRevision'];backend.revision='v3';tick(31000)")
        page.wait_for_function("backend.pending.some(p=>p.method==='getSourceBasesRevision')")
        page.locator('#br-view-segments').click()
        page.evaluate("backend.holdAfterMethods=[];releaseRpc('getSourceBasesRevision')")
        segment=page.locator('[data-segment="existing-segment"]')
        expect(segment).to_be_visible()
        expect(bases).to_have_attribute('aria-pressed','false')
        page.wait_for_function('backend.dashboardFullGets>0&&backend.active===0')
        assert calls('getSourceBases')==4
        page.evaluate("backend.segments[0].name='Сегмент после изменения'")
        tick(61000)
        expect(segment.locator('.br-segment-row-name')).to_have_text('Сегмент после изменения')
        before=calls('getSegmentsDashboard')
        page.evaluate("testClock.hidden=true;document.dispatchEvent(new Event('visibilitychange'));tick(121000)")
        assert calls('getSegmentsDashboard')==before
        page.evaluate("testClock.hidden=false;document.dispatchEvent(new Event('visibilitychange'))")
        page.wait_for_function('backend.active===0')

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
