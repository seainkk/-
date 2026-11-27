"""Project-wide send history and capacity in the actual frontend with local, synthetic facts."""
import sys
from playwright.sync_api import expect, sync_playwright
from project_client import integrated_html


API = """
testClock.now=Date.parse('2026-11-27T10:00:00Z');
window.sentReads=0;
api.getProjectSendingHistory=(_,project)=>{
  sentReads++;
  const days=Array.from({length:7},(_,i)=>'2026-11-'+(16+i));
  if(project==='neosender')return {days,accounts:[],campaigns:[],rows:[],message:'В проекте нет почт.'};
  return {state:'ready',from:days[0],to:days[6],days,complete:sentReads>1,
    accounts:[{id:11,email:'one@example.test'},{id:22,email:'two@example.test'}],
    campaigns:[{id:'a',name:'Кампания А'},{id:'b',name:'Кампания Б'}],checkedCells:[{campaignId:'a',date:days[0]}],
    rows:[{accountId:11,campaignId:'a',date:days[0],sent:3},{accountId:22,campaignId:'b',date:days[0],sent:2},
          {accountId:11,campaignId:'b',date:days[1],sent:4}]};
};
api.getProjectForecastPreview=()=>null;
api.getProjectSendingForecast=()=>{
  const from='2026-11-28',daily={date:from,initial:500,followups:0,expected:500,capacity:1000,mailboxLimit:1000,remainingLimit:1000,unused:500};
  return {state:'ready',day:'2026-11-27',generatedAt:'2026-11-27T09:00:00Z',forecast:{periods:[{...daily,from,to:from,days:1}],
   days:[daily],selectedAccounts:20,activeCampaigns:1,campaigns:[{id:'a',name:'Кампания А',expectedByDay:[0,500]}],
   senders:Array.from({length:20},(_,i)=>({id:String(i),email:'box'+i+'@example.test',dailyLimit:50,
     days:[{date:from,remainingLimit:50,expected:25,unused:25}],campaigns:[{id:'a',expectedByDay:[0,25]}]}))}};
};
"""


PLAN_API = """
testClock.now=Date.parse('2026-11-27T10:00:00Z');
backend.monitoringIds=['account-0','account-1'];backend.monitoringConfigured=true;backend.infraSynced=true;
const inventoryRead=api.getProjectInfrastructure, today='2026-11-27', tomorrow='2026-11-28';
api.getProjectInfrastructure=(p,project)=>{
  const data=inventoryRead(p,project);
  return project==='neosender'?{...data,state:'no_selection',accounts:[],monitoring:{...data.monitoring,accountIds:[],selectedCount:0},nextCursor:null}:data;
};
window.partiallyChecked=true;window.campaignObservation='2026-11-27T09:59:00Z';
api.getProjectSendingHistory=(p,project)=>{
  if(p?.period!=='today'||project!=='numshield')throw Error('Unexpected evidence scope');
  if(backend.noBindings)return {period:'today',state:'no_campaigns',days:[today],from:today,to:today,complete:false,
    accounts:backend.monitoringIds.map(id=>({id})),campaigns:[],checkedCells:[],rows:[]};
  const checked=partiallyChecked?[A]:[A,B];
  return {period:'today',state:partiallyChecked?'partial':'ready',days:[today],from:today,to:today,checkedAt:'2026-11-27T09:59:00Z',
    complete:!partiallyChecked,pending:partiallyChecked,retryAfterMs:0,accounts:backend.monitoringIds.map(id=>({id})),
    campaigns:[{id:A,name:'Кухни'},{id:B,name:'Студии'}],checkedCells:checked.map(campaignId=>({campaignId,date:today,
      checkedAt:campaignId===B?campaignObservation:'2026-11-27T09:59:00Z'})),
    rows:[{accountId:'account-0',campaignId:A,date:today,sent:3},
      ...(partiallyChecked?[]:[{accountId:'account-0',campaignId:B,date:today,sent:2}])]};
};
api.getProjectSendingForecast=(p,project)=>{
  if(project!=='numshield')throw Error('Unexpected plan scope');
  const day=(date,expected,initial,followups,remainingLimit)=>({date,capacity:remainingLimit,mailboxLimit:80,expected,initial,followups,remainingLimit,unused:remainingLimit-expected});
  const daily=day(today,15,10,5,75),next=day(tomorrow,25,19,6,80);
  const result={day:today,state:'ready',generatedAt:'2026-11-27T10:00:00Z',forecast:{
    today:daily,days:[next],periods:[{...next,days:1,from:tomorrow,to:tomorrow}],selectedAccounts:2,activeCampaigns:2,
    campaigns:[{id:A,name:'Кухни',expectedByDay:[10,20]},{id:B,name:'Студии',expectedByDay:[5,5]}],
    senders:[{id:'account-0',days:[{date:today,expected:13},{date:tomorrow,expected:21}],
      campaigns:[{id:A,expectedByDay:[8,16]},{id:B,expectedByDay:[5,5]}]},
      {id:'account-1',days:[{date:today,expected:2},{date:tomorrow,expected:4}],campaigns:[{id:A,expectedByDay:[2,4]}]}]}};
  if(backend.legacySenders)delete result.forecast.senders;
  return result;
};
"""


