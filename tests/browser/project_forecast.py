"""Forecast periods, guarded pagination, visibility and project isolation in Chrome."""
import sys
from playwright.sync_api import expect, sync_playwright
from project_client import integrated_html


FORECAST_API = """
testClock.now=Date.parse('2026-11-22T10:00:00Z');
window.forecastCalls=0;
api.getProjectForecastPreview=(payload,project)=>{
  if(project!=='numshield')return null;
  const row={days:1,from:'2026-11-23',to:'2026-11-23',expected:41,initial:1,followups:40,capacity:90};
  return {day:'2026-11-22',generatedAt:'2026-11-22T07:40:00Z',previewScope:'numshield-example',
    forecast:{periods:[row],days:[],selectedAccounts:2,activeCampaigns:1}};
};
api.getProjectSendingForecast=(payload,project)=>{
  forecastCalls++;
  if(window.forecastState==='waiting'){
    return {state:'loading',pending:true,retryAfterMs:0,progress:{campaignsDone:1,campaignsTotal:2,contactsRead:27}};
  }
  if(window.forecastState==='confirming'){
    return {state:'loading',pending:true,retryAfterMs:0,message:'Сверяем назначения почт.',progress:{campaignsDone:2,campaignsTotal:2,contactsRead:84}};
  }
  if(window.forecastState==='limited'){
    return {state:'loading',pending:true,retryAfterMs:120000,progress:{campaignsDone:0,campaignsTotal:2,contactsRead:10}};
  }
  if(window.forecastState==='empty')return {state:'no_selection',pending:false,forecast:null};
  if(window.forecastState==='changed')throw new Error('[COLDY_MONITORING_CHANGED] Изменились выбранные ящики.');
  const partial=window.forecastState==='partial';
  const firstPage=window.forecastState==='first_page';
  const days=Array.from({length:7},(_,i)=>({date:'2026-11-'+(23+i),initial:partial?null:2,followups:partial?null:3,
    expected:partial?null:5,modeled:partial&&i!==2?4:null,capacity:9}));
  const periods=[1,3,7].map(n=>({days:n,from:days[0].date,to:days[n-1].date,initial:partial?null:n*2,followups:partial?null:n*3,
    expected:partial?null:n*5,modeled:partial?n*4:null,capacity:n*9}));
  return {state:firstPage?'loading':partial?'partial':'ready',pending:firstPage,generatedAt:firstPage?null:'2026-11-22T08:00:00Z',
    forecast:{days,periods,startDate:days[0].date,timezone:'Europe/Moscow',selectedAccounts:project==='neosender'?9:2,activeCampaigns:1,
    queue:{pendingInitial:51,pendingFollowups:12,unresolved:partial?2:0,unreadCampaigns:partial?1:0},
    reasons:partial?['unknown_sender']:[]}};
};
"""


