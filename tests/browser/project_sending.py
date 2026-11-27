"""Scoped actuals, daily forecasts, filter persistence and mailbox capacity in the real UI."""
import sys
from playwright.sync_api import expect, sync_playwright
from project_client import integrated_html

API = """
{
testClock.now=Date.parse('2026-11-27T10:00:00Z');
backend.monitoringIds=['account-0','account-1'];backend.monitoringConfigured=true;backend.infraSynced=true;
const projectAccounts=[{id:'account-0',email:'one@example.test'},{id:'account-1',email:'two@example.test'}];
const campaigns=[{id:A,name:'Кухни',segmentId:'s-k',segmentName:'Мебель'},{id:B,name:'Студии',segmentId:'s-w',segmentName:'Партнёры'}];
const day='2026-11-27',next='2026-11-28',clock='2026-11-27T10:00:00Z';
const storedInventory=api.getProjectInfrastructure;
api.getProjectInfrastructure=(p,project)=>{
  const snapshot=storedInventory(p,project);
  for(const a of snapshot.accounts||[])a.todayQuota={date:day,limit:99,limitAt:'2026-11-27T09:40:00Z'};
  return snapshot;
};
window.partial=true;window.oldTime=false;
api.getProjectForecastPreview=()=>null;
api.getProjectSendingHistory=(p,project)=>{
  if(project==='neosender')return {state:'no_accounts',accounts:[],campaigns:[],rows:[],message:'В проекте нет почт.'};
  if(p?.period==='today'){
    if(backend.factState)return {state:backend.factState,from:day,to:day,days:[day],complete:false,
      accounts:projectAccounts,campaigns:[],checkedCells:[],rows:[]};
    const checked=partial?[A]:[A,B];
    return {state:partial?'partial':'ready',from:day,to:day,days:[day],checkedAt:clock,
      complete:!partial,pending:partial,accounts:projectAccounts,campaigns,
      checkedCells:checked.map(c=>({date:day,campaignId:c,checkedAt:oldTime?'2026-11-27T09:40:00Z':clock})),
      rows:[{date:day,campaignId:A,accountId:'account-0',sent:3},...(!partial?[{date:day,campaignId:B,accountId:'account-0',sent:2}]:[])]};
  }
  const current=!!p?.weekOf,start=current?23:16,n=current?4:7;
  const days=Array.from({length:n},(_,i)=>'2026-11-'+(start+i));
  const plans=[{date:days[0],generatedAt:'2026-11-'+(start-1)+'T09:00:00Z',expected:10,initial:7,followups:3,mailboxLimit:80,unused:70,
    campaigns:campaigns.map((c,i)=>({...c,expected:i?4:6,initial:i?3:4})),
    senders:[{id:'account-0',dailyLimit:50,expected:8,unused:42,campaigns:[{id:A,expected:4,initial:2},{id:B,expected:4,initial:3}]},
      {id:'account-1',dailyLimit:30,expected:2,unused:28,campaigns:[{id:A,expected:2,initial:2}]}]}];
  return {state:'ready',from:days[0],to:days.at(-1),days,checkedAt:clock,complete:true,accounts:projectAccounts,campaigns,plans,
    checkedCells:days.flatMap(date=>campaigns.map(c=>({date,campaignId:c.id,checkedAt:clock}))),
    rows:[{date:days[0],campaignId:A,accountId:'account-0',sent:3},{date:days[2],campaignId:B,accountId:'account-1',sent:2}]};
};
api.getProjectSendingForecast=(_,project)=>{
  if(project==='neosender')return {state:'no_selection'};
  const row=(date,expected,initial,remainingLimit)=>({date,expected,initial,followups:expected-initial,mailboxLimit:80,remainingLimit,unused:remainingLimit-expected});
  const result={day,state:'ready',generatedAt:clock,forecast:{today:row(day,15,10,75),days:[row(next,25,19,80)],
    campaigns:campaigns.map((c,i)=>({...c,expectedByDay:i?[5,5]:[10,20],initialByDay:i?[3,4]:[7,15]})),
    senders:[{...projectAccounts[0],dailyLimit:50,days:[{date:day,expected:13,unused:32},{date:next,expected:21,unused:29}],
      campaigns:[{id:A,expectedByDay:[8,16],initialByDay:[5,12]},{id:B,expectedByDay:[5,5],initialByDay:[3,4]}]},
      {...projectAccounts[1],dailyLimit:30,days:[{date:day,expected:2,unused:28},{date:next,expected:4,unused:26}],
      campaigns:[{id:A,expectedByDay:[2,4],initialByDay:[2,3]}]}]}};
  if(backend.legacySenders)delete result.forecast.senders;
  return result;
};
}
"""