def check_infrastructure_plan(browser, errors):
    page=browser.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.set_content(integrated_html().replace('api.getColdySettings=',PLAN_API+'api.getColdySettings=',1))
    page.wait_for_function('backend.sourceGets>0 && backend.active===0')
    page.locator('#br-view-infrastructure').click()
    days=page.locator('#pj-plan-days tr')
    today, tomorrow=days.nth(0),days.nth(1)
    expect(days).to_have_count(8)
    expect(today.locator('td')).to_have_text(['80','от 3','10','5','—','60'])
    expect(tomorrow.locator('td')).to_have_text(['80','—','19','6','25','55'])
    expect(today.locator('th')).to_contain_text('Сегодня')
    expect(tomorrow.locator('th')).to_contain_text('Завтра')
    page.locator('#pj-plan-detail summary').click()
    detail=page.locator('#pj-plan-accounts tr')
    campaign=detail.filter(has_text='Все почты').filter(has_text='Студии')
    sender=detail.filter(has_text='sender0@example.test')
    expect(campaign.locator('td')).to_have_text(['Студии','—','5','—'])
    expect(sender.locator('td')).to_have_text(['Все рассылки','от 3','13','—'])
    # The app picks up the second campaign on its own continuation.
    page.evaluate('partiallyChecked=false')
    expect(today.locator('td')).to_have_text(['80','5','10','5','20','60'])
    expect(campaign.locator('td')).to_have_text(['Студии','2','5','7'])
    expect(sender.locator('td')).to_have_text(['Все рассылки','5','13','18'])
    children=sender.locator('xpath=following-sibling::tr')
    expect(children.nth(0).locator('td')).to_have_text(['Кухни','3','8','11'])
    expect(children.nth(1).locator('td')).to_have_text(['Студии','2','5','7'])
    page.locator('#pj-plan-day').select_option('2026-11-28')
    expect(sender.locator('td')).to_have_text(['Все рассылки','—','21','21'])
    expect(children.nth(0).locator('td')).to_have_text(['Кухни','—','16','16'])
    expect(campaign.locator('td')).to_have_text(['Студии','—','5','5'])
    # One older campaign observation prevents adding sends to a queue from a later snapshot.
    page.evaluate("campaignObservation='2026-11-27T09:52:00Z'")
    page.locator('#pj-infrastructure-refresh').click()
    expect(today.locator('td')).to_have_text(['80','5','10','5','—','60'])
    expect(page.locator('#pj-plan-health')).to_contain_text('разное время')
    expect(tomorrow.locator('td')).to_have_text(['80','—','19','6','25','55'])
    page.locator('#pj-plan-day').select_option('2026-11-27')
    expect(sender.locator('td')).to_have_text(['Все рассылки','5','13','—'])
    # Same-sized legacy pool, no sender identities: keep the fact, suppress the unverified plan.
    page.evaluate("backend.legacySenders=true;campaignObservation='2026-11-27T09:59:00Z'")
    page.locator('#pj-infrastructure-refresh').click()
    expect(sender.locator('td')).to_have_text(['Все рассылки','5','—','—'])
    expect(tomorrow.locator('td').nth(4)).to_have_text('—')
    # A teammate removed all bindings while an older forecast still contains both campaigns.
    page.evaluate('backend.legacySenders=false;backend.noBindings=true')
    page.locator('#pj-infrastructure-refresh').click()
    expect(sender.locator('td')).to_have_text(['Все рассылки','0','—','—'])
    expect(today.locator('td').nth(1)).to_have_text('0')
    expect(today.locator('td').nth(4)).to_have_text('—')
    expect(detail.filter(has_text='Все почты')).to_have_count(0)
    page.wait_for_function('backend.active===0')
    history_reads="backend.calls.filter(c=>c.name==='getProjectSendingHistory').length"
    seen=page.evaluate(history_reads)
    page.evaluate("testClock.hidden=true;document.dispatchEvent(new Event('visibilitychange'));tick(120000)")
    assert page.evaluate(history_reads)==seen
    page.evaluate("backend.holdAfterMethods=['getProjectSendingHistory'];testClock.hidden=false;document.dispatchEvent(new Event('visibilitychange'))")
    page.wait_for_function("backend.pending.some(x=>x.method==='getProjectSendingHistory')")
    page.locator('#br-project').select_option('neosender')
    page.evaluate("backend.holdAfterMethods=[];releaseRpc('getProjectSendingHistory')")
    page.wait_for_function("backend.active===0")
    expect(days).to_have_count(0)
    expect(detail).to_have_count(0)
    expect(page.locator('#pj-plan-detail')).to_be_hidden()
    page.close()