def main():
    with sync_playwright() as runtime:
        chrome={'channel':'chrome'} if sys.platform=='win32' else {'executable_path':'/usr/bin/chromium'}
        browser=runtime.chromium.launch(headless=True,args=['--no-sandbox'],**chrome)
        page=browser.new_page()
        errors=[]
        page.on('pageerror',lambda error:errors.append(str(error)))
        page.set_content(integrated_html().replace('api.getColdySettings=',FORECAST_API+'api.getColdySettings=',1))
        page.wait_for_function('backend.sourceGets>0&&backend.active===0')
        page.locator('#br-view-analytics').click()
        view=page.locator('#pj-forecast')
        expect(view).to_be_visible()
        page.evaluate("tick(120000)")
        assert page.evaluate('forecastCalls')==0
        assert not page.locator('#pj-segment').input_value()
        page.evaluate("backend.holdMethods=['getProjectSendingForecast']")
        view.locator('summary').click()
        totals=view.locator('#pj-forecast-totals dd')
        expect(totals).to_have_text(['41','1','40','90'])
        expect(view.locator('#pj-forecast-health')).to_contain_text('последний расчёт')
        page.wait_for_function("backend.pending.some(job=>job.method==='getProjectSendingForecast')")
        page.evaluate("backend.holdMethods=[];releaseRpc('getProjectSendingForecast')")
        expect(totals).to_have_text(['5','2','3','9'])
        expect(view.locator('#pj-forecast-queue')).to_contain_text('первого письма ждут 51, повторного — 12')
        view.get_by_role('button',name='3 дня').click()
        expect(totals).to_have_text(['15','6','9','27'])
        expect(view.locator('#pj-forecast-rows tr')).to_have_count(3)
        view.get_by_role('button',name='Неделя').click()
        expect(totals).to_have_text(['35','14','21','63'])
        expect(view.locator('#pj-forecast-rows tr')).to_have_count(7)
        expect(view.locator('#pj-forecast-context')).to_contain_text('23.11.2026 – 29.11.2026')
        assert page.evaluate('forecastCalls')==1
        page.evaluate("forecastState='partial';tick(61000)")
        expect(totals).to_have_text(['—','—','—','63','28'])
        expect(view.locator('#pj-forecast-scenario-column')).to_be_visible()
        expect(view.locator('#pj-forecast-rows tr td:last-child')).to_have_text(['4','4','—','4','4','4','4'])
        expect(view.locator('#pj-forecast-queue')).to_contain_text('неизвестен отправитель или следующий шаг у 2')
        expect(view.locator('#pj-forecast-reasons')).to_contain_text('ящик отправителя')

        page.evaluate("forecastState='changed'")
        view.get_by_role('button',name='Пересчитать').click()
        expect(view.locator('#pj-forecast-health')).to_contain_text('Изменились выбранные ящики')
        expect(view.locator('#pj-forecast-report')).to_be_hidden()
        page.evaluate("forecastState='first_page'")
        view.get_by_role('button',name='Пересчитать').click()
        expect(view.locator('#pj-forecast-report')).to_be_visible()
        expect(view.locator('#pj-forecast-queue')).to_be_hidden()
        page.evaluate("forecastState='ready'")
        expect(view.locator('#pj-forecast-queue')).to_be_visible()
        page.evaluate("forecastState='waiting'")
        view.get_by_role('button',name='Пересчитать').click()
        expect(view.locator('#pj-forecast-health')).to_contain_text('контактов проверено 27')
        page.evaluate("forecastState='confirming'")
        expect(view.locator('#pj-forecast-health')).to_contain_text('Сверяем назначения почт. Рассылок обработано 2 из 2, контактов проверено 84.')
        page.evaluate("forecastState='ready'")
        expect(totals).to_have_text(['35','14','21','63'])
        page.evaluate("forecastState='waiting'")
        view.get_by_role('button',name='Пересчитать').click()
        expect(view.locator('#pj-forecast-health')).to_contain_text('контактов проверено 27')
        view.locator('summary').click()
        idle_calls=page.evaluate('forecastCalls')
        page.wait_for_timeout(1650)
        assert page.evaluate('forecastCalls')==idle_calls

        page.evaluate("forecastState='limited'")
        view.locator('summary').click()
        expect(view.locator('#pj-forecast-refresh')).to_be_disabled()
        limited_calls=page.evaluate('forecastCalls')
        page.evaluate("tick(60000)")
        assert page.evaluate('forecastCalls')==limited_calls
        page.evaluate("testClock.hidden=true;document.dispatchEvent(new Event('visibilitychange'));tick(120000)")
        assert page.evaluate('forecastCalls')==limited_calls
        page.evaluate("forecastState='ready';testClock.hidden=false;document.dispatchEvent(new Event('visibilitychange'))")
        expect(totals).to_have_text(['35','14','21','63'])

        page.evaluate("backend.holdAfterMethods=['getProjectSendingForecast']")
        view.get_by_role('button',name='Пересчитать').click()
        page.wait_for_function("backend.pending.some(job=>job.method==='getProjectSendingForecast')")
        page.locator('#br-project').select_option('neosender')
        page.evaluate("backend.holdAfterMethods=[];releaseRpc('getProjectSendingForecast')")
        page.wait_for_function("backend.active===0")
        assert not view.evaluate('el=>el.open')
        expect(view.locator('#pj-forecast-report')).to_be_hidden()
        view.locator('summary').click()
        expect(view.locator('#pj-forecast-context')).to_contain_text('выбранных ящиков 9')
        expect(view.locator('#pj-forecast-context')).not_to_contain_text('выбранных ящиков 2')
        expect(view.get_by_role('button',name='Завтра')).to_have_attribute('aria-pressed','true')
        assert not errors, errors
        browser.close()
        print('PASS: project forecast ranges, incomplete values, retries, hidden panels and scope changes.')


if __name__=='__main__':
    main()