def main():
    with sync_playwright() as pw:
        chrome={'channel':'chrome'} if sys.platform=='win32' else {'executable_path':'/usr/bin/chromium'}
        browser=pw.chromium.launch(headless=True,args=['--no-sandbox'],**chrome)
        page=browser.new_page()
        errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.set_content(integrated_html().replace('api.getColdySettings=',API+'api.getColdySettings=',1))
        page.wait_for_function('backend.sourceGets>0&&backend.active===0')
        page.locator('#br-view-analytics').click()
        rows=page.locator('#pj-plan-days tr')
        cells=rows.first.locator('td')
        period=page.locator('#pj-plan-period')
        details=page.locator('#pj-plan-detail > summary')
        pool=page.locator('#pj-plan-pool')
        campaign=page.locator('#pj-plan-campaign')
        expect(cells).to_have_text(['80','от 3','10','5','15','—','60'])
        details.click()
        senders=page.locator('#pj-plan-accounts tr')
        expect(senders.filter(has_text='one@example.test').locator('td')).to_have_text(['Итого','от 3','13','—'])
        page.evaluate('partial=false')
        expect(cells).to_have_text(['80','5','10','5','15','20','60'])
        before=page.evaluate("backend.calls.filter(c=>['getProjectSendingForecast','getProjectSendingHistory'].includes(c.name)).length")
        page.locator('#pj-plan-segment').select_option('s-k')
        expect(cells).to_have_text(['80','3','7','3','10','13','60'])
        expect(campaign.locator('option')).not_to_have_text(['Все рассылки','Студии'])
        campaign.select_option(label='Кухни')
        pool.locator('summary').focus();pool.locator('summary').press('Enter')
        pool.get_by_label('two@example.test').uncheck()
        expect(cells).to_have_text(['50','3','5','3','8','11','32'])
        assert before==page.evaluate("backend.calls.filter(c=>['getProjectSendingForecast','getProjectSendingHistory'].includes(c.name)).length")
        period.select_option('tomorrow')
        expect(cells).to_have_text(['50','—','12','4','16','16','29'])
        pool.get_by_label('Все почты',exact=True).check()
        page.locator('#pj-plan-segment').select_option('')
        period.select_option('history')
        expect(rows).to_have_count(7)
        expect(cells).to_have_text(['80','3','7','3','10','70'])
        expect(rows.nth(1).locator('td')).to_have_text(['—','0','—','—','—','—'])
        campaign.select_option(label='Кухни')
        pool.get_by_label('two@example.test').uncheck()
        expect(cells).to_have_text(['50','3','2','2','4','42'])
        campaign.select_option('')
        pool.get_by_label('Все почты',exact=True).check()
        page.locator('#pj-plan-group').select_option('week')
        expect(rows).to_have_count(1)
        expect(cells).to_have_text(['—','5','—','—','—','—'])
        page.locator('#pj-history-date').fill('2026-11-25')
        expect(rows.first.locator('th')).to_have_text('23.11.2026 – 26.11.2026')
        page.locator('#pj-plan-group').select_option('day')
        expect(rows).to_have_count(4)
        expect(cells).to_have_text(['80','3','7','3','10','70'])
        page.locator('#pj-plan-day').select_option('2026-11-25')
        expect(senders.filter(has_text='two@example.test').locator('td')).to_have_text(['Итого','2','—'])
        period.select_option('today')
        page.evaluate('oldTime=true')
        page.locator('#pj-plan-refresh').click()
        expect(cells).to_have_text(['80','5','10','5','15','—','60'])
        expect(page.locator('#pj-plan-health')).to_contain_text('разное время')
        page.evaluate('backend.legacySenders=true')
        page.locator('#pj-plan-refresh').click()
        expect(cells.nth(4)).to_have_text('—')
        expect(cells.nth(0)).to_have_text('—')
        expect(cells.nth(1)).to_have_text('5')
        for state in ('not_configured','no_accounts','partial'):
            page.evaluate('(state)=>{backend.factState=state}',state)
            page.locator('#pj-plan-refresh').click()
            page.wait_for_function('backend.active===0')
            expect(cells.nth(1)).to_have_text('—')
        page.locator('#br-project').select_option('neosender')
        expect(page.locator('#pj-plan-accounts')).not_to_contain_text('one@example.test')
        expect(page.locator('#pj-plan-senders')).not_to_contain_text('two@example.test')
        assert not errors,errors
        browser.close()
        print('PASS: scoped sending actuals, shared quotas, projected allocations, date/week selection and isolation.')

if __name__=='__main__':
    main()