def main():
    with sync_playwright() as runtime:
        options = {'channel':'chrome'} if sys.platform=='win32' else {'executable_path':'/usr/bin/chromium'}
        browser = runtime.chromium.launch(headless=True, **options)
        page = browser.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.set_content(integrated_html().replace('api.getColdySettings=', API+'api.getColdySettings=', 1))
        page.wait_for_function('backend.sourceGets>0 && backend.active===0')
        page.locator('#br-view-analytics').click()
        assert page.evaluate('sentReads') == 0
        history = page.locator('#pj-history')
        page.evaluate("backend.holdMethods=['getProjectSendingHistory']")
        history.locator('summary').click()
        page.wait_for_function("backend.pending.some(item=>item.method==='getProjectSendingHistory')")
        history.locator('summary').click()
        history.locator('summary').click()
        page.evaluate("backend.holdMethods=[];releaseRpc('getProjectSendingHistory')")
        rows = history.locator('tbody tr')
        expect(rows).to_have_count(7)
        assert page.evaluate('sentReads') == 1
        expect(rows.first.locator('td').nth(1)).to_have_text('от 5')
        expect(rows.first.locator('td').nth(3)).to_have_text('—')
        expect(rows.nth(2)).to_contain_text('Кампания А')
        history.get_by_role('button',name='Обновить отчёт').click()
        expect(rows.first.locator('td').last).to_have_text('9')
        expect(rows.first.locator('td').nth(3)).to_have_text('0')
        expect(history.locator('#pj-history-period')).to_contain_text('16.11.2026 – 22.11.2026')
        forecast = page.locator('#pj-forecast')
        forecast.locator(':scope > summary').click()
        expect(forecast.locator('#pj-forecast-totals')).to_contain_text('Ожидается писем500')
        expect(forecast.locator('#pj-forecast-totals')).to_contain_text('Свободно по прогнозу500')
        forecast.locator('#pj-forecast-senders summary').click()
        detail = forecast.locator('#pj-forecast-sender-table tbody tr')
        expect(detail).to_have_count(40)
        expect(detail.first).to_contain_text('Доступно 50 · свободно 25')
        expect(detail.nth(1)).to_contain_text('Кампания А')
        assert not page.locator('#pj-segment').input_value()
        page.locator('#br-project').select_option('neosender')
        page.wait_for_function('backend.active===0')
        expect(rows).to_have_count(0)
        expect(detail).to_have_count(0)
        history.locator('summary').click()
        expect(history.locator('#pj-history-health')).to_contain_text('нет почт')
        check_infrastructure_plan(browser,errors)
        assert not errors, errors
        browser.close()
        print('PASS: history, daily capacity, observed and remaining sends by campaign and sender, scope reset.')


if __name__=='__main__':
    main()
