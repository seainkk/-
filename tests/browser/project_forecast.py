"""Archive handoff, scope changes, weekly totals and incomplete entries of the project forecast."""
import sys
from playwright.sync_api import expect, sync_playwright
from project_client import integrated_html


API = """
testClock.now=Date.parse('2026-11-22T10:00:00Z');
backend.monitoringIds=['account-0'];backend.monitoringConfigured=true;backend.infraSynced=true;
window.forecastState='partial';window.forecastCalls=0;
const today='2026-11-22',tomorrow='2026-11-23';
api.getProjectSendingHistory=()=>({state:'no_campaigns',accounts:[],campaigns:[],rows:[],days:[]});
api.getProjectForecastPreview=(_,project)=>project!=='numshield'?null:({
  day:today,generatedAt:'2026-11-21T07:40:00Z',previewScope:'checked-scope',
  forecast:{days:[{date:tomorrow,expected:41,initial:1,followups:40,mailboxLimit:50,unused:9}],campaigns:[]}
});
api.getProjectSendingForecast=(_,project)=>{
  forecastCalls++;
  if(project!=='numshield')return {state:'no_selection',day:today};
  if(forecastState==='changed')throw Error('[COLDY_MONITORING_CHANGED] Изменился состав ящиков');
  const finished=forecastState==='ready',uncertain=forecastState==='uncertain';
  const day=(date,n)=>({date,initial:uncertain?null:n-1,followups:uncertain?null:1,expected:uncertain?null:n,mailboxLimit:50,unused:uncertain?null:50-n});
  const days=Array.from({length:7},(_,i)=>day('2026-11-'+(23+i),5));
  const row=day(today,3);
  const report={today:row,days,selectedAccounts:1,activeCampaigns:1,campaigns:[{id:A,name:'Архивная кухня',segmentId:'seg',segmentName:'Кухни'}],
    reasons:uncertain?['unknown_sender']:[],senders:[{id:'account-0',email:'box@example.test',dailyLimit:50,
    days:[row,...days],campaigns:[{id:A,expectedByDay:[3,5,5,5,5,5,5,5],initialByDay:[2,4,4,4,4,4,4,4]}]}]};
  return {day:today,state:finished?'ready':'partial',forecast:report,previewScope:'checked-scope',
    generatedAt:finished||uncertain?'2026-11-22T09:00:00Z':null,pending:!finished&&!uncertain,retryAfterMs:finished||uncertain?0:120000};
};
"""

def main():
    with sync_playwright() as pw:
        launch={'channel':'chrome'} if sys.platform=='win32' else {'executable_path':'/usr/bin/chromium'}
        browser=pw.chromium.launch(headless=True,args=['--no-sandbox'],**launch)
        page=browser.new_page()
        errors=[]
        page.on('pageerror',lambda e: errors.append(str(e)))
        page.set_content(integrated_html().replace('api.getColdySettings=',API+'api.getColdySettings=',1))
        page.wait_for_function('backend.sourceGets>0&&backend.active===0')
        page.evaluate("backend.holdMethods=['getProjectSendingForecast']")
        page.locator('#br-view-analytics').click()
        period=page.locator('#pj-plan-period')
        rows=page.locator('#pj-plan-days tr')
        expected=rows.first.locator('td').nth(4)
        period.select_option('tomorrow')
        expect(expected).to_have_text('41')
        expect(page.locator('#pj-plan-health')).to_contain_text('сохранённый прогноз')
        page.wait_for_function("backend.pending.some(job=>job.method==='getProjectSendingForecast')")
        page.evaluate("backend.holdMethods=[];releaseRpc('getProjectSendingForecast')")
        period.select_option('today')
        expect(expected).to_have_text('3')
        period.select_option('tomorrow')
        expect(expected).to_have_text('41')
        page.evaluate("forecastState='ready';tick(120001)")
        expect(expected).to_have_text('5')
        period.select_option('7')
        expect(rows).to_have_count(7)
        page.locator('#pj-plan-group').select_option('week')
        expect(rows).to_have_count(1)
        expect(rows.first.locator('td')).to_have_text(['350','—','28','7','35','35','315'])
        page.evaluate("forecastState='uncertain'")
        page.locator('#pj-plan-refresh').click()
        expect(expected).to_have_text('—')
        expect(page.locator('#pj-plan-health')).to_contain_text('ящик отправителя')
        page.evaluate("forecastState='changed'")
        page.locator('#pj-plan-refresh').click()
        expect(page.locator('#pj-plan-health')).to_contain_text('Изменился состав')
        expect(expected).to_have_text('—')
        page.evaluate("forecastState='ready';backend.holdAfterMethods=['getProjectSendingForecast']")
        page.locator('#pj-plan-refresh').click()
        page.wait_for_function("backend.pending.some(job=>job.method==='getProjectSendingForecast')")
        page.locator('#br-project').select_option('neosender')
        page.evaluate("backend.holdAfterMethods=[];releaseRpc('getProjectSendingForecast')")
        page.wait_for_function('backend.active===0')
        expect(period).to_have_value('today')
        expect(page.locator('#pj-plan-group')).to_have_value('day')
        expect(page.locator('#pj-plan-campaign')).not_to_contain_text('Архивная кухня')
        assert not errors,errors
        browser.close()
        print('PASS: archived and live forecasts, complete and incomplete weeks, scope invalidation.')

if __name__=='__main__':
    main()
