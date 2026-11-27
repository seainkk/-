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
        assert not errors, errors
        browser.close()
        print('PASS: date/campaign/account history, unknowns, shared capacity, scope reset.')


if __name__=='__main__':
    main()
