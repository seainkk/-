"""All bound campaigns are visible without opening a segment or selecting a mailbox."""
import sys
from playwright.sync_api import expect, sync_playwright
from project_client import integrated_html


API = """
testClock.now=Date.parse('2026-11-27T11:00:00Z');
const completionFixtures=[
  {id:A,segmentId:'segment-a',segmentName:'Кухни',name:'Кухни email',status:'Active',observed:true},
  {id:B,segmentId:'segment-b',segmentName:'Партнеры',name:'Архив',status:'Completed',observed:true},
  {id:C,segmentId:'segment-b',segmentName:'Партнеры',name:'На паузе',status:'Paused',observed:true}
];
api.getProjectCampaignCompletions=(p,project)=>{
  const campaigns=project==='numshield'?completionFixtures:[];
  const campaignCompletions=project==='numshield'?{
    [A]:{state:'estimated',estimatedDate:'2026-12-02',percent:40,sent:4,total:10},
    [B]:{state:'completed',lastSentAt:'2026-11-25T22:44:32Z',percent:100,sent:3,total:3},
    [C]:{state:'paused',reason:'paused',percent:50,sent:5,total:10}
  }:{};
  return {campaigns,campaignCompletions,generatedAt:'2026-11-27T10:59:00Z',freshForMs:300000};
};
api.getProjectForecastPreview=()=>null;
api.getProjectSendingForecast=()=>({day:'2026-11-27',state:'no_selection',forecast:null});
api.getProjectSendingHistory=()=>({period:'today',state:backend.monitoringIds.length?'ready':'no_accounts',complete:true,
  from:'2026-11-27',days:['2026-11-27'],accounts:backend.monitoringIds.map(id=>({id})),campaigns:completionFixtures,
  checkedCells:completionFixtures.map(c=>({campaignId:c.id,date:'2026-11-27'})),
  rows:backend.monitoringIds.length?[{date:'2026-11-27',campaignId:C,accountId:'account-1',sent:2}]:[]});
"""


def main():
    with sync_playwright() as runtime:
        chrome={'channel':'chrome'} if sys.platform=='win32' else {'executable_path':'/usr/bin/chromium'}
        browser=runtime.chromium.launch(headless=True,**chrome)
        page=browser.new_page()
        errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.set_content(integrated_html().replace('api.getColdySettings=',API+'api.getColdySettings=',1))
        page.wait_for_function('backend.sourceGets>0 && backend.active===0')
        page.locator('#br-view-analytics').click()
        rows=page.locator('#pj-project-completions-rows tr')
        expect(rows).to_have_count(3)
        expect(page.locator('#pj-segment')).to_have_value('')
        expect(rows.filter(has_text='Архив')).to_contain_text('Последнее письмо по валидным контактам: 26.11.2026')
        expect(rows.filter(has_text='На паузе')).to_contain_text('Отправки приостановлены')
        expect(rows.filter(has_text='Кухни email')).to_contain_text('Ориентировочно 02.12.2026')
        overall=page.locator('#pj-project-completions-last')
        expect(overall).to_be_hidden()
        page.locator('#pj-plan-segment').select_option('segment-a')
        expect(overall).to_have_text('Последняя отправка по прогнозу — 02.12.2026')
        page.locator('#pj-plan-segment').select_option('segment-b')
        expect(rows).to_have_count(2)
        expect(overall).to_be_hidden()
        page.locator('#pj-plan-campaign').select_option('22222222-2222-4222-8222-222222222222')
        expect(rows).to_have_count(1)
        expect(rows).to_contain_text('Архив')
        calls="backend.calls.filter(c=>c.name==='getProjectCampaignCompletions')"
        assert page.evaluate(calls+".map(c=>c.p)")==[{'preview':True}]
        page.locator('#br-project').select_option('neosender')
        expect(rows).to_have_count(0)
        expect(page.locator('#pj-project-completions-health')).to_contain_text('нет связанных рассылок')
        assert page.evaluate(calls+'.length')==2
        page.evaluate("backend.monitoringIds=['account-0','account-1'];backend.monitoringConfigured=true;backend.infraSynced=true")
        page.locator('#br-project').select_option('numshield')
        expect(rows).to_have_count(3)
        page.locator('#pj-plan-pool summary').click()
        page.locator('#pj-plan-senders input[value="account-0"]').uncheck()
        expect(rows).to_have_count(1)
        expect(rows).to_contain_text('На паузе')
        page.locator('#pj-plan-all').check()
        expect(rows).to_have_count(3)
        assert not errors, errors
        browser.close()
        print('PASS: project completion dates, status, segment and campaign filters, scoped warm preview.')


if __name__=='__main__':
    main()
