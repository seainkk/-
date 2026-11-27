"""Use synthetic campaigns to verify target selection, progress and recovery in Chrome."""
import sys
from playwright.sync_api import expect, sync_playwright
from project_client import select_binding_segment, HTML


def main():
    with sync_playwright() as playwright:
        launch = {'channel': 'chrome'} if sys.platform == 'win32' else {'executable_path': '/usr/bin/chromium'}
        browser = playwright.chromium.launch(**launch, headless=True, args=['--no-sandbox'])
        page = browser.new_page()
        page.route('http://registry.test/**', lambda route: route.fulfill(content_type='text/html', body=HTML))
        page.goto('http://registry.test/')
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        def setup(hold_metrics=False):
            page.evaluate("""hold=>{
              backend.holdMethods=hold?['getProjectAnalytics','getProjectAnalyticsCampaigns','getSegmentMailings']:[];
              const loadedAt=Date.now()-10;
              const base=window.transport;
              window.transport=async (name,p,guard)=>{
                if(name!=='syncColdyRecipients'){
                  while(backend.active>=2){if(guard&&!guard())return null;await new Promise(resolve=>setTimeout(resolve,5));}
                  const result=await base(name,p,guard);
                  if(name==='getProjectAnalyticsCampaigns'&&p.segmentId===backend.deniedSegment)throw new Error('[OUTSIDE_SEGMENTS] Сегмент недоступен');
                  return result;
                }
                backend.calls.push({name,payload:clone(p)});
                if(!p.cursor)return {state:'processing',nextCursor:'page-two',processed:2,added:2,updated:0};
                if(!sessionStorage.testLost){sessionStorage.testLost='yes';throw new Error('[GOOGLE_ERROR] Ответ потерян');}
                return {state:'complete',processed:3,added:2,updated:1,excluded:2,fileId:'synthetic-workbook',sheetId:12};
              };
              RegistryProject.configure({transport:window.transport,peekSegments:()=>({
                 state:'ready',loadedAt,segments:[{id:'segment-a',name:'Segment A',previewNames:['Кухни из снимка','Кухни ЛПР из снимка']},{id:'segment-b',name:'Segment B',previewNames:['Other campaign']}]
              })});
              RegistryProject.show('analytics',{ready:true,epoch:1});
              void RegistryProject.refresh({opening:true});
            }""", hold_metrics)
            if hold_metrics:
                expect(page.locator('#pj-segment')).to_be_enabled()
                expect(page.locator('#pj-analytics-connection')).to_be_hidden()
            select_binding_segment(page, 'segment-a')

        def import_calls():
            return page.evaluate("backend.calls.filter(c=>c.name==='syncColdyRecipients').map(c=>c.payload)")

        setup(hold_metrics=True)
        rows=page.locator('#pj-campaign-rows')
        hints=page.locator('#pj-campaign-shown')
        expect(hints).to_have_text('Сохранённые привязки · обновляем список')
        expect(rows).to_contain_text('Кухни ЛПР из снимка')
        expect(rows.locator('button,input')).to_have_count(0)
        expect(page.locator('#pj-selection-save')).to_be_disabled()
        page.evaluate("release('getProjectAnalyticsCampaigns')")
        action = page.locator('[data-recipient-binding="binding-existing-00000001"]')
        expect(action).to_be_enabled()
        assert page.locator('[data-recipient-binding]').count() == 1
        page.wait_for_function("backend.pending.some(c=>c.name==='getSegmentMailings')")
        binding_reads = ['getProjectAnalytics','getProjectAnalyticsCampaigns','getSegmentMailings']
        calls = page.evaluate("backend.calls.map(c=>c.name)")
        assert [name for name in calls if name in binding_reads][:3] == binding_reads
        action.click()
        dialog = page.locator('#pj-recipient-dialog')
        target = page.locator('#pj-recipient-target')
        confirm = page.locator('#pj-recipient-confirm')
        close = page.locator('#pj-recipient-close')
        expect(dialog).to_be_visible()
        expect(confirm).to_be_disabled()
        target.select_option('companies')
        close.click()
        expect(dialog).to_be_hidden()
        assert not import_calls()

        # A response for the previous segment must not replace a warm chooser or its draft.
        page.evaluate("backend.holdMethods=['getProjectAnalyticsCampaigns'];release('getProjectAnalytics')")
        select_binding_segment(page, 'segment-b')
        expect(hints).to_have_text('Сохранённые привязки · обновляем список')
        expect(rows).to_contain_text('Other campaign')
        expect(rows).not_to_contain_text('Кухни из снимка')
        expect(rows.locator('button,input')).to_have_count(0)
        page.evaluate("backend.holdMethods=[];release('getProjectAnalyticsCampaigns')")
        expect(page.locator('[data-recipient-binding="binding-other-0000000002"]')).to_be_enabled()
        select_binding_segment(page, 'segment-a')
        page.locator('#pj-selection-open').click()
        page.locator('#pj-campaign-search').fill('New')
        page.locator('#pj-campaign-find').click()
        other_campaign = page.locator('[data-project-campaign="22222222-2222-4222-8222-222222222222"]')
        other_campaign.check()
        page.evaluate("release('getSegmentMailings')")
        expect(other_campaign).to_be_checked()
        expect(action).to_be_disabled()
        other_campaign.uncheck()
        expect(action).to_be_enabled()
        calls = page.evaluate('backend.calls')
        assert len([c for c in calls if c['name']=='getProjectAnalyticsCampaigns' and c['payload']['segmentId']=='segment-a' and 'query' not in c['payload']]) == 1
        assert all(c['payload'].get('monitor') is True and c['payload']['segmentId'] in ['segment-a','segment-b'] for c in calls if c['name']=='refreshColdyMailings')

        action.click()
        target.select_option('lpr')
        confirm.click()
        health = page.locator('#pj-recipient-health')
        expect(health).to_contain_text('Ответ потерян')
        expect(target).to_be_disabled()
        first, lost = import_calls()
        assert first['segmentId'] == 'segment-a' and first['bindingId'] == 'binding-existing-00000001'
        assert first['targetKind'] == 'lpr' and 'cursor' not in first
        assert lost == {**first, 'cursor':'page-two'}
        close.click()
        page.reload()
        setup()
        action.click()
        expect(target).to_have_value('lpr')
        expect(target).to_be_disabled()
        expect(confirm).to_have_text('Продолжить тот же запрос')
        confirm.click()
        expect(health).to_contain_text('Обработано 3, добавлено 2, обновлено 1')
        expect(health).to_contain_text('Сохранено ручных исключений 2')
        expect(page.locator('#pj-recipient-sheet')).to_have_attribute('href','https://docs.google.com/spreadsheets/d/synthetic-workbook/edit#gid=12')
        assert import_calls() == [lost]
        close.click()
        action.click()
        expect(target).to_have_value('')
        expect(target).to_be_enabled()
        page.keyboard.press('Escape')
        expect(dialog).to_be_hidden()
        page.reload()
        setup(hold_metrics=True)
        expect(rows).to_contain_text('Кухни из снимка')
        page.evaluate("backend.deniedSegment='segment-a';backend.holdMethods=[];release('getProjectAnalyticsCampaigns');release('getProjectAnalytics')")
        expect(page.locator('#pj-analytics-health')).to_contain_text('Сегмент недоступен')
        expect(rows).not_to_contain_text('Кухни из снимка')
        expect(rows.locator('button,input')).to_have_count(0)
        page.wait_for_function('backend.active===0')
        expect(rows.locator('button,input')).to_have_count(0)
        assert not errors, errors
        browser.close()
        print('Coldy recipient import, warm segment switch and delayed metrics passed')


if __name__ == '__main__':
    main()
